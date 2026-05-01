// src/agents/ReAct/ReActConfig.ts
//
// Type definitions for the shared ReAct engine. Extracted as part of
// the Coordinator rewrite (C-1, per COORDINATOR_REWRITE_DESIGN.md).
//
// Three legacy ReAct loops are being consolidated into one engine:
//   1. runPlannerAgent (planAgent.ts) — read-only, 8-step ceiling, full
//      hardening (path guard, dedup, budget, stuck-loop)
//   2. swarmDraftCode (Coordinator.ts) — write-capable, 6-step ceiling,
//      tracks didModifyingToolCall
//   3. runAgenticExploration (llmService.ts) — read-only, 2-step ceiling,
//      no hardening, has inline custom tool implementations for
//      grep_search and find_file
//
// The engine's surface area is wide enough to support all three patterns
// without any caller having to fall back to its own loop.

import type { ToolDefinition, ChatMessage, ToolCall, AssistantMessage } from '../../llm';
import type { ToolEventEmitter } from '../toolEventEmitter';
import type { PreDispatchHook } from '../toolDispatchWithEvents';
import type { ToolDispatchResult } from '../toolProtocol';

/**
 * Source tag for lifecycle events emitted via the ToolEventEmitter.
 * Mirrors the tag that dispatchWithEvents already supports.
 */
export type ReActEventSource = 'planner' | 'coordinator' | 'verifier-internal';

/**
 * Optional inline tool resolver. When the model calls a tool name that
 * isn't in the registered tool catalog, the engine consults this map.
 *
 * Used by `runAgenticExploration`'s legacy `grep_search` and `find_file`
 * implementations, which are inlined in llmService.ts rather than
 * registered in the tool registry. C-3 will decide whether to keep them
 * inline (via this resolver) or promote them to registered tools.
 *
 * Resolvers are responsible for their own lifecycle event emission if
 * desired; the engine does NOT emit events for custom-resolved calls.
 */
export type CustomToolResolver = (
    toolCall: ToolCall,
    workspaceRoot: string
) => Promise<{ llmContent: string; uiPayload?: unknown }>;

/**
 * Logging callback. Carries the legacy 3-arg signature used everywhere
 * in the codebase (msg, stepType, details). Engine emits high-level
 * status messages through this — per-tool-call rendering is handled by
 * the lifecycle event emitter when wired.
 */
export type ReActLogCallback = (
    msg: string,
    stepType?: string,
    details?: string
) => void;

/**
 * Streaming token callback. The engine calls this for each content
 * chunk emitted by the model (when `streamCallback` is provided).
 */
export type ReActStreamCallback = (token: string) => void;

/**
 * Token usage callback. Forwarded from provider.chatCompletion's usage
 * field on the final assistant message of each turn.
 */
export type ReActUsageCallback = (usage: unknown) => void;

/**
 * Hardening flags. Each one corresponds to a specific post-2B hotfix.
 * Callers opt in based on their needs:
 *   - Planner enables ALL of them (H7-H10).
 *   - Coder enables search-budget but not dedup (Coder intentionally
 *     re-reads after edits to verify, so dedup would interfere).
 *   - Explorer enables none of them (legacy 2-step loop, no guards).
 */
export interface ReActHardeningFlags {
    /**
     * Hotfix 7: detect when consecutive turns produce the same tool-call
     * set (sorted+joined signature comparison). When detected, abort
     * the loop with a clear "stuck" diagnostic instead of burning the
     * remaining step budget on identical no-progress turns.
     */
    enableStuckLoopDetector?: boolean;

    /**
     * Hotfix 9: per-session dedup cache. Repeated calls with identical
     * `(name, arguments)` get a synthetic "already dispatched in turn N"
     * response back to the model instead of re-dispatching. Steers the
     * model toward emitting the final output rather than re-exploring.
     *
     * Coder agent should leave this OFF — it intentionally re-reads
     * after edits to verify the change landed correctly.
     */
    enableDedupCache?: boolean;

    /**
     * Hotfix 8: cumulative tool-call budget across all turns of one
     * session. When exceeded, abort with a tailored error message
     * (re-reading vs degenerate-search vs other).
     */
    enableTotalCallBudget?: boolean;
}

/**
 * Termination predicate. The engine checks this against the assistant's
 * message content after each non-tool turn. When it returns true, the
 * loop ends and the content is returned.
 *
 * Examples:
 *   - Planner build mode: `(c) => c.includes('<execution_plan>')`
 *   - Planner explore mode: `(c) => c.includes('READY_TO_CODE')`
 *   - Coder: `() => true` — Coder uses finish_reason instead, so any
 *     non-tool turn is treated as completion (this is the legacy
 *     swarmDraftCode behavior)
 */
export type ReActTerminationCheck = (content: string) => boolean;

/**
 * Re-prompt builder. When the model produces a non-tool turn that does
 * NOT satisfy the termination check, the engine pushes this re-prompt
 * to nudge the model toward producing the expected output format.
 *
 * Example for planner-build:
 *   "You must either call a tool to explore further, or emit the final
 *    plan using the exact XML tags: <analysis>, <files_to_modify>, ..."
 */
export type ReActReprompt = (turn: number) => string;

/**
 * Full configuration for one ReAct run. Static — all values resolved
 * before the engine starts.
 */
export interface ReActConfig {
    /** System prompt sent on every chatCompletion turn. */
    systemPrompt: string;

    /** User prompt — the task brief. */
    userPrompt: string;

    /** Additional message history to seed the conversation (optional). */
    chatHistory?: ChatMessage[];

    /** Tools available to the model on every turn. */
    tools: ToolDefinition[];

    /**
     * Custom resolvers for tools NOT in the registered tool catalog.
     * Only consulted when the model calls a name that's not registered.
     * Used by runAgenticExploration for inline grep_search/find_file.
     */
    customToolResolvers?: Record<string, CustomToolResolver>;

    /** Workspace root passed to dispatched tool calls. */
    workspaceRoot: string;

    /** Maximum ReAct iterations. Hard ceiling — loop exits after this. */
    maxSteps: number;

    /** Maximum cumulative tool calls (only enforced if hardening flag set). */
    maxTotalToolCalls?: number;

    /** Sampling temperature for chatCompletion. */
    temperature?: number;

    /** Termination predicate — when content satisfies this, loop ends. */
    isDone: ReActTerminationCheck;

    /** Re-prompt builder for non-tool, non-done turns. Optional — if
     *  absent, non-done non-tool turns are treated as completion. */
    repromptOnNonDone?: ReActReprompt;

    /** Hardening flags — opt-in per agent role. */
    hardening?: ReActHardeningFlags;

    /** Pre-dispatch hook (security gate). Same shape as dispatchWithEvents. */
    preDispatchHook: PreDispatchHook;

    /** Lifecycle event emitter — if provided, events fire with `eventSource`. */
    emitter?: ToolEventEmitter;

    /** Source tag for lifecycle events. Required when emitter is provided. */
    eventSource: ReActEventSource;

    /** Task ID for event sequence numbering. Required when emitter is provided. */
    taskId?: string;

    /** Abort signal — propagated to provider.chatCompletion. */
    abortSignal?: AbortSignal;

    /** Logging callback — high-level status messages only. */
    log: ReActLogCallback;

    /** Streaming token callback (optional). */
    streamCallback?: ReActStreamCallback;

    /** Token usage callback (optional). */
    usageCallback?: ReActUsageCallback;

    /**
     * Optional callback invoked after each tool-call dispatch. Used by
     * the Coder agent to track whether a modifying tool (write_file/
     * edit_file) was ever invoked — needed for the post-2B "no
     * modifying calls" short-circuit.
     */
    onToolDispatched?: (toolCall: ToolCall, dispatchResult: ToolDispatchResult) => void;
}

/**
 * Result of a single ReAct run.
 */
export interface ReActResult {
    /** The final assistant content that satisfied the termination check
     *  (or, if maxSteps was reached, the last assistant content). */
    finalContent: string;

    /** Total number of tool calls dispatched across all turns. */
    totalToolCalls: number;

    /** Number of ReAct iterations consumed (1-indexed in error
     *  messages, 0-indexed internally). */
    totalSteps: number;

    /** True if the loop exited via isDone, false if maxSteps was reached. */
    completedNormally: boolean;

    /** All assistant messages produced during the run, in order. Useful
     *  for debugging or multi-turn analysis. */
    assistantMessages: AssistantMessage[];
}

/**
 * Specific error class thrown when the stuck-loop detector fires.
 * Callers can catch this specifically vs generic Error.
 */
export class ReActStuckLoopError extends Error {
    constructor(public readonly turnSignature: string) {
        super(
            "ReAct loop stuck — same tool calls dispatched twice in a row. " +
            "This usually means the model is producing corrupted tool arguments " +
            "and not recovering from the resulting errors. Try regenerating, or " +
            "check the model/endpoint."
        );
        this.name = 'ReActStuckLoopError';
    }
}

/**
 * Thrown when the cumulative tool-call budget is exhausted.
 */
export class ReActBudgetExceededError extends Error {
    constructor(
        public readonly totalDispatched: number,
        public readonly budget: number,
        public readonly diagnosis: string
    ) {
        super(
            `ReAct loop exceeded tool-call budget (${budget}) without producing output. ` +
            diagnosis +
            ` Possible remedies: rephrase the task with more specific scope, simplify the project, ` +
            `or use a stronger / less-quantized model.`
        );
        this.name = 'ReActBudgetExceededError';
    }
}