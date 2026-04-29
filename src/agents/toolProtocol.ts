// src/agents/toolProtocol.ts
//
// Component 2B protocol types — the contract between the agent layer
// (Coordinator, Verifier, future agents) and the rest of the system
// (audit log, UI, tool dispatch).
//
// What this file defines:
//   - `ToolResult` union (Q4=4C lock — split encoding: LLM gets a
//     plain string, UI gets a structured payload)
//   - `ToolLifecycleEvent` discriminated union (Q3=3C lock — sequenced
//     event stream)
//   - `ToolEventSource` — distinguishes real LLM-emitted tool calls
//     from Verifier-internal pseudo-tool-calls (Q8=8C "soft lie" tag)
//
// What this file deliberately doesn't define:
//   - Tool registry / dispatcher shape (2B-2)
//   - Coordinator integration with the protocol (2B-3)
//   - postMessage envelope shape going to the webview (2B-3 / 2B-4)
//   - UI card variants (2B-4)
//
// Locked decisions (per COMPONENT_2B_DESIGN.md):
//   - Q3: 3C — events carry monotonic sequence numbers per task,
//          enabling replay/undo and reliable reconstruction
//   - Q4: 4C — tool results split into `llmContent: string` (for the
//          model's message history) and `uiPayload: ToolResult` (for
//          the user interface)
//   - Q5: 5B+5D — per-task cancel only, no auto-retry (errors
//          propagate to the model via `llmContent`)
//   - Q8: 8C — Verifier emits events with `source: 'verifier-internal'`
//          even though no real LLM tool call exists upstream

// ─── Tool result encoding (Q4=4C: split LLM string + UI structured) ──

/**
 * Structured payload describing a tool's output for UI rendering.
 *
 * Each kind has its own optimal display:
 *   - `string`         — bare text. Used as fallback for tools whose
 *                        output doesn't fit a richer kind, or when a
 *                        dispatcher chooses simplicity.
 *   - `diff`           — file edit. UI renders before/after side-by-
 *                        side or as colorized unified diff.
 *   - `file_contents`  — full file body. UI shows collapsed preview
 *                        with click-to-expand, syntax-highlighted by
 *                        file extension.
 *   - `search_matches` — list of grep-style matches. UI renders as
 *                        clickable per-result rows.
 *   - `directory`      — directory listing. UI renders tree-style.
 *   - `bash_output`    — interleaved stdout/stderr from a shell command.
 *                        UI renders monospace, optionally with ANSI
 *                        color codes preserved.
 *   - `error`          — explicit error result. UI renders in error
 *                        styling. Distinct from a tool that succeeded
 *                        but produced output containing the word
 *                        "error".
 *
 * New kinds added later (e.g. `web_fetch_result` with title/excerpt
 * structure) extend the union without breaking existing UI variants.
 */
export type ToolResult =
    | { kind: 'string'; content: string }
    | { kind: 'diff'; filepath: string; before: string; after: string }
    | { kind: 'file_contents'; filepath: string; content: string; truncated?: boolean }
    | { kind: 'search_matches'; matches: Array<{ filepath: string; line: number; text: string }> }
    | { kind: 'directory'; path: string; entries: Array<{ name: string; kind: 'file' | 'dir' | 'symlink' }> }
    | { kind: 'bash_output'; stdout: string; stderr: string; exitCode: number; durationMs: number }
    | { kind: 'error'; message: string; stack?: string };

/**
 * Bundle returned by every tool dispatcher. Q4=4C lock.
 *
 *   - `llmContent` is what the message history shows to the LLM. Plain
 *     string. The LLM reasons about text, not JSON; forcing it to
 *     parse structured payloads burns tokens and degrades quality.
 *   - `uiPayload` is what the UI renders. Structured. Lets the UI
 *     pick the right card variant per `kind`.
 *
 * Dispatchers MUST produce both. The simplest case is when both are
 * the same string — e.g. `read_file` of a small file:
 *
 *   {
 *     llmContent: fileContents,
 *     uiPayload: { kind: 'file_contents', filepath, content: fileContents }
 *   }
 *
 * For diffs (write_file, edit_file), the LLM gets a flat unified-diff
 * string while the UI gets `before`/`after` for side-by-side rendering.
 */
export interface ToolDispatchResult {
    llmContent: string;
    uiPayload: ToolResult;
}

// ─── Tool lifecycle events (Q3=3C: sequenced event stream) ───────────

/**
 * Source of a tool-call event. Q8=8C ("soft lie" tagging).
 *
 *   - `coordinator`        — real LLM-emitted tool call from the
 *                            Coordinator's ReAct loop. Has a real
 *                            tool_call_id from `AssistantMessage.tool_calls`.
 *   - `planner`            — real LLM-emitted tool call from planAgent
 *                            or runAgenticExploration. Already in 2A
 *                            but not yet emitting these events; bridged
 *                            in 2B-3.
 *   - `verifier-internal`  — pseudo-tool-call from verificationAgent.
 *                            verificationAgent stays procedural per
 *                            Q8=8C; it emits these events to keep the
 *                            UI consistent (every shell exec shows up
 *                            as a tool card) but there's no real LLM
 *                            tool_call upstream. Audit consumers must
 *                            understand this when correlating with
 *                            chat-completion logs.
 *
 * Adding a new source (e.g. `subagent` for nested ReAct loops) is
 * additive to the union.
 */
export type ToolEventSource = 'coordinator' | 'planner' | 'verifier-internal';

/**
 * Common header on every event. Identifies the task, the tool call,
 * the event ordering, and the upstream source.
 *
 * Why `seq` is monotonic per `taskId` (not per `callId`): a single
 * task can have many concurrent tool calls (the model may emit
 * parallel tool_calls in one assistant message). Per-task seq lets
 * the UI reconstruct the exact temporal interleaving even when calls
 * complete out of order. Per-call seq alone wouldn't capture that
 * one call's output finished before another's started.
 *
 * Centralized seq generation lives in SidebarProvider (the single
 * point that postMessages the webview). Emitters at agents create
 * events with `seq: undefined` and SidebarProvider stamps the seq
 * in order before dispatch. This avoids contention between
 * Coordinator, Verifier, and any future emitters.
 */
export interface ToolEventHeader {
    /** Stable identifier for the task this event belongs to. */
    taskId: string;
    /** Stable identifier for the specific tool call. Matches the
     *  OpenAI tool_call.id when source is `coordinator` or `planner`.
     *  For `verifier-internal`, generated locally (e.g. `verifier:tsc:42`). */
    callId: string;
    /** Monotonic per-task sequence number. Stamped by SidebarProvider;
     *  emitters set this to undefined and trust the dispatch layer. */
    seq: number;
    /** Where this event came from. UI may render different sources
     *  with different visual treatment (e.g. Verifier events styled
     *  like a "QA agent" rather than the Coordinator). */
    source: ToolEventSource;
    /** Wall-clock timestamp (ms since epoch). Useful for audit log
     *  correlation across processes. */
    timestamp: number;
}

/**
 * Tool call started. Carries the name and arguments the LLM emitted
 * (or the agent constructed, for verifier-internal events).
 *
 * For Q7=7B streaming Provider: the Coordinator emits this once it
 * has accumulated a complete tool_call from delta streaming — i.e.
 * once the function name is known and arguments are syntactically
 * complete JSON. Mid-stream partial args do NOT trigger this event;
 * only complete tool calls do. This avoids UI churn from a card that
 * shows half-typed args, then re-renders when the rest arrives.
 *
 * (If you want live arg-typing display, add a `toolCallArgsDelta`
 * event in v1.1 — it's outside 2B-1 scope.)
 */
export interface ToolCallStartedEvent extends ToolEventHeader {
    type: 'toolCallStarted';
    name: string;
    arguments: Record<string, unknown>;
}

/**
 * Tool call produced output. For long-running tools (bash_exec,
 * run_tests), output streams in chunks. The UI accumulates these
 * keyed by `callId` until the corresponding `toolCallCompleted`
 * arrives.
 *
 * `chunk` is plain text. The dispatcher decides how to chunk —
 * line-buffered, time-buffered, or whatever fits the tool. Empty
 * chunks are valid (e.g. a heartbeat) but should be rare.
 *
 * For tools that produce output as one atomic blob (read_file,
 * list_directory), this event may not fire at all — the output goes
 * straight to `toolCallCompleted.result.uiPayload`.
 */
export interface ToolCallOutputEvent extends ToolEventHeader {
    type: 'toolCallOutput';
    chunk: string;
}

/**
 * Tool call completed. Carries the final result (success or failure)
 * plus durationMs for UI display ("ran in 4.2s").
 *
 * Status semantics:
 *   - `success` — tool ran to completion with no error
 *   - `error`   — tool encountered an error during execution. The
 *                 error is captured in `result.uiPayload` (kind:
 *                 'error') and `result.llmContent` (a string the LLM
 *                 can reason about). Per Q5=5D, errors propagate to
 *                 the LLM via the next message's tool_result content;
 *                 there's no retry layer.
 *   - `cancelled` — tool was aborted before completion (Q5=5B
 *                 per-task cancel). UI may render differently.
 *
 * Note: `durationMs` is from started → completed wall time. Useful
 * for "this took longer than expected" UI hints in v1.1 but not
 * required functionality for 2B-1.
 */
export interface ToolCallCompletedEvent extends ToolEventHeader {
    type: 'toolCallCompleted';
    status: 'success' | 'error' | 'cancelled';
    result: ToolDispatchResult;
    durationMs: number;
}

/**
 * Discriminated union of all tool lifecycle events. Switch on `type`
 * to narrow.
 */
export type ToolLifecycleEvent =
    | ToolCallStartedEvent
    | ToolCallOutputEvent
    | ToolCallCompletedEvent;

// ─── Helpers for emitters ────────────────────────────────────────────

/**
 * Construct a started event. The seq is intentionally left to the
 * dispatch layer to stamp — emitters should not assign seq themselves
 * lest concurrent emitters drift.
 *
 * Why `Omit<..., 'seq'>` rather than `Partial`: we want emitters to
 * be FORCED to omit seq, not OPTIONALLY omit it. Type signature
 * encodes the protocol invariant.
 */
export type EmittedEvent = Omit<ToolLifecycleEvent, 'seq'>;