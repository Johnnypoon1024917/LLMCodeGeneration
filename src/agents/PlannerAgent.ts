// src/agents/PlannerAgent.ts
//
// Read-only ReAct agent. Replaces both `runPlannerAgent` (planAgent.ts)
// and `runExplorerAgent` (exploreAgent.ts) — the explore-then-plan
// pattern is consolidated into a single agent with two modes. Also
// replaces `runAgenticExploration` from llmService.ts as of C-3.
//
// Design (per COORDINATOR_REWRITE_DESIGN.md):
//   - Build mode: 8-step ReAct, all H7-H10 hardening, expects model
//     to emit `<execution_plan>` XML. Used by Coordinator.executeTask.
//   - Explore mode: 2-step ReAct, no hardening, expects model to emit
//     `READY_TO_CODE`. Used by SidebarProvider's `intent === 'explore'`
//     diagnostic chat flow. Returns gathered tool results via the
//     `gatheredContext` field for downstream chat.
//
// Both modes share:
//   - Same lifecycle event emission via toolEventEmitter (rich cards).
//   - Same source tag: 'planner'.
//   - Same security hook: allowAllHook (read-only tools don't need
//     elevated security gating).
//
// Tool catalog differs by mode:
//   - Build mode: read_file, list_directory, search_codebase
//   - Explore mode: read_file, list_directory + grep_search and
//     find_file (custom resolvers — see runExplore for why).

import * as vscode from 'vscode';
import { runReAct } from './ReAct';
import type {
    ReActConfig,
    ReActLogCallback
} from './ReAct';
import { getToolDefinitions } from './toolRegistry';
import { allowAllHook } from './securityHook';
import type { ToolEventEmitter } from './toolEventEmitter';
// Trigger registration of all tools by importing the barrel. Without
// this, `getToolDefinitions` returns an empty list when this module
// is loaded before the tools have registered themselves.
import './tools';

/**
 * Mode the planner runs in. Build mode produces an execution plan for
 * the Coder; explore mode produces a free-form analysis for the
 * `intent === 'explore'` chat flow.
 */
export type PlannerMode = 'build' | 'explore';

/**
 * Inputs the agent needs. Most fields are optional and default to ""
 * — empty strings produce blank prompt blocks that the system prompt
 * tolerates. Required fields are `mode`, `task`, `workspaceRoot`, `log`.
 */
export interface PlannerAgentOptions {
    /**
     * Which mode to run in. Build mode is fully implemented in C-2;
     * explore mode is stubbed and will be wired in C-3.
     */
    mode: PlannerMode;

    /** The user's task description. */
    task: string;

    /** Absolute filesystem path used by tool dispatches. */
    workspaceRoot: string;

    // ─── Build-mode context ──────────────────────────────────────────
    // These are passed through to the build-mode system prompt as
    // `<prd>`, `<design>`, etc. blocks. Empty strings are tolerated and
    // produce no block in the prompt. Ignored in explore mode.

    /** Directory tree (typically from `getProjectContext`). Replaces
     *  the legacy explorer's pre-pass output. */
    initialContext?: string;

    /** Active requirements.md content. */
    prd?: string;

    /** Active design.md content. */
    design?: string;

    /** Verifier critique from previous attempts (for retry-with-context). */
    previousFailures?: string;

    /** Steering rules from .nexusrules. */
    globalRules?: string;

    // ─── Common plumbing ──────────────────────────────────────────────

    /** Log callback for high-level status messages. Same shape as the
     *  legacy `log` parameter on runPlannerAgent. */
    log: ReActLogCallback;

    /**
     * Lifecycle event emitter for tool calls. When provided, the rich
     * 2B-4 cards render in the webview. When absent (CLI / tests), per-
     * tool-call log lines are emitted via `log` instead — preserving
     * the legacy CLI behavior.
     */
    toolEventEmitter?: ToolEventEmitter;

    /** Abort signal — propagated to provider.chatCompletion. */
    abortSignal?: AbortSignal;

    /** Token usage callback. */
    usageCallback?: (usage: unknown) => void;
}

/**
 * Result of a planner run.
 */
export interface PlannerAgentResult {
    /**
     * Echo of the input mode so callers can branch on it without
     * having to thread the mode through a parallel variable.
     */
    mode: PlannerMode;

    /**
     * The final assistant content. For build mode, contains the
     * `<execution_plan>` XML (or best-effort content if maxSteps was
     * reached). For explore mode, free-form analysis (typically
     * "READY_TO_CODE\n..." or just the model's wrap-up).
     */
    techSpec: string;

    /**
     * Concatenated tool results gathered during the run. Populated
     * only in explore mode — present in this single shape rather than
     * a discriminated union to keep call sites simple.
     *
     * Format mirrors the legacy `runAgenticExploration` accumulator:
     *   `\n--- Tool Result: ${name}(${args}) ---\n${content}\n`
     *
     * SidebarProvider's explore-intent flow uses this as forensic
     * evidence to feed into the downstream chat stream. Build-mode
     * callers (Coordinator) ignore this field — it's `undefined`
     * there.
     */
    gatheredContext?: string;

    /** Total tool calls dispatched across the session. */
    totalToolCalls: number;

    /** Whether the loop terminated via isDone (true) or maxSteps (false). */
    completedNormally: boolean;
}

// ─── Build-mode prompt construction ──────────────────────────────────

/**
 * Build the system prompt for build mode. Mirrors the legacy
 * `runPlannerAgent` prompt verbatim except for the "Initial hints
 * from explorer" line — that section now reads "Initial codebase
 * context" since we no longer have a separate Explorer agent.
 */
function buildBuildSystemPrompt(opts: {
    initialContext: string;
    prd: string;
    design: string;
    failures: string;
    globalRules: string;
}): string {
    // P1.2 (2026-05): stronger steering directive. Old language was a
    // soft "must be obeyed"; now the planner must explicitly check
    // for conflicts and stop if it can't reconcile them. This catches
    // "my plan is fine but it violates a project convention" earlier
    // — before the Coder writes code, not after the Verifier rejects.
    const rulesBlock = opts.globalRules
        ? `\n--- PROJECT STEERING RULES (NON-NEGOTIABLE) ---\n${opts.globalRules}\n\nIf any rule above CONFLICTS with the user's request, do NOT silently pick one. Emit <rules_conflict>describe which rule conflicts with what part of the request</rules_conflict> as a top-level tag instead of <execution_plan>, and stop. The user resolves the conflict.\n-----------------------------------------------\n`
        : "";

    const prdBlock      = opts.prd      ? `\n<prd>\n${opts.prd}\n</prd>\n`                                : "";
    const designBlock   = opts.design   ? `\n<design>\n${opts.design}\n</design>\n`                       : "";
    const failuresBlock = opts.failures ? `\n<previous_failures>\n${opts.failures}\n</previous_failures>\n` : "";

    return `You are the Principal Software Architect. Your objective is to generate a comprehensive execution plan based on the user's request.
${rulesBlock}
CRITICAL DIRECTIVES:
1. DO NOT GUESS. Use 'read_file' and 'list_directory' to verify the exact files you intend to modify, including their existing function signatures and imports.
2. DO NOT RE-READ. Each file should be read AT MOST ONCE per planning session. The exploration tools have a budget; redundant reads waste it. If you need to recall what was in a file, scroll back through your prior tool results.
3. STOP WHEN READY. As soon as you have enough information to write the plan, EMIT IT. You do not need to read every file in the codebase — only the ones directly relevant to this task.
4. EMIT THE PLAN AS YOUR NEXT MESSAGE'S CONTENT (not as a tool call). The XML below is the plan format.
5. P1.2 — STRUCTURED FILE-IMPACT REASONING. For every file you list, you must justify WHY it's touched: what role does it play today, what specifically changes, what risk does the change carry, what does it depend on. A senior engineer reviewing your plan should be able to assess each file independently without re-reading the whole spec.

CONTEXT PROVIDED:
- Initial codebase context:
${opts.initialContext || "(none)"}
${prdBlock}${designBlock}${failuresBlock}

OUTPUT FORMAT (strict XML — every tag is required):
<analysis>One paragraph: how the requirements map onto the existing code structure.</analysis>

<file_impact_analysis>
  <!--
    P1.2: per-file structured reasoning. For each file the plan
    touches, emit one <file> entry with all four sub-tags.
    risk values: low | medium | high
      - low: localized change, no API contract impact
      - medium: changes a function used elsewhere, or adds new public API
      - high: changes core types, schemas, or contracts crossing module boundaries
    depends_on: comma-separated list of OTHER files in this plan that
    must land before this one. Use the empty string when there are no
    in-plan dependencies. External libraries do NOT belong here.
  -->
  <file path="path/to/exact/file.ext">
    <existing_role>What this file does today, in one sentence.</existing_role>
    <planned_change>What this plan modifies — function added, signature changed, etc.</planned_change>
    <risk>low|medium|high</risk>
    <depends_on>path/to/other/file.ts, path/to/another.ts</depends_on>
  </file>
  <!-- repeat <file> per file -->
</file_impact_analysis>

<files_to_modify>
  <!-- Flat list of paths. MUST contain exactly the same paths as
       <file_impact_analysis> above. This block exists for backward
       compatibility with downstream parsers; do not omit it. -->
  <file>path/to/exact/file.ext</file>
</files_to_modify>

<execution_plan>
  Step-by-step technical instructions for the Coder agent. Describe exactly what logic to add, modify, or remove in each file.
  Write deterministic behavioral specs — do NOT write the raw code here.
</execution_plan>
<verification_rules>
  - Bulleted list of conditions that MUST hold for the code to be considered complete.
</verification_rules>`;
}

const BUILD_USER_PROMPT_SUFFIX =
    "\n\nExplore the codebase using your tools, then emit the final XML plan.";

const BUILD_REPROMPT =
    "You must either call a tool to explore further, or emit the final plan using the exact XML tags: " +
    "<analysis>, <file_impact_analysis>, <files_to_modify>, <execution_plan>, <verification_rules>. " +
    "If steering rules conflict with the request, emit <rules_conflict> instead and stop. " +
    "No prose outside those tags.";

// ─── Per-tool-call log emission (legacy CLI parity) ──────────────────

/**
 * Builds the per-tool-call log message — the legacy "Planner inspecting
 * codebase…" status line. Only used when no emitter is configured
 * (CLI / tests), so the rich-card UI doesn't double-render.
 *
 * Mirrors the legacy `logToolCall` helper in planAgent.ts for parity.
 */
function emitLegacyToolCallLog(
    log: ReActLogCallback,
    toolName: string,
    rawArgs: string
): void {
    let parsedArgs: { filepath?: string; dirpath?: string; keyword?: string } = {};
    try {
        parsedArgs = JSON.parse(rawArgs || '{}');
    } catch {
        // Tolerate malformed args — same behavior as legacy logToolCall.
    }
    const detail = parsedArgs.filepath || parsedArgs.dirpath || parsedArgs.keyword || '';
    log(
        'Planner inspecting codebase…',
        'tool',
        `${toolName}(${detail})`
    );
}

// ─── Explore-mode helpers (C-3) ──────────────────────────────────────
//
// These replicate the legacy `runAgenticExploration` from llmService.ts
// with one structural change: the `statusCallback` log lines are gone.
// The ReActEngine + the toolEventEmitter handle all UI surfacing
// uniformly across modes (rich cards when emitter is wired, legacy
// log lines via emitLegacyToolCallLog when not).
//
// The hallucination guards from the legacy implementation are preserved:
//   - read_file / list_directory: registered tools already handle
//     missing-path errors via the standard executor (no special
//     handling needed here — the engine routes them through the
//     normal dispatch path).
//   - grep_search: pattern length minimum (3 chars), 30-match cap,
//     500KB file-size cap, project-wide exclude pattern.
//   - find_file: same exclude pattern, 10-result cap.

/**
 * Build the system prompt for explore mode. Mirrors the legacy
 * `runAgenticExploration` prompt verbatim. The directory tree is
 * injected from the caller's `initialContext` (typically populated
 * by `getProjectContext`).
 */
function buildExploreSystemPrompt(projectContext: string): string {
    return `You are the Explorer Agent. Your role is EXCLUSIVELY to search and analyze the codebase dynamically using tools.
    
     CRITICAL RULES 
    1. DO NOT HALLUCINATE PATHS: You already have the full Directory Tree below. ONLY call 'read_file' on files that actually exist in this tree. Do not guess folder names.
    2. USE FIND_FILE: If you are looking for a file but don't know the exact path, use the 'find_file' tool. DO NOT guess the path.
    3. YOU ARE STRICTLY PROHIBITED FROM: Creating new files, modifying files, or writing code.
    4. Use 'grep_search' to find where specific functions, classes, or variables are defined.
    5. Once you have enough context, reply with: "READY_TO_CODE".
    
    --- DIRECTORY TREE ---
    ${projectContext}`;
}

/**
 * Lenient JSON parser for tool-call arguments. The model occasionally
 * emits malformed args; legacy code tolerated this without crashing,
 * so we do the same.
 */
function parseArgsLenient(rawArgs: string): Record<string, unknown> {
    try {
        return JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    } catch {
        return {};
    }
}

/**
 * Project-wide exclude pattern shared by grep_search and find_file.
 * Same set of directories the legacy implementation excluded.
 */
const EXPLORE_EXCLUDE_PATTERN =
    '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.next/**}';

/**
 * Project-wide include glob for grep_search. Same set of file
 * extensions the legacy implementation searched. Adding to this list
 * is safe; removing risks breaking workflows that rely on it.
 */
const GREP_INCLUDE_GLOB =
    '**/*.{ts,tsx,js,jsx,json,html,css,py,java,cpp,c,go,rs,rb,md,txt}';

/**
 * Custom resolver for `grep_search`. Returns matching lines across
 * the workspace, capped at 30 hits to keep the response prompt-
 * efficient. Skips empty files and files larger than 512KB to avoid
 * memory hangs.
 */
async function runGrepSearch(pattern: string): Promise<{ llmContent: string }> {
    if (!pattern || pattern.length < 3) {
        return {
            llmContent: "Pattern too short. Please use a more specific search term."
        };
    }

    let regex: RegExp;
    try {
        regex = new RegExp(pattern, 'i');
    } catch {
        return { llmContent: "Grep failed due to invalid regex." };
    }

    let results = "";
    let matchCount = 0;
    const MAX_MATCHES = 30;
    const MAX_FILE_SIZE = 512000;

    try {
        const files = await vscode.workspace.findFiles(
            GREP_INCLUDE_GLOB,
            EXPLORE_EXCLUDE_PATTERN,
            150 // Strict file count limit prevents memory hangs.
        );

        await Promise.all(files.map(async (file) => {
            if (matchCount >= MAX_MATCHES) { return; }
            try {
                const fileData = await vscode.workspace.fs.readFile(file);
                if (fileData.byteLength === 0 || fileData.byteLength > MAX_FILE_SIZE) { return; }

                const content = new TextDecoder('utf8').decode(fileData);
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    if (matchCount >= MAX_MATCHES) { return; }
                    const line = lines[i];
                    if (line === undefined || !regex.test(line)) { continue; }

                    const relativePath = vscode.workspace.asRelativePath(file);
                    results += `${relativePath}:${i + 1}: ${line.trim().substring(0, 100)}\n`;
                    matchCount++;
                }
            } catch {
                // Silently skip unreadable files — same as legacy.
            }
        }));
    } catch {
        return { llmContent: "Grep failed due to a search error." };
    }

    return {
        llmContent: results || "No matches found."
    };
}

/**
 * Custom resolver for `find_file`. Returns matching workspace paths,
 * capped at 10 results. Returns "File not found" with explicit
 * guidance so the model doesn't fall back to guessing paths.
 */
async function runFindFile(filename: string): Promise<{ llmContent: string }> {
    if (!filename) {
        return { llmContent: "filename argument is required." };
    }

    try {
        const files = await vscode.workspace.findFiles(
            `**/*${filename}*`,
            '{**/node_modules/**,**/.git/**,**/dist/**}',
            10
        );
        return {
            llmContent: files.length > 0
                ? files.map(f => vscode.workspace.asRelativePath(f)).join('\n')
                : "File not found. Do not guess the path."
        };
    } catch {
        return { llmContent: "File search failed." };
    }
}

// ─── Public API ──────────────────────────────────────────────────────

export class PlannerAgent {
    /**
     * Run the planner against the provided task. Always returns a
     * result; throws on engine errors (stuck loop, budget exceeded,
     * provider failure). The error types from ReActEngine surface
     * unchanged so callers can distinguish them.
     */
    static async run(opts: PlannerAgentOptions): Promise<PlannerAgentResult> {
        if (opts.mode === 'explore') {
            return PlannerAgent.runExplore(opts);
        }
        return PlannerAgent.runBuild(opts);
    }

    // ─── Build mode ────────────────────────────────────────────────

    private static async runBuild(opts: PlannerAgentOptions): Promise<PlannerAgentResult> {
        opts.log(
            "Planner Agent: Booting ReAct Engine. Exploring codebase...",
            "analyze",
            "Gathering deep context before planning."
        );

        const systemPrompt = buildBuildSystemPrompt({
            initialContext: opts.initialContext ?? "",
            prd:            opts.prd ?? "",
            design:         opts.design ?? "",
            failures:       opts.previousFailures ?? "",
            globalRules:    opts.globalRules ?? ""
        });

        const userPrompt = `Task: ${opts.task}${BUILD_USER_PROMPT_SUFFIX}`;

        // Read-only tools only. Excludes write_file/edit_file (Coder's
        // job) and bash_exec/run_tests (Verifier's job).
        const tools = getToolDefinitions(['read_file', 'list_directory', 'search_codebase']);

        const config: ReActConfig = {
            systemPrompt,
            userPrompt,
            tools,
            workspaceRoot: opts.workspaceRoot,

            // Step ceilings calibrated from the legacy planAgent values
            // (8 steps × 30 cumulative tool calls). Same as before.
            maxSteps: 8,
            maxTotalToolCalls: 30,

            // Slightly higher than ReActEngine's default (0.2) because
            // the legacy planAgent used 0.2 explicitly and we want to
            // preserve behavior.
            temperature: 0.2,

            // Build mode looks for the strict XML termination tag.
            isDone: (content: string) => content.includes('<execution_plan>'),

            // Re-prompt on chatty-but-done turns: nudge the model
            // toward the strict format. Same wording as legacy.
            repromptOnNonDone: () => BUILD_REPROMPT,

            // Hardening: dedup cache + cumulative budget, but NOT the
            // stuck-loop detector. Rationale (post-C-3 layering hotfix
            // + this followup):
            //
            //   - Dedup cache catches the COMMON case (model retries
            //     the same call). It feeds back a synthetic "already
            //     dispatched, emit final output" message and the
            //     model gets a chance to recover gracefully. This is
            //     what we want.
            //
            //   - Cumulative budget caps total dispatches at 30. If
            //     the model is genuinely runaway (emitting many
            //     distinct calls without converging), the budget
            //     fires with a tailored diagnosis ("re-reading",
            //     "search", "exploring without converging") that
            //     tells the user what to do.
            //
            //   - Stuck-loop detector (H7) was originally added to
            //     short-circuit pathological repetition, but in
            //     practice it produced a cryptic abort message
            //     ("ReAct loop stuck — same tool calls dispatched
            //     twice in a row") that the user found unhelpful.
            //     The C-3 layering hotfix made dedup run first so
            //     stuck-detector wouldn't pre-empt graceful recovery,
            //     but the user reported the abort still firing —
            //     either because the hotfix wasn't reaching their
            //     disk OR because there's an edge case the layering
            //     fix didn't cover.
            //
            //     Either way, the stuck-detector is now redundant
            //     for the planner: every case it could fire in is
            //     either (a) already handled by dedup with better
            //     UX, or (b) already capped by the budget with a
            //     better diagnosis. Disabling it removes a brittle
            //     guard whose value is fully covered by the other
            //     two.
            //
            //   - The detector class itself stays in the codebase
            //     (loopGuards.ts:StuckLoopDetector). Future C-4
            //     Coder migration can opt back in if the Coder's
            //     dedup-disabled context benefits from it. Nothing
            //     in the engine changes here — only the planner's
            //     hardening flag.
            hardening: {
                enableStuckLoopDetector: false,
                enableDedupCache: true,
                enableTotalCallBudget: true
            },

            preDispatchHook: allowAllHook,

            // Source tag for lifecycle events. Webview can theme planner
            // cards differently from coder cards if it wants.
            eventSource: 'planner',
            // Only set the emitter / taskId pair when an emitter is
            // actually provided. The engine validates that taskId is
            // present iff emitter is.
            ...(opts.toolEventEmitter
                ? {
                    emitter: opts.toolEventEmitter,
                    // Suffix the taskId with `::planner` so the planner's
                    // events don't collide with the coder's events for
                    // the same task — same convention as Hotfix 10.
                    taskId: `${opts.task}::planner`
                }
                : {}),

            log: opts.log,
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(opts.usageCallback ? { usageCallback: opts.usageCallback } : {}),

            // Hotfix 10 carry-over: when no emitter is wired (CLI /
            // tests), surface per-tool-call log lines so the user has
            // SOME feedback during dispatches. When the emitter IS
            // wired, suppress these — the rich cards already render
            // each call as a foldable card and the log lines would
            // duplicate that information.
            ...(opts.toolEventEmitter
                ? {}
                : {
                    onToolDispatched: (toolCall) => {
                        emitLegacyToolCallLog(
                            opts.log,
                            toolCall.function.name,
                            toolCall.function.arguments
                        );
                    }
                })
        };

        const result = await runReAct(config);

        // Mirror the legacy success log. The ReActEngine doesn't emit
        // this — it's domain-specific to "we got the XML plan."
        if (result.completedNormally) {
            opts.log(
                "Planner Agent: Architecture spec finalized.",
                "success",
                "Plan rigorously verified against the codebase."
            );
        } else {
            // Best-effort return: ReActEngine already logged the warning,
            // but the legacy planAgent emitted a planner-specific message
            // too. Keep parity.
            opts.log(
                "Planner Agent: Step limit reached, returning best-effort plan.",
                "warning"
            );
        }

        return {
            mode: 'build',
            techSpec: result.finalContent,
            totalToolCalls: result.totalToolCalls,
            completedNormally: result.completedNormally
        };
    }

    // ─── Explore mode (C-3) ────────────────────────────────────────
    //
    // Replaces the legacy `runAgenticExploration` from llmService.ts.
    // Same external semantics:
    //   - 2-step ReAct ceiling (aggressive — explore is meant to be
    //     a fast pre-pass, not a deep dive)
    //   - Tools: read_file, list_directory (registered) + grep_search,
    //     find_file (custom resolvers, since they have explore-tuned
    //     hallucination guards and exclude patterns)
    //   - Termination: model emits "READY_TO_CODE"
    //   - Returns the gathered tool results (not the model's content)
    //     in `gatheredContext` — SidebarProvider's explore intent
    //     uses that as forensic evidence for the downstream chat.
    //   - No hardening (legacy didn't have it; 2 steps is the budget).

    private static async runExplore(opts: PlannerAgentOptions): Promise<PlannerAgentResult> {
        const projectContext = opts.initialContext ?? "";
        const systemPrompt = buildExploreSystemPrompt(projectContext);
        const userPrompt =
            `Task: ${opts.task}\n` +
            `You already know the file paths. Call 'read_file' on the targets immediately ` +
            `in a single batch, then exit with READY_TO_CODE!`;

        // Registered subset: read_file + list_directory. The grep_search
        // and find_file tools are wired as custom resolvers (below)
        // because they carry explore-tuned guards (regex pattern
        // length minimums, file-size caps, project-tuned exclude
        // globs) that the registered tools don't replicate.
        const registeredTools = getToolDefinitions(['read_file', 'list_directory']);

        // Inline tool definitions for grep_search and find_file. These
        // are passed to the LLM via the `tools` array but resolved by
        // the custom resolver map at dispatch time.
        const exploreTools = [
            ...registeredTools,
            {
                type: 'function' as const,
                function: {
                    name: 'grep_search',
                    description: "Search the entire codebase for a regex or string pattern (like ripgrep). Use this to hunt down where functions are used.",
                    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
                }
            },
            {
                type: 'function' as const,
                function: {
                    name: 'find_file',
                    description: "Search the directory tree for a specific file by its name or partial name if you don't know the exact folder path.",
                    parameters: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] }
                }
            }
        ];

        // gatheredContext accumulator. Format mirrors the legacy
        // `runAgenticExploration` exactly so SidebarProvider's
        // downstream "FORENSIC EVIDENCE" header keeps making sense.
        let gatheredContext = "";
        const accumulate = (toolCall: { function: { name: string; arguments: string } }, llmContent: string): void => {
            let parsedArgs: unknown;
            try {
                parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
                parsedArgs = toolCall.function.arguments;
            }
            gatheredContext +=
                `\n--- Tool Result: ${toolCall.function.name}` +
                `(${JSON.stringify(parsedArgs)}) ---\n${llmContent}\n`;
        };

        const config: ReActConfig = {
            systemPrompt,
            userPrompt,
            tools: exploreTools,
            workspaceRoot: opts.workspaceRoot,

            // Legacy 2-step ceiling — explore is a quick pre-pass, not
            // a deep ReAct exploration. The Planner has the deep loop;
            // Explore is the lightweight diagnostic.
            maxSteps: 2,

            // Lower temperature than build (0.1 vs 0.2) — same as the
            // legacy `runAgenticExploration`.
            temperature: 0.1,

            // Termination: model emits READY_TO_CODE.
            isDone: (content: string) => content.includes('READY_TO_CODE'),

            // No reprompt — legacy behavior was "non-tool turn ends
            // the loop unless READY_TO_CODE is in content," and the
            // engine's no-reprompt path matches this.

            // No hardening for explore mode. Legacy didn't have it,
            // 2-step ceiling makes most guards moot, and explore-mode
            // tools are different shape than build-mode (custom
            // resolvers don't go through the pathGuard at all).

            preDispatchHook: allowAllHook,

            // Same source tag as build mode — events render as planner
            // cards either way. The webview doesn't care about the
            // mode, just the source.
            eventSource: 'planner',
            ...(opts.toolEventEmitter
                ? {
                    emitter: opts.toolEventEmitter,
                    // Distinct task scope so explore events don't
                    // collide with concurrent build events for the
                    // same workspace.
                    taskId: `${opts.task}::explore`
                }
                : {}),

            log: opts.log,
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
            ...(opts.usageCallback ? { usageCallback: opts.usageCallback } : {}),

            // Custom resolvers for grep_search and find_file. Both
            // carry the legacy `runAgenticExploration` semantics:
            //  - grep_search: regex search across project files,
            //    rejects patterns shorter than 3 chars, caps at 30
            //    matches, skips empty/large files, has its own
            //    exclude pattern.
            //  - find_file: substring filename search, capped at
            //    10 results.
            customToolResolvers: {
                grep_search: async (toolCall) => {
                    const args = parseArgsLenient(toolCall.function.arguments);
                    const pattern = String(args['pattern'] ?? '');
                    return runGrepSearch(pattern);
                },
                find_file: async (toolCall) => {
                    const args = parseArgsLenient(toolCall.function.arguments);
                    const filename = String(args['filename'] ?? '');
                    return runFindFile(filename);
                }
            },

            // Accumulator: every tool result (registered or custom)
            // gets appended to gatheredContext. C-3 enhanced
            // ReActEngine to fire onToolDispatched for custom
            // resolvers too, so this catches ALL dispatch paths.
            onToolDispatched: (toolCall, dispatchResult) => {
                accumulate(toolCall, dispatchResult.llmContent);
                // Also keep the CLI per-call log line for parity when
                // no emitter is wired.
                if (!opts.toolEventEmitter) {
                    emitLegacyToolCallLog(
                        opts.log,
                        toolCall.function.name,
                        toolCall.function.arguments
                    );
                }
            }
        };

        const result = await runReAct(config);

        return {
            mode: 'explore',
            // For explore mode, techSpec is the model's final content
            // (typically just "READY_TO_CODE" or a brief wrap-up). The
            // useful output is gatheredContext — the accumulated tool
            // results, formatted as forensic evidence.
            techSpec: result.finalContent,
            gatheredContext,
            totalToolCalls: result.totalToolCalls,
            completedNormally: result.completedNormally
        };
    }
}