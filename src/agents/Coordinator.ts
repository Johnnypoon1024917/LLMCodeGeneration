// src/agents/Coordinator.ts

import * as path from 'path';
import * as vscode from 'vscode';
// Coordinator rewrite:
//   C-2: PlannerAgent replaces explorer + planner.
//   C-4: CoderAgent replaces swarmDraftCode (formerly inline in this
//        file). The swarmDraftCode function and its tool-dispatch
//        helpers are gone — all the Coder logic lives in CoderAgent now.
import { PlannerAgent } from './PlannerAgent';
import { CoderAgent } from './CoderAgent';
import { getProjectContext } from '../projectContext';
import { getDeps } from '../container';
import { VerifierAgent, type VerificationResult, type VerifierFailure } from './VerifierAgent';
import { IEnvironment } from '../interfaces/IEnvironment';
import { errorMessage, isAbortError } from '../utilities/errors';
import type { ToolEventEmitter } from './toolEventEmitter';
// V2.1.2 spec-fix-11 #3-DIAG: direct logger import for the wrong-file
// edit investigation. Will be removed when the diagnostic is concluded.
import { log } from '../logger';

export interface CodeDiff {
    filepath: string;
    searchBlock: string;
    replaceBlock: string;
    fullOutputBuffer: string;
    /**
     * Component 2B-3c (stepping-stone Option C): when present, this is
     * the post-modification full content of the target file. The apply
     * path in SidebarProvider uses it directly rather than running the
     * legacy search/replace dance.
     *
     * Why opt-in: legacy callers (planner that returns SEARCH/REPLACE
     * blocks, verifier that synthesizes CodeDiff from text output) keep
     * working without setting this field. Only the CoderAgent path
     * (which uses tool calls that actually modify the file) populates it.
     *
     * Invariant when set: searchBlock holds the pre-modification full
     * file content, replaceBlock holds the post-modification full
     * content. This preserves the verifier's existing input contract
     * (it still receives a usable CodeDiff) without forcing every
     * caller to understand the new mechanism.
     */
    finalContent?: string;
    /**
     * Component 2B-3c (post-2B audit): set to true when the Coder's
     * ReAct loop completed but the model never dispatched a successful
     * write_file or edit_file call. Common cause: endpoint's tool-call
     * parser doesn't recognize the model's emission format, so what
     * looked like a tool call to the model was treated as plain text
     * by the adapter and never reached our dispatcher.
     *
     * The Coordinator's retry loop checks this flag before the verifier
     * runs — there's no point compiling a file the model never modified.
     * Setting this flag short-circuits to a corrective retry message
     * rather than a false-pass via the compiler.
     */
    noModifyingToolCalls?: boolean;
}

/**
 * Reads `nexuscode.maxVerificationRetries` from VS Code config with a safe fallback.
 * Falls back to the default if vscode.workspace.getConfiguration is unavailable
 * (e.g. when this file is exercised from `cli.ts` outside the extension host).
 */
function readMaxRetries(defaultValue: number = 2): number {
    try {
        const v = getDeps().config.get<number>('maxVerificationRetries');
        if (typeof v === 'number' && v >= 1 && v <= 5) {
            return v;
        }
    } catch {
        // Deps not yet bootstrapped (very early startup or unit test)
    }
    return defaultValue;
}

/**
 * P1.1: build the user-message that goes back to the Coder on retry.
 *
 * Two paths:
 *
 *   1. Structured failures present (typical compile/test failure):
 *      enumerate them as "Failure 1: ...", each with file:line:code:
 *      message. The Coder reads this as a checklist and can address
 *      each one individually. Single-shot self-heal candidates
 *      (severity='unambiguous_typo') are flagged so the Coder knows
 *      these are routine fixes, not architectural problems.
 *
 *   2. No structured failures (LLM PRD review failed, parse error,
 *      etc.): fall back to the legacy prose critique. We keep the
 *      revert-notice and phantom-import warnings because those are
 *      historically-known failure modes the model needs reminding of.
 *
 * Either way, the message is wrapped with consistent "your code was
 * NOT saved, file is REVERTED" framing so the next attempt's
 * SEARCH/REPLACE blocks target the original file content.
 */
export function buildRetryMessage(verification: VerificationResult): string {
    const failures = verification.failures ?? [];
    const REVERT_NOTICE =
        `\n\nCRITICAL REVERT NOTICE: Because your code was rejected, it was NOT saved. ` +
        `The file has been REVERTED to its original state. If using <<<<SEARCH, it MUST ` +
        `target the original file content, NOT your failed code.\n\n` +
        `PHANTOM IMPORT WARNING: If you received a "Cannot find module" or "is not a module" error, ` +
        `you hallucinated an import. Do NOT try to create the missing file via markdown. ` +
        `Either fix the import or write the logic INLINE in this current file.\n\n` +
        `You MUST fix the errors in your next attempt.`;

    if (failures.length === 0) {
        // Path 2: prose-only fallback. Same as the pre-P1.1 message.
        return `🚨 VERIFIER REJECTED YOUR CODE 🚨\n\nCritique:\n${verification.critique}${REVERT_NOTICE}`;
    }

    // Path 1: structured. Enumerate failures with focused detail.
    const lines: string[] = [];
    lines.push(`🚨 VERIFIER REJECTED YOUR CODE — ${failures.length} issue(s) to fix 🚨`);
    lines.push('');

    // Group by kind so the Coder sees compile errors before test
    // failures (compile failures usually need fixing first; tests
    // are downstream).
    const compileFailures = failures.filter((f) => f.kind === 'compile');
    const testFailures = failures.filter((f) => f.kind === 'test');
    const reviewFailures = failures.filter((f) => f.kind === 'review');

    if (compileFailures.length > 0) {
        lines.push(`### Compile errors (${compileFailures.length})`);
        lines.push('');
        for (let i = 0; i < compileFailures.length; i++) {
            lines.push(formatFailure(i + 1, compileFailures[i]!));
        }
        lines.push('');
    }
    if (testFailures.length > 0) {
        lines.push(`### Test failures (${testFailures.length})`);
        lines.push('');
        for (let i = 0; i < testFailures.length; i++) {
            lines.push(formatFailure(i + 1, testFailures[i]!));
        }
        lines.push('');
    }
    if (reviewFailures.length > 0) {
        lines.push(`### Spec/PRD review failures (${reviewFailures.length})`);
        lines.push('');
        for (let i = 0; i < reviewFailures.length; i++) {
            lines.push(formatFailure(i + 1, reviewFailures[i]!));
        }
        lines.push('');
    }

    // Hint when self-heal is expected. If ALL failures are unambiguous
    // typos, signal that explicitly — the Coder should produce a
    // small focused fix, not rewrite the whole file.
    const allUnambiguous = failures.every((f) => f.severity === 'unambiguous_typo');
    if (allUnambiguous) {
        lines.push(
            `**Note:** All failures above are routine syntax/import issues. ` +
            `Apply minimal targeted fixes; do not rewrite the file.`
        );
        lines.push('');
    }

    return lines.join('\n') + REVERT_NOTICE;
}

function formatFailure(index: number, f: VerifierFailure): string {
    const location = f.file
        ? (f.line !== undefined
            ? `${f.file}:${f.line}${f.column !== undefined ? `:${f.column}` : ''}`
            : f.file)
        : '(project-wide)';
    const codeTag = f.code
        ? ` [${f.kind === 'compile' ? 'TS' : ''}${f.code}]`
        : '';
    const severityTag = f.severity === 'unambiguous_typo' ? ' [routine fix]' : '';
    // V2.3 bundle 2: per-error fix hint based on the TS error code.
    // Qwen 27B benefits from concrete actionable advice next to each
    // error rather than just the error text. Hints are templates —
    // the model still has to apply judgment, but the template scopes
    // its thinking to the right kind of fix.
    const hint = formatErrorHint(f);
    const hintLine = hint ? `\n   💡 ${hint}` : '';
    return `${index}. **${location}**${codeTag}${severityTag}\n   ${f.message}${hintLine}`;
}

/**
 * V2.3 bundle 2: map common compile-error patterns to concrete fix
 * hints. The hints are TEMPLATES — they don't tell the Coder the
 * exact fix (which depends on the project), but they scope the
 * Coder's response to the correct REGION of solutions.
 *
 * For each TS error code we've seen in production logs, return a
 * one-line hint. For codes we don't have a hint for, return null
 * (no hint line rendered).
 *
 * Why this works: Qwen 27B has good reasoning but sometimes loses
 * the thread when the failure is unfamiliar. "Property X doesn't
 * exist" can be fixed five different ways (rename X, add X to type,
 * use a different property, fix a typo, change the type assertion).
 * The hint narrows the search space.
 */
function formatErrorHint(f: VerifierFailure): string | null {
    if (f.kind !== 'compile' || !f.code) { return null; }
    const code = String(f.code);
    const msg = f.message || '';

    // TS2339 — Property does not exist on type.
    // Common cause: agent assumed a field that isn't in the actual
    // type definition (e.g., CreateBookingRequest.notes when notes
    // wasn't added).
    if (code === '2339') {
        const propMatch = msg.match(/Property '([^']+)' does not exist on type '([^']+)'/);
        if (propMatch) {
            const [, prop, type] = propMatch;
            return `Property '${prop}' is not defined on '${type}'. Either: (a) add '${prop}' to the type definition in its source file, OR (b) use a property that DOES exist on '${type}' (read the type's source file with read_file to see the actual fields), OR (c) remove this access if it was a mistake. Do NOT just cast to 'any' — that hides the real bug.`;
        }
        return `Property doesn't exist on the type. Read the type definition with read_file to see what properties are actually available.`;
    }

    // TS2307 — Cannot find module.
    // Common cause: phantom import (importing a package that isn't
    // installed). Bundle 3 catches this earlier via package.json
    // hints, but the retry path needs to handle it too.
    if (code === '2307') {
        const modMatch = msg.match(/Cannot find module '([^']+)'/);
        if (modMatch) {
            const mod = modMatch[1];
            return `Module '${mod}' is not installed in this project. Either: (a) implement the needed logic INLINE in this file (no external dependency), OR (b) check if a different already-installed package provides similar functionality. If you genuinely need '${mod}', mention it in your one-line summary AFTER the tool call so the orchestrator can install it.`;
        }
        return `An imported module can't be found. Either implement the logic inline, use an already-installed package, or note the new dependency in your post-tool-call summary.`;
    }

    // TS2345 — Argument of type X not assignable to parameter of type Y.
    if (code === '2345') {
        return `Type mismatch on a function call argument. Either: (a) convert/cast the argument to the expected type explicitly, OR (b) change the call to pass the correct type, OR (c) update the function signature if YOU control it. Read the function's signature with read_file before deciding.`;
    }

    // TS7006 — Parameter implicitly has an 'any' type.
    if (code === '7006') {
        const paramMatch = msg.match(/Parameter '([^']+)' implicitly has an 'any' type/);
        if (paramMatch) {
            const param = paramMatch[1];
            return `Parameter '${param}' needs an explicit type annotation. Determine the correct type from how the parameter is used (or from the parent function's expected callback signature) and annotate it: '${param}: SomeType'.`;
        }
        return `A parameter needs an explicit type annotation. Determine its type from usage context.`;
    }

    // TS2741 — Property X is missing in type.
    if (code === '2741') {
        const missingMatch = msg.match(/Property '([^']+)' is missing in type/);
        if (missingMatch) {
            const prop = missingMatch[1];
            return `When constructing the object, you must include the '${prop}' field. Either: (a) populate it with a real value, OR (b) if it's optional in your domain, mark it optional in the type definition.`;
        }
        return `A required property is missing from an object literal. Add it.`;
    }

    // TS2693 — X only refers to a type, but is being used as a value.
    if (code === '2693') {
        const nameMatch = msg.match(/'([^']+)' only refers to a type/);
        if (nameMatch) {
            const name = nameMatch[1];
            return `'${name}' is a type, not a runtime value. You probably want either: (a) a value/enum imported from the same module (e.g., 'SortOrder' the type vs 'Prisma.SortOrder.asc' the value), OR (b) to use this only in type positions ('let x: ${name}', not 'const x = ${name}').`;
        }
        return `Used a type as a runtime value. Reference the runtime equivalent (often an enum value or constant), not the type name.`;
    }

    // TS2694 — Namespace has no exported member.
    // Phantom Prisma types are the canonical case (Prisma.BookingWhereInput
    // doesn't exist in newer versions of @prisma/client).
    if (code === '2694') {
        const memberMatch = msg.match(/Namespace '[^']*?' has no exported member '([^']+)'/);
        if (memberMatch) {
            const member = memberMatch[1];
            return `'${member}' isn't exported from that namespace in the version installed. Read the actual installed types (e.g., 'node_modules/@prisma/client/index.d.ts' for Prisma) with read_file to find the correct exported name. Common Prisma renames: 'BookingWhereInput' → 'Prisma.BookingWhereInput' (with capital), or it may simply not exist (use the Prisma client method's parameter type directly).`;
        }
        return `A namespace member doesn't exist. Read the namespace's actual type definitions with read_file to find the correct name.`;
    }

    return null;
}

/**
 * Options for {@link runTask}. Replaces the legacy 13-positional-arg
 * `SwarmCoordinator.executeTask` signature with a named-params object
 * (Coordinator rewrite C-5).
 *
 * Why named params: the legacy signature was a maintenance hazard.
 * Adding/removing/reordering parameters required updating every call
 * site and was error-prone — the SidebarProvider call site had 13
 * positional arguments, several of which had similar types
 * (`string`, callback functions). Named params eliminate the entire
 * class of "passed callback A where callback B was expected" bugs.
 *
 * Also note: the legacy `_lspContext` parameter was dead code (the
 * leading underscore acknowledged this — it was passed but never
 * used). It has been removed from the new shape entirely. The
 * SidebarProvider call site no longer computes the placeholder
 * `lspBlastRadiusContext` value.
 */
export interface RunTaskOptions {
    /** Environment abstraction (file system, LLM provider) — same
     *  shape as the legacy `env` parameter. */
    env: IEnvironment;

    /** The task description from the planner's task list, or the
     *  raw user prompt for ad-hoc execution. */
    task: string;

    /** Absolute filesystem path of the workspace. Used by tool
     *  dispatches and disk operations. */
    workspaceRoot: string;

    /** Active requirements.md content. Empty string if no PRD. */
    activeRequirements: string;

    /** Active design.md content. Empty string if no design doc. */
    activeDesign: string;

    /** Verifier critique from previous attempts (retry-with-context). */
    previousFailures: string;

    /** Steering rules from .nexusrules / .nexus/steering. This is
     *  the "global" rule string shared with the planner and used as
     *  a fallback for the coder. P2.2 callers should ALSO supply
     *  `perFileSteering` to get scope-filtered, custom-file-aware
     *  steering at the Coder level. */
    globalRules: string;

    /** V2.3 bundle 3: pre-rendered installed-packages prompt section.
     *  Optional. When set, the Coder's system prompt includes the
     *  list so library imports match installed reality. Computed
     *  by the host once per workspace via detectInstalledPackages
     *  + renderPackagesPromptSection. Targets phantom-import bugs
     *  (rrule not installed; Prisma type drift). */
    installedPackagesSection?: string;

    /** V2.3 bundle 4 (TypeScript-only stepping-stone): pre-rendered
     *  type-symbols prompt section listing exported names from high-
     *  value packages. Targets phantom-type-reference bugs (e.g.
     *  Prisma.BookingWhereInput phantom). Computed by the host via
     *  detectHighValueSymbols + renderSymbolsPromptSection. */
    typeSymbolsSection?: string;

    /** P2.2: per-file steering callback. When provided, the Coordinator
     *  invokes this with each Coder's target filepath to obtain a
     *  file-scoped steering block. The block REPLACES `globalRules`
     *  for that Coder invocation — it should already incorporate any
     *  global-scope steering that's still relevant for the file.
     *  (`SteeringManager.buildSteeringPromptBlock({ targetFilepath })`
     *  does this naturally.)
     *
     *  When omitted, the legacy `globalRules` string is passed
     *  verbatim to every Coder — no scope filtering. Existing
     *  callers (fixtures, headless runs) get unchanged behavior. */
    perFileSteering?: (filepath: string) => Promise<string>;

    /** High-level status messages from the Coordinator. The planner
     *  and coder use their own log surfaces; this is for top-level
     *  orchestration messages ("Coordinator: Task received...",
     *  "Coordinator: Verifier rejected..."). */
    log: (msg: string, stepType?: string, details?: string) => void;

    /** Live token streaming callback for the Coder phase. When omitted,
     *  the Coder still works (text accumulates internally) but no
     *  progressive UI updates fire. */
    streamCallback?: (token: string) => void;

    /** Abort signal — propagated to LLM calls and tool dispatches.
     *  Triggered by the cancel button or external timeout. */
    abortSignal?: AbortSignal;

    /** Token usage telemetry callback. Forwarded from the LLM provider's
     *  `onUsage` hook to the webview's tokenUsage panel. */
    usageCallback?: (usage: unknown) => void;

    /** Per-session lifecycle event emitter. When provided, the Coder's
     *  and Planner's tool calls emit started/output/completed events
     *  for the rich-card UI. When absent, dispatch is silent — used
     *  for headless invocations (CLI runtime, tests). */
    toolEventEmitter?: ToolEventEmitter;

    /** V2.2 hotfix #4: notification fired when a task transitions from
     *  one retry attempt to the next. The host uses this to clear stale
     *  tool-call cards from the webview before the retry begins, so
     *  cards from attempt N+1 don't visually stack on top of attempt N's
     *  cards. Without this, retried tasks accumulated dozens of
     *  read_file / list_directory cards visually, making it hard to see
     *  what the current attempt was doing.
     *
     *  Called with the taskId being retried just before the new attempt
     *  dispatches. The host's implementation typically:
     *    1. Posts a `taskRetry` message to the webview with the taskId
     *    2. Webview reducer deletes all toolCallState entries whose
     *       taskId matches (after resolveTaskKey collapsing).
     *
     *  When omitted (headless / fixtures), retries proceed without UI
     *  cleanup — same as pre-V2.2 behavior. */
    taskRetryCallback?: (taskId: string, attempt: number) => void;

    /** V2.1.2 spec-fix-12 — Bug #1: opt-in approval hook for human-in-
     *  the-loop gating of write_file / edit_file calls. When provided,
     *  the dispatch pipeline pauses for user approval before mutating
     *  the workspace. When omitted, every call auto-approves (legacy
     *  behavior — fixtures, headless runs, autopilot mode). */
    approvalHook?: import('./toolDispatchWithEvents').ApprovalHook;

    /** P1.1: opt-in callback for verifier failures. Fires once per
     *  verifier rejection, with the structured failure list and the
     *  attempt number (1-indexed). Use cases:
     *
     *    - Fixture harness: count interventions, distinguish self-heal
     *      from final-failure, surface unambiguous-typo rate
     *    - Telemetry: track which error codes are most common
     *    - UI: render structured failure cards (P1.1c — UI work)
     *
     *  The callback receives `selfHealed=true` when the next attempt
     *  succeeded — it fires AFTER that next attempt completes, not
     *  immediately on rejection. This is the metric that proves the
     *  retry actually fixed the problem.
     *
     *  Existing callers ignore this field; behavior unchanged. */
    verifierFailureCallback?: (event: {
        attempt: number;
        failures: VerifierFailure[];
        critique: string;
        /** True if a subsequent attempt passed verification. False if
         *  this was the final failure (max retries exhausted) or if
         *  the next attempt is yet to run. */
        selfHealed: boolean;
    }) => void;
}

/**
 * Run one task end-to-end: Planner → Coder → Verifier (with retries).
 * Returns the array of `CodeDiff` to apply, or `null` if the task
 * could not be completed (after all retries / on abort / on error).
 *
 * Replaces the legacy `SwarmCoordinator.executeTask` (Coordinator
 * rewrite C-5). Same external contract — same return shape, same
 * error handling — just a cleaner call signature.
 */
export async function runTask(opts: RunTaskOptions): Promise<CodeDiff[] | null> {
    // Destructure preserves the inner variable names used throughout
    // the body — keeps the C-5 diff localized to the call signature.
    const {
        env,
        task,
        workspaceRoot,
        activeRequirements,
        activeDesign,
        previousFailures,
        globalRules,
        perFileSteering,
        log: logCallback,
        streamCallback,
        abortSignal: signal,
        usageCallback,
        toolEventEmitter,
        approvalHook,
        verifierFailureCallback,
        taskRetryCallback,
        installedPackagesSection,
        typeSymbolsSection,
    } = opts;

    logCallback("Coordinator: Task received. Initiating Swarm Orchestration...", "analyze", "Booting Swarm Agents");

    try {
        // Coordinator rewrite C-2: single planner replaces the
        // legacy explorer-then-planner pair. Context for the
        // planner now comes from `getProjectContext` (the
        // directory tree) instead of `runAgenticExploration`'s
        // 2-step pre-pass — the Planner does its own exploration
        // via the ReAct loop, so the pre-pass was redundant.
        //
        // This change resolves three of the audit's findings:
        //   - "Initializing Dynamic Search" hang (Explorer is gone)
        //   - Two visualization styles (Explorer used legacy
        //     statusCallback log lines; PlannerAgent uses rich
        //     toolEventEmitter cards)
        //   - Duplicate "Booting ReAct Engine" boot message
        //     (both agents emitted the same string)
        const codebaseContext = await getProjectContext(workspaceRoot);

        const plannerResult = await PlannerAgent.run({
            mode: 'build',
            task,
            workspaceRoot,
            initialContext:    codebaseContext,
            prd:               activeRequirements,
            design:            activeDesign,
            previousFailures,
            globalRules,
            log:               logCallback,
            ...(toolEventEmitter ? { toolEventEmitter } : {}),
            ...(signal ? { abortSignal: signal } : {}),
            ...(usageCallback ? { usageCallback } : {})
        });

        const techSpec = plannerResult.techSpec;

        // ─── #3-DIAG (spec-fix-11) ─────────────────────────────────────
        // Wrong-file edit investigation. Capture what the Coordinator
        // sees BEFORE making file-selection decisions.
        log.info(`[#3-DIAG] Coordinator received task (first 300 chars): "${task.slice(0, 300)}"`);
        log.info(`[#3-DIAG] Coordinator received techSpec from planner (first 500 chars): "${techSpec.slice(0, 500)}"`);
        // ───────────────────────────────────────────────────────────────

        const filesToModify: string[] = [];

        // Strict target lock-on: if the UI already passed a target file in the
        // task description, trust it over anything the planner inferred.
        const explicitTargetMatch =
            task.match(/Target File:\s*([^\n]+)/i) ||
            task.match(/File:\s*`([^`]+)`/i);

        if (explicitTargetMatch && explicitTargetMatch[1] !== undefined) {
            filesToModify.push(explicitTargetMatch[1].trim());
            logCallback(
                `Coordinator: Strict target detected [${explicitTargetMatch[1].trim()}]. Lock-on engaged.`,
                "analyze"
            );
            // ─── #3-DIAG ─────────────────────────────
            log.info(`[#3-DIAG] Coordinator file-selection mechanism: STRICT_LOCK from task description regex. Selected: "${explicitTargetMatch[1].trim()}"`);
            // ─────────────────────────────────────────
        } else {
            // Fall back to the planner's <files_to_modify> block.
            const filesMatch = techSpec.match(/<files_to_modify>([\s\S]*?)<\/files_to_modify>/);
            if (filesMatch && filesMatch[1] !== undefined) {
                const fileRegex = /<file>([^<]+)<\/file>/g;
                let match: RegExpExecArray | null;
                while ((match = fileRegex.exec(filesMatch[1])) !== null) {
                    if (match[1] !== undefined) { filesToModify.push(match[1].trim()); }
                }
                // ─── #3-DIAG ─────────────────────────────
                log.info(`[#3-DIAG] Coordinator file-selection mechanism: PLANNER_TECHSPEC <files_to_modify> regex. Selected: ${JSON.stringify(filesToModify)}`);
                // ─────────────────────────────────────────
            } else {
                // ─── #3-DIAG ─────────────────────────────
                log.info(`[#3-DIAG] Coordinator file-selection mechanism: NO MATCH — neither task lock-on nor <files_to_modify> regex matched. Will fall back to "unknown".`);
                // ─────────────────────────────────────────
            }
        }

        if (filesToModify.length === 0) {
            logCallback(
                "Coordinator: No explicit files to modify found in plan. Falling back to dynamic inference.",
                "analyze"
            );
            filesToModify.push("unknown");
        }

        const allDiffs: CodeDiff[] = [];
        const MAX_RETRIES = readMaxRetries(2);

        for (const filepath of filesToModify) {
            logCallback(`Coordinator: Spawning Coder Agent for [${filepath}]...`, "code");
            // ─── #3-DIAG ─────────────────────────────────
            log.info(`[#3-DIAG] Coordinator dispatching to Coder with filepath: "${filepath}"`);
            // ─────────────────────────────────────────────

            let fileContentStr = "";
            if (filepath !== "unknown") {
                try {
                    const absolutePath = path.join(workspaceRoot, filepath);
                    fileContentStr = await env.readFile(absolutePath);
                } catch (e) {
                    logCallback(
                        `Coordinator: File ${filepath} not found on disk. Assuming new file creation.`,
                        "analyze"
                    );
                }
            }

            let attempts = 0;
            let finalDiff: CodeDiff | null = null;
            const chatHistory: { role: string; content: string }[] = [];

            // P2.2: resolve file-scoped steering ONCE before the retry
            // loop. Steering is a function of (filepath, steering-files-
            // on-disk) — it doesn't change between attempts on the same
            // file, so reading it once saves redundant FS work on retry.
            //
            // When perFileSteering isn't provided (legacy callers,
            // fixtures, headless runs), fall back to the static
            // globalRules string.
            let coderSteering = globalRules;
            if (perFileSteering) {
                try {
                    coderSteering = await perFileSteering(filepath);
                } catch (e) {
                    logCallback(
                        `Coordinator: per-file steering lookup failed for ${filepath}, falling back to globalRules: ${e}`,
                        "analyze"
                    );
                    // coderSteering stays as globalRules — best effort
                }
            }

            // P1.1: track the previous attempt's verifier failure so we
            // can fire verifierFailureCallback with selfHealed=true if
            // the next attempt passes. This is the metric that tells us
            // whether single-shot self-heal is working in practice.
            //
            // Set to non-null at the end of each rejected attempt; reset
            // to null after the callback fires (whether self-healed or
            // exhausted retries).
            let pendingFailure: {
                attempt: number;
                failures: VerifierFailure[];
                critique: string;
            } | null = null;

            while (attempts < MAX_RETRIES) {
                attempts++;
                logCallback(
                    `Coordinator: Drafting ${filepath} (Attempt ${attempts}/${MAX_RETRIES})...`,
                    "code",
                    "Coder Agent activated."
                );

                // V2.2 hotfix #4: clear tool-call cards from the previous
                // attempt before starting the next one. Without this,
                // retried tasks accumulated read_file / list_directory
                // cards from each attempt visually stacked, making it
                // very hard to see what the current attempt was doing.
                // Only fire on attempts 2+ — the first attempt has
                // nothing to clear.
                if (attempts > 1 && taskRetryCallback) {
                    taskRetryCallback(`${task}::${filepath}`, attempts);
                }

                if (streamCallback) {
                    const separator = attempts === 1
                        ? `\n\n### Attempt 1 of ${MAX_RETRIES}\n`
                        : `\n\n---\n### Attempt ${attempts} of ${MAX_RETRIES}\n`;
                    streamCallback(separator);
                }

                const draftDiff: CodeDiff = await CoderAgent.run({
                    techSpec,
                    filepath,
                    fileContent: fileContentStr,
                    chatHistory,
                    globalRules: coderSteering,
                    ...(installedPackagesSection ? { installedPackagesSection } : {}),
                    ...(typeSymbolsSection ? { typeSymbolsSection } : {}),
                    workspaceRoot,
                    // taskId for lifecycle event seq stamping. The
                    // task descriptor `task` is already a unique
                    // string for this run; suffix with filepath so
                    // multi-file tasks don't collide on seq counters.
                    taskId: `${task}::${filepath}`,
                    ...(streamCallback ? { streamCallback } : {}),
                    ...(signal ? { abortSignal: signal } : {}),
                    ...(usageCallback ? { usageCallback } : {}),
                    ...(toolEventEmitter ? { emitter: toolEventEmitter } : {}),
                    // V2.1.2 spec-fix-12 — Bug #1: forward approval hook
                    // to the Coder. The Coder is where write_file /
                    // edit_file actually fire; the verifier only runs
                    // read-only tools (tsc, test runners) so it doesn't
                    // need the hook.
                    ...(approvalHook ? { approvalHook } : {})
                });

                // Component 2B-3c (post-2B audit): short-circuit if
                // the model never dispatched a write_file/edit_file
                // tool call. Running the verifier in this case is
                // wasteful (compiling unchanged code) AND can mask
                // the failure (an empty new file compiles "fine"
                // for some tsc configs, leading the user to think
                // their request succeeded when nothing was written).
                //
                // Symptoms diagnosed in the wild:
                //   - Model emitted `<tool_call>` XML inside content
                //     instead of OpenAI tool_calls (parser config
                //     mismatch on vLLM)
                //   - Model truncated mid-tool-call due to token
                //     limit
                //   - Model genuinely refused to use tools
                //
                // We treat this as a verification failure with a
                // corrective message to the next attempt's history.
                if (draftDiff.noModifyingToolCalls) {
                    // V2.3 bundle 1: build a TARGETED critique that
                    // diagnoses the specific failure mode in the
                    // previous response. Generic "use the tool"
                    // critiques don't work — Qwen 27B has been
                    // ignoring them. Concrete diagnoses + a literal
                    // template for the next response work better.
                    const prev = draftDiff.fullOutputBuffer || '';
                    const prevSample = prev.length > 800 ? prev.slice(0, 800) + '... [truncated]' : prev;
                    const diagnoses: string[] = [];

                    // Failure mode A: emitted markdown code blocks
                    // instead of write_file. Detect by ```language
                    // fences in the response.
                    if (/```[a-zA-Z]+\n/.test(prev)) {
                        diagnoses.push(
                            '- Your response contains markdown code blocks (```language ... ```). ' +
                            'These do NOT modify the file. The file system only sees write_file/edit_file tool calls.'
                        );
                    }

                    // Failure mode B: stated intent without acting.
                    // Phrases like "I will create...", "Let me write..."
                    // followed by no tool call.
                    if (/\b(I will|Let me|I'll|I am going to|Let's now|Now I will)\b/i.test(prev)) {
                        diagnoses.push(
                            '- Your response describes what you intend to do ("I will...", "Let me...") but does not actually do it. ' +
                            'The phrase "I will write the file" must be IMMEDIATELY FOLLOWED by the write_file tool call in the SAME turn.'
                        );
                    }

                    // Failure mode C: nearly empty response.
                    if (prev.trim().length < 50) {
                        diagnoses.push(
                            '- Your response is nearly empty. The model produced no actionable content. ' +
                            'This usually means the request exceeded your context budget mid-generation, or you decided not to write anything.'
                        );
                    }

                    // Failure mode D: contains <tool_call> but malformed.
                    // We're already in the noModifyingToolCalls branch, so
                    // if the response has <tool_call> markers, the parser
                    // failed to extract a valid write_file/edit_file
                    // invocation. Most common causes: missing closing
                    // brace, escaped quote sequences, or the closing
                    // </tool_call> tag is missing.
                    if (prev.includes('<tool_call>')) {
                        diagnoses.push(
                            '- Your response contains <tool_call> tags but the tool call was not parsed successfully. ' +
                            'The JSON inside the tag may be malformed (missing closing brace, escaped quotes wrong) or the closing </tool_call> tag may be missing. ' +
                            'In your retry, ensure: (a) the JSON is fully formed, (b) the closing </tool_call> tag is present, (c) string values escape internal quotes correctly.'
                        );
                    }

                    const diagnosis = diagnoses.length > 0
                        ? `\nWhat went wrong (specific diagnosis based on your previous response):\n${diagnoses.join('\n')}\n`
                        : '\nDiagnosis: your previous response did not contain a recognizable write_file or edit_file tool call.\n';

                    const critique =
                        `🚨 ATTEMPT ${attempts} REJECTED — file was not modified.\n` +
                        diagnosis +
                        `\n` +
                        `═══════════════════════════════════════════════════════════════\n` +
                        `WHAT YOU MUST DO IN YOUR NEXT RESPONSE:\n` +
                        `═══════════════════════════════════════════════════════════════\n` +
                        `Start your response IMMEDIATELY with the write_file tool call.\n` +
                        `Do not narrate. Do not explain. Do not say "I will write...".\n` +
                        `Just emit the tool call.\n\n` +
                        `Concrete template (replace the path and content):\n` +
                        `<tool_call>\n` +
                        `{"name": "write_file", "arguments": {"path": "${filepath}", "content": "...your code here..."}}\n` +
                        `</tool_call>\n\n` +
                        `After the tool call, you may add a brief one-line summary.\n` +
                        `═══════════════════════════════════════════════════════════════\n\n` +
                        `Your previous response (for reference, do not repeat it):\n` +
                        `---\n${prevSample}\n---\n\n` +
                        `Now: emit the write_file tool call for ${filepath}. The file content must satisfy the original Technical Spec.`;

                    logCallback(
                        `Coder [${filepath}]: No modifying tool calls in attempt ${attempts}.`,
                        "error",
                        critique
                    );

                    if (streamCallback) {
                        streamCallback(
                            `\n\n> ❌ **Attempt ${attempts} produced no file modifications.** Re-prompting model with targeted diagnosis.\n`
                        );
                    }

                    chatHistory.push({ role: "assistant", content: draftDiff.fullOutputBuffer });
                    chatHistory.push({ role: "user", content: critique });
                    // Skip verifier; go to next attempt.
                    continue;
                }

                const verification = await VerifierAgent.run({
                    env,
                    techSpec,
                    draftDiff,
                    workspaceRoot,
                    log: logCallback,
                    // Coordinator rewrite C-6: optional emitter wiring.
                    // When provided, the verifier's tsc / npm install /
                    // test commands render as rich bash_output cards.
                    // taskId is suffixed `::verifier::filepath` so events
                    // don't collide with planner/coder events.
                    ...(toolEventEmitter ? { emitter: toolEventEmitter } : {}),
                    taskId: `${task}::verifier::${draftDiff.filepath}`,
                });

                if (verification.usage && usageCallback) {
                    usageCallback(verification.usage);
                }

                if (verification.passed) {
                    finalDiff = draftDiff;

                    // P1.1: if the previous attempt failed and this one
                    // passed, that's a self-heal. Fire the callback with
                    // selfHealed=true so the harness/telemetry can count it.
                    if (pendingFailure && verifierFailureCallback) {
                        try {
                            verifierFailureCallback({
                                attempt: pendingFailure.attempt,
                                failures: pendingFailure.failures,
                                critique: pendingFailure.critique,
                                selfHealed: true
                            });
                        } catch {
                            // Telemetry callbacks are observers, not gates —
                            // never let them crash the dispatch path.
                        }
                    }
                    pendingFailure = null;

                    if (streamCallback) {
                        streamCallback(`\n\n✅ **Verification Passed!** Code approved for deployment.\n`);
                    }
                    logCallback(`Coder [${filepath}]: QA Passed.`, "success");
                    break;
                }

                logCallback(
                    `Coder [${filepath}]: Verifier rejected attempt ${attempts}.`,
                    "error",
                    `QA Critique:\n${verification.critique}`
                );

                if (streamCallback) {
                    streamCallback(
                        `\n\n> ❌ **Verifier Rejected Attempt ${attempts}:**\n> \n> ${verification.critique.replace(/\n/g, '\n> ')}\n`
                    );
                }

                // Component 2B-3c: pass the model's narrative output
                // back as assistant turn for the next retry. The
                // file on disk will be reverted by CoderAgent at
                // the start of the next attempt (it writes pre-mod
                // content before the ReAct loop), so the "REVERTED"
                // claim in the next user turn remains truthful.
                chatHistory.push({ role: "assistant", content: draftDiff.fullOutputBuffer });

                // P1.1: prefer structured failures over prose critique
                // when the verifier returned them. The structured form
                // is far easier for the Coder to parse than a prose
                // blob with embedded error text.
                //
                // Why this matters: with structured failures, the Coder
                // sees an enumerated list of file:line:code:message that
                // it can address one-by-one. With the prose critique,
                // it has to extract the same information from a string
                // that includes formatting decoration ("🚨 COMPILER ERROR
                // DETECTED 🚨") and instructions ("You MUST fix...").
                // The structured version typically wins on cleaner code
                // generation.
                //
                // Fallback: when verification.failures is absent or
                // empty (LLM PRD review path, parser-failure path),
                // we use the legacy prose critique. Same retry semantics,
                // less focused signal.
                const retryMessage = buildRetryMessage(verification);
                chatHistory.push({ role: "user", content: retryMessage });

                // P1.1: stash the failure so we can fire the callback
                // when we know whether the next attempt fixes it.
                pendingFailure = {
                    attempt: attempts,
                    failures: verification.failures ?? [],
                    critique: verification.critique
                };
            }

            // P1.1: the loop exited without `break` (which only happens
            // on verifier-passed). If we have a pending failure, that
            // means the LAST attempt failed too — fire the callback
            // with selfHealed=false so the harness/telemetry knows.
            if (pendingFailure && !finalDiff && verifierFailureCallback) {
                try {
                    verifierFailureCallback({
                        attempt: pendingFailure.attempt,
                        failures: pendingFailure.failures,
                        critique: pendingFailure.critique,
                        selfHealed: false
                    });
                } catch {
                    // Same observer-not-gate principle as the success path.
                }
            }
            pendingFailure = null;

            if (finalDiff) {
                allDiffs.push(finalDiff);
            } else {
                // Component 2B-3c (post-2B audit): max retries exhausted.
                // Under Option C the file on disk is whatever the last
                // attempt left there (post-mod for whatever the model
                // produced, which the verifier rejected). Restore the
                // file to its pre-mod content before throwing — without
                // this, an existing file gets clobbered with the failed
                // model output and the user loses their original code.
                //
                // For new-file case (filepath was 'unknown' or the file
                // didn't exist when CoderAgent started), pre-mod
                // content was empty, so we delete the file rather than
                // leave a zero-byte stub on disk.
                if (filepath !== 'unknown') {
                    const targetUri = vscode.Uri.file(path.join(workspaceRoot, filepath));
                    try {
                        if (fileContentStr !== "") {
                            // File pre-existed — restore the original content.
                            await vscode.workspace.fs.writeFile(
                                targetUri,
                                new TextEncoder().encode(fileContentStr)
                            );
                        } else {
                            // Pre-mod was empty (new file). Delete the
                            // partial result rather than leave it.
                            try {
                                await vscode.workspace.fs.delete(targetUri);
                            } catch {
                                // Ignore if already gone or never created.
                            }
                        }
                    } catch (restoreErr: unknown) {
                        // Restoration is best-effort. Log but don't
                        // mask the original failure with a restore error.
                        logCallback(
                            `Coordinator: Could not restore ${filepath} after retry exhaustion: ${errorMessage(restoreErr)}`,
                            "error"
                        );
                    }
                }

                throw new Error(
                    `Swarm failed to generate verified code for ${filepath} after ${MAX_RETRIES} attempts.`
                );
            }
        }

        return allDiffs;

    } catch (error: unknown) {
        // Catch wrapped abort errors from cancel button or timeout.
        if (isAbortError(error)) {
            logCallback(`Coordinator: Task Cancelled or Timed Out.`, "error", "AbortError");
            const abortErr = new Error('AbortError');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        const msg = errorMessage(error);
        logCallback(`Coordinator Error: ${msg}`, "error", msg);
        return null;
    }
}