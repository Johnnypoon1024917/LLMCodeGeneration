// src/fixtures/runner.ts
//
// Runs fixtures end-to-end: setup workspace → invoke agent → score result.
//
// The Agent interface is injected: production runs pass a real agent
// invoker that drives the Coordinator, while harness self-tests pass a
// stub that produces deterministic outputs. This separation means we
// can validate the harness logic itself (does scoring work? does the
// scorecard JSON look right?) without an LLM in the loop.
//
// Invocation paths:
//
//   1. From vscode-test (production baseline): the .vscode-test fixture
//      runner imports this module, builds a real agent invoker that
//      calls Coordinator.runTask, runs all fixtures, writes the scorecard.
//
//   2. From a unit test (harness validation): tests build a stub agent
//      and call runFixtures directly with a synthetic fixture set.
//
//   3. From a future CLI subcommand `nexuscode fixtures run`: when the
//      CLI runtime path is unblocked (post-v1), the same runner can be
//      driven from the command line. Currently blocked on the vscode
//      runtime shim. Tracked as future work, not v1 blocker.
//
// The runner does NOT mutate the source repo's working tree. Each
// fixture gets a fresh tempdir; failures don't leak.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Fixture } from './loader';
import type { FixtureResult } from './scorer';
import { scoreFixture } from './scorer';
import { buildScorecard, renderScorecardMarkdown, type Scorecard } from './reporter';

export interface AgentInvocation {
    /** The temporary workspace where the agent should write files. */
    workspaceDir: string;
    /** The one-line user prompt. */
    requirement: string;
    /** Whether to enable autopilot — agent skips bash confirmation
     *  prompts. Other intervention points (genuine ambiguity) still
     *  surface as interventions. */
    autopilot: boolean;
    /** Hard wall-clock cap. The agent should abort if exceeded. */
    budgetSeconds: number;
}

export interface AgentInvocationResult {
    /** Whether the agent reported its work as complete. False = timeout
     *  or hard error. */
    reportedComplete: boolean;
    /** Wall-clock seconds spent inside the agent. */
    agentSeconds: number;
    /** Number of times the agent surfaced a question to the user during
     *  generation. The harness auto-resolves with a default — usually
     *  "approve" for benign decisions, "reject" for anything dangerous.
     *  Each prompt counts as one intervention regardless of resolution. */
    interventions: number;
}

/** The Agent interface the runner needs. Implementations: real
 *  (Coordinator-driven), stub (deterministic), CLI (future). */
export type AgentInvoker = (call: AgentInvocation) => Promise<AgentInvocationResult>;

export interface RunnerOptions {
    fixtures: Fixture[];
    invoke: AgentInvoker;
    /** Where to write scorecard JSON. Optional — if omitted, scorecard
     *  is returned but not persisted. */
    outputDir?: string;
    /** Optional semantic-check grader. Passed through to the scorer.
     *  When omitted, semantic checks fail with "no grader provided". */
    gradeSemantic?: (rubric: string, workspaceDir: string) => Promise<{ passed: boolean; detail: string }>;
    /** Per-fixture progress callback. Useful for streaming progress to
     *  stdout in long runs. */
    onFixtureStart?: (fixture: Fixture, mode: 'interactive' | 'autopilot') => void;
    onFixtureEnd?: (result: FixtureResult) => void;
}

/**
 * Run a list of fixtures and produce a scorecard. The fixture runner
 * is the entry point that gets wired into vscode-test (and eventually
 * a CLI subcommand).
 *
 * Each fixture is run in each of its declared modes. A "mode" is
 * either 'interactive' (auto-approve interventions, count them) or
 * 'autopilot' (no interventions surface). Both modes always run when
 * the fixture declares them, even for v1 where we only ship against
 * the interactive number — the autopilot data is v2 prep.
 */
export async function runFixtures(opts: RunnerOptions): Promise<Scorecard> {
    const { fixtures, invoke, gradeSemantic, onFixtureStart, onFixtureEnd } = opts;
    const allResults: FixtureResult[] = [];
    const runId = new Date().toISOString();
    const gitSha = await readGitSha();

    for (const fixture of fixtures) {
        for (const mode of fixture.modes) {
            onFixtureStart?.(fixture, mode);
            const workspaceDir = await mkTempWorkspace(fixture.id);
            try {
                const inv = await invoke({
                    workspaceDir,
                    requirement: fixture.requirement,
                    autopilot: mode === 'autopilot',
                    budgetSeconds: fixture.budgetSeconds
                });
                const result = await scoreFixture(fixture, workspaceDir, {
                    mode,
                    agentSeconds: inv.agentSeconds,
                    interventions: inv.interventions,
                    agentReportedComplete: inv.reportedComplete,
                    ...(gradeSemantic ? { gradeSemantic } : {})
                });
                allResults.push(result);
                onFixtureEnd?.(result);
            } catch (e) {
                // The agent invoker itself threw. Record as a failed
                // fixture rather than crashing the whole run.
                //
                // Surface the error to stderr — without this, every
                // exception looks identical to "agent took too long"
                // in the scorecard, which makes debugging infrastructure
                // problems (endpoint unreachable, missing dep, auth
                // failure) impossible.
                const errMsg = e instanceof Error ? e.message : String(e);
                const errStack = e instanceof Error && e.stack ? e.stack : '';
                process.stderr.write(
                    `\n[fixtures] ✗ ${fixture.id} (${mode}) — invoker threw:\n` +
                    `  ${errMsg}\n` +
                    (errStack ? `${errStack.split('\n').slice(0, 6).map(l => '  ' + l).join('\n')}\n` : '')
                );
                const errResult: FixtureResult = {
                    fixtureId: fixture.id,
                    mode,
                    workspaceDir,
                    agentSeconds: 0,
                    interventions: 0,
                    agentReportedComplete: false,
                    checks: fixture.rubric.map((c) => ({
                        description: c.description,
                        kind: c.kind,
                        passed: false,
                        detail: `agent invoker threw: ${errMsg}`
                    })),
                    passed: false
                };
                allResults.push(errResult);
                onFixtureEnd?.(errResult);
            }
            // Note: we don't clean up workspaceDir on failure. The
            // workspaces stay in os.tmpdir() for post-mortem inspection.
            // CI should clean tmpdir at end of job; local runs leak
            // until reboot, which is acceptable.
        }
    }

    const scorecard = buildScorecard(runId, gitSha, allResults);
    if (opts.outputDir) {
        await persistScorecard(scorecard, opts.outputDir);
    }
    return scorecard;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function mkTempWorkspace(fixtureId: string): Promise<string> {
    const safeId = fixtureId.replace(/[^a-z0-9-]/gi, '_');
    const dir = path.join(os.tmpdir(), `nexuscode-fixture-${safeId}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function readGitSha(): Promise<string> {
    try {
        const head = await fs.readFile('.git/HEAD', 'utf-8');
        const match = head.trim().match(/^ref:\s+(.+)$/);
        if (match && match[1]) {
            const ref = match[1];
            const sha = await fs.readFile(path.join('.git', ref), 'utf-8');
            return sha.trim().slice(0, 7);
        }
        return head.trim().slice(0, 7);
    } catch {
        return 'unknown';
    }
}

async function persistScorecard(card: Scorecard, outputDir: string): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });
    // ISO timestamps include colons; replace for cross-platform filenames
    const safeRunId = card.runId.replace(/[:.]/g, '-');
    const jsonPath = path.join(outputDir, `scorecard-${safeRunId}.json`);
    const mdPath = path.join(outputDir, `scorecard-${safeRunId}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(card, null, 2));
    await fs.writeFile(mdPath, renderScorecardMarkdown(card));
}

// ─── Stub agent (for harness self-tests only) ───────────────────────

/**
 * Deterministic stub agent for testing the harness itself. Reports
 * complete=true, writes a stubbed package.json with the fixture id, and
 * uses the requirement to decide on a "complexity" (longer requirement
 * = longer simulated agent time). NEVER use for real measurement —
 * this is purely for unit-testing the runner/scorer/reporter chain.
 */
export const stubAgent: AgentInvoker = async (call) => {
    await fs.writeFile(
        path.join(call.workspaceDir, 'package.json'),
        JSON.stringify({ name: 'stubbed', version: '0.0.0' }, null, 2)
    );
    return {
        reportedComplete: true,
        agentSeconds: Math.min(2, call.budgetSeconds / 60),
        interventions: call.autopilot ? 0 : 1
    };
};