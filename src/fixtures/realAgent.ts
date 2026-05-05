// src/fixtures/realAgent.ts
//
// Production AgentInvoker — drives the real spec → tasks → execute
// pipeline. Used by the fixture harness's vscode-test driver to
// produce baseline scorecards.
//
// Pipeline (mirrors what SidebarProvider does for an interactive user):
//
//   1. generateRequirements(requirement)  → write requirements.md
//   2. generateDesign(requirements)       → write design.md
//   3. generateTasks(req, design)         → write tasks.md, get task list
//   4. For each task in plan:
//        runTask({...})                   → returns CodeDiff[]
//        applyDiffs(diffs, workspace)     → writes files to disk
//   5. Report complete + agent timing + intervention count
//
// What this does NOT do (deliberately):
//   - No VS Code editor side effects (no opening documents, no provenance
//     headers). The harness writes files directly via fs. Fixtures
//     measure functional correctness, not editor UX.
//   - No webview message posting. Logs go to stdout via the IEnvironment.
//   - No verifier self-heal beyond what runTask already does internally.
//     v1's P1.1 will add single-shot self-heal as part of CoderAgent;
//     this invoker just calls runTask and accepts whatever comes back.
//   - No autopilot-vs-interactive distinction yet. The agent doesn't
//     have an autopilot mode in the sense the fixture format describes;
//     today the only "intervention" point is bash command confirmation,
//     and the harness short-circuits that via bashAutoApprove. Real
//     interactive vs autopilot differentiation lands in v1's P1.3.

import * as fs from 'fs/promises';
import * as path from 'path';
import {
    generateRequirements,
    generateDesign,
    generateTasks,
    type ProjectTask
} from '../llmService';
import { runTask, type CodeDiff } from '../agents/Coordinator';
import { CIEnvironment } from '../adapters/CIEnvironment';
import type { AgentInvoker, AgentInvocation, AgentInvocationResult } from './runner';

/**
 * Build an AgentInvoker that drives the real Coordinator pipeline.
 *
 * Today both interactive and autopilot modes go through the same
 * code path — the only diff is that the harness counts what would
 * have been interventions. v1's P1.3 (autonomy decisions) will add a
 * real autopilot mode that's qualitatively different.
 */
export function buildRealAgentInvoker(): AgentInvoker {
    return async (call: AgentInvocation): Promise<AgentInvocationResult> => {
        const started = Date.now();
        // P1.1: replace the old "Verifier rejected" log-line-counting
        // hack with structured event tracking via verifierFailureCallback.
        // We track two numbers:
        //   - selfHealCount:    failures that the agent recovered from
        //                       on retry (good — agent did the right thing)
        //   - finalFailureCount: failures that exhausted retries (bad —
        //                       this is what would have surfaced to a real
        //                       user and would have counted as an intervention)
        // The interventions metric in the result == finalFailureCount, NOT
        // selfHealCount, because self-heal is exactly the point: the agent
        // recovers without bothering the user.
        let selfHealCount = 0;
        let finalFailureCount = 0;
        const env = new CIEnvironment();

        // Hard wall-clock cap — agent must finish within budget.
        const abortController = new AbortController();
        const budgetTimer = setTimeout(
            () => abortController.abort(),
            call.budgetSeconds * 1000
        );

        try {
            // ── Step 1: requirements ─────────────────────────────
            const requirementPlan = await generateRequirements(
                call.requirement,
                '',  // no extra context; fixture is one-shot
                abortController.signal
            );
            const requirementsMd = formatRequirements(requirementPlan);
            await writeSpecFile(call.workspaceDir, 'requirements.md', requirementsMd);

            // ── Step 2: design ───────────────────────────────────
            const designMd = await generateDesign(requirementsMd, abortController.signal);
            await writeSpecFile(call.workspaceDir, 'design.md', designMd);

            // ── Step 3: tasks ────────────────────────────────────
            // P1.2: fixture runs are greenfield — no .nexus/steering/
            // files in the fresh tempdir — so we pass empty steering.
            // When fixtures eventually carry per-fixture steering files
            // (a v2 design extension), build the block via
            // SteeringManager scoped to call.workspaceDir and pass it
            // here.
            const plan = await generateTasks(
                requirementsMd,
                designMd,
                '',  // existingStructure: empty — greenfield project
                abortController.signal
                // steeringBlock omitted — defaults to '' (no steering)
            );
            const tasks = normalizeTasks(plan.implementationTasks);
            await writeSpecFile(
                call.workspaceDir,
                'tasks.md',
                renderTasksMd(tasks)
            );

            if (tasks.length === 0) {
                // No tasks generated. This counts as agent did NOT
                // complete — the planner failed before any code was
                // produced. Score the fixture against an empty workspace.
                return {
                    reportedComplete: false,
                    agentSeconds: (Date.now() - started) / 1000,
                    interventions: finalFailureCount
                };
            }

            // ── Step 4: execute each task ────────────────────────
            for (const task of tasks) {
                if (abortController.signal.aborted) {
                    // Budget exhausted partway through. Score against
                    // whatever's on disk; report incomplete.
                    return {
                        reportedComplete: false,
                        agentSeconds: (Date.now() - started) / 1000,
                        interventions: finalFailureCount
                    };
                }

                const taskDescription = describeTask(task);
                let diffs: CodeDiff[] | null;
                try {
                    diffs = await runTask({
                        env,
                        task: taskDescription,
                        workspaceRoot: call.workspaceDir,
                        activeRequirements: requirementsMd,
                        activeDesign: designMd,
                        previousFailures: '',
                        globalRules: '',
                        log: () => { /* swallow Coordinator status logs */ },
                        // P1.1: structured verifier-failure event stream.
                        // Replaces the old hack of counting "Verifier
                        // rejected" log lines, which was both fragile
                        // (string match) and ambiguous (couldn't tell
                        // self-heal from final failure).
                        verifierFailureCallback: (event) => {
                            if (event.selfHealed) {
                                selfHealCount++;
                            } else {
                                finalFailureCount++;
                            }
                        },
                        abortSignal: abortController.signal
                    });
                } catch (e) {
                    // Task threw — count as incomplete and stop. We
                    // don't try to recover; that's v2's verifier
                    // self-heal job.
                    void e;  // logged by env.log already
                    return {
                        reportedComplete: false,
                        agentSeconds: (Date.now() - started) / 1000,
                        interventions: finalFailureCount
                    };
                }

                if (!diffs || diffs.length === 0) {
                    // Task completed but no diffs. May be a no-op task
                    // (e.g. "verify X works"); continue to next task.
                    continue;
                }

                // Apply diffs to disk.
                for (const diff of diffs) {
                    await applyDiff(call.workspaceDir, diff);
                }
            }

            return {
                reportedComplete: true,
                agentSeconds: (Date.now() - started) / 1000,
                interventions: finalFailureCount
            };
        } finally {
            clearTimeout(budgetTimer);
        }
    };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert a RequirementPlan to user-facing markdown. The fixture
 *  spec format and the production format aren't 100% aligned — the
 *  production format includes EARS notation that we don't strictly
 *  need here. Use the raw user-facing prose plus the EARS list. */
interface RequirementPlanShape {
    summary?: string;
    requirements?: Array<{ statement?: string; rationale?: string } | string>;
    [k: string]: unknown;
}
function formatRequirements(plan: unknown): string {
    const p = plan as RequirementPlanShape;
    const lines: string[] = ['# Requirements', ''];
    if (typeof p.summary === 'string' && p.summary.trim()) {
        lines.push(p.summary, '');
    }
    if (Array.isArray(p.requirements)) {
        lines.push('## Acceptance criteria', '');
        for (const r of p.requirements) {
            if (typeof r === 'string') {
                lines.push(`- ${r}`);
            } else if (r && typeof r === 'object' && typeof r.statement === 'string') {
                lines.push(`- ${r.statement}`);
            }
        }
    }
    return lines.join('\n');
}

/** The plan's implementationTasks can be strings or ProjectTask objects.
 *  Normalize to ProjectTask shape so the executor has a uniform input. */
function normalizeTasks(raw: (string | ProjectTask)[]): ProjectTask[] {
    return raw.map((entry, i) => {
        if (typeof entry === 'string') {
            return {
                step: entry,
                file: '',
                detailedInstructions: entry,
                relatedRequirement: '',
                dependencies: [],
                verificationRules: [],
                testStrategy: ''
            };
        }
        // Ensure required fields are at least empty-string-defaulted so
        // describeTask doesn't blow up on partial objects.
        return {
            step: entry.step || `Task ${i + 1}`,
            file: entry.file || '',
            detailedInstructions: entry.detailedInstructions || entry.step || '',
            relatedRequirement: entry.relatedRequirement || '',
            dependencies: entry.dependencies || [],
            verificationRules: entry.verificationRules || [],
            testStrategy: entry.testStrategy || ''
        };
    });
}

function describeTask(task: ProjectTask): string {
    // The agent's runTask wants a single task description string. Build
    // it from the structured task fields. Mirrors what SidebarProvider
    // does when building taskPrompt for a row clicked in the UI.
    const parts: string[] = [task.step];
    if (task.file) {
        parts.push(`File: ${task.file}`);
    }
    if (task.detailedInstructions && task.detailedInstructions !== task.step) {
        parts.push(`Details: ${task.detailedInstructions}`);
    }
    if (task.verificationRules && task.verificationRules.length > 0) {
        parts.push(`Verification: ${task.verificationRules.join('; ')}`);
    }
    return parts.join('\n');
}

function renderTasksMd(tasks: ProjectTask[]): string {
    const lines: string[] = ['# Tasks', ''];
    for (const t of tasks) {
        lines.push(`- [ ] ${t.step}`);
        if (t.file) {
            lines.push(`  - File: \`${t.file}\``);
        }
    }
    return lines.join('\n');
}

async function writeSpecFile(workspaceDir: string, name: string, content: string): Promise<void> {
    const specsDir = path.join(workspaceDir, '.nexus', 'specs', 'main');
    await fs.mkdir(specsDir, { recursive: true });
    await fs.writeFile(path.join(specsDir, name), content, 'utf8');
}

async function applyDiff(workspaceDir: string, diff: CodeDiff): Promise<void> {
    const targetPath = path.join(workspaceDir, diff.filepath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (diff.finalContent !== undefined) {
        // Coder used the tool-call path; finalContent is authoritative.
        await fs.writeFile(targetPath, diff.finalContent, 'utf8');
        return;
    }

    // Legacy SEARCH/REPLACE path — read existing, apply, write back.
    let existing = '';
    try {
        existing = await fs.readFile(targetPath, 'utf8');
    } catch {
        // File doesn't exist yet — start empty.
    }
    const updated = applySearchReplaceLite(
        existing,
        diff.searchBlock,
        diff.replaceBlock,
        diff.fullOutputBuffer
    );
    await fs.writeFile(targetPath, updated, 'utf8');
}

/** Minimal search/replace logic — the production version in
 *  SidebarProvider's applySearchReplace handles edge cases like
 *  whitespace normalization and "no match" recovery. The harness
 *  uses a simpler version that's good enough for fixture evaluation:
 *  if the search block is empty (greenfield file), use the replace
 *  block as the full content; otherwise do a literal find-replace. */
function applySearchReplaceLite(
    existing: string,
    search: string,
    replace: string,
    fullOutput: string
): string {
    if (!search.trim()) {
        // Greenfield write — replace block IS the full content.
        return replace || fullOutput || '';
    }
    if (existing.includes(search)) {
        return existing.replace(search, replace);
    }
    // Search block didn't match. Fall back to fullOutputBuffer if
    // the agent provided one; otherwise leave existing unchanged.
    return fullOutput || existing;
}