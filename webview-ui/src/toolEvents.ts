// webview-ui/src/toolEvents.ts
//
// Component 2B-4: frontend mirror of the backend toolProtocol types.
//
// We can't directly import from `src/agents/toolProtocol.ts` because:
//   - The webview is built with vite separately from the extension host
//   - tsconfig paths don't bridge the two builds
//
// So this is a hand-mirrored copy. When backend types change, update
// here too. The shapes MUST stay in sync — the webview deserializes
// these events from postMessage, expecting exactly this shape.
//
// Backend source of truth: src/agents/toolProtocol.ts
//
// What we mirror:
//   - ToolResult (the structured uiPayload union)
//   - ToolCallStartedEvent / ToolCallOutputEvent / ToolCallCompletedEvent
//   - ToolLifecycleEvent (the union)
//   - ToolEventSource
//
// We also define:
//   - ToolCallState — accumulated state per callId, what cards render from
//   - ToolCallEventMessage — the postMessage envelope shape

// ─── Tool result encoding (mirror of backend ToolResult) ─────────────

export type ToolResult =
    | { kind: 'string'; content: string }
    | { kind: 'diff'; filepath: string; before: string; after: string }
    | { kind: 'file_contents'; filepath: string; content: string; truncated?: boolean }
    | { kind: 'search_matches'; matches: Array<{ filepath: string; line: number; text: string }> }
    | { kind: 'directory'; path: string; entries: Array<{ name: string; kind: 'file' | 'dir' | 'symlink' }> }
    | { kind: 'bash_output'; stdout: string; stderr: string; exitCode: number; durationMs: number }
    | { kind: 'error'; message: string; stack?: string };

export interface ToolDispatchResult {
    llmContent: string;
    uiPayload: ToolResult;
}

// ─── Lifecycle events (mirror of backend ToolLifecycleEvent) ─────────

export type ToolEventSource = 'coordinator' | 'planner' | 'verifier-internal';

interface ToolEventHeader {
    taskId: string;
    callId: string;
    seq: number;
    source: ToolEventSource;
    timestamp: number;
}

export interface ToolCallStartedEvent extends ToolEventHeader {
    type: 'toolCallStarted';
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolCallOutputEvent extends ToolEventHeader {
    type: 'toolCallOutput';
    chunk: string;
}

export interface ToolCallCompletedEvent extends ToolEventHeader {
    type: 'toolCallCompleted';
    status: 'success' | 'error' | 'cancelled';
    result: ToolDispatchResult;
    durationMs: number;
}

export type ToolLifecycleEvent =
    | ToolCallStartedEvent
    | ToolCallOutputEvent
    | ToolCallCompletedEvent;

// ─── Postmessage envelope (sent by SidebarProvider.getToolEventEmitter sink) ──

/**
 * Outer envelope for tool-call events arriving via postMessage.
 * SidebarProvider's emitter sink wraps stamped events in:
 *
 *     { type: 'toolCallEvent', event: <ToolLifecycleEvent> }
 *
 * The App.tsx message handler matches on `type === 'toolCallEvent'`
 * and dispatches the inner `event` to the tool-call state reducer.
 */
export interface ToolCallEventMessage {
    type: 'toolCallEvent';
    event: ToolLifecycleEvent;
}

// ─── Frontend-only state ─────────────────────────────────────────────

/**
 * Accumulated state for a single tool call. Cards render from this.
 *
 * Lifecycle:
 *   1. `toolCallStarted` arrives → state created with status='running',
 *      args populated from event.arguments
 *   2. `toolCallOutput` events arrive → outputBuffer appended (for
 *      streaming tools like bash_exec). For atomic tools (read_file)
 *      these never fire.
 *   3. `toolCallCompleted` arrives → status updated, result captured,
 *      durationMs filled in
 *
 * Out-of-order tolerance: if completed arrives before all output
 * events (rare but possible across a slow webview message channel),
 * the card just shows whatever output it has plus the completed
 * result. We don't try to merge result.uiPayload's output into the
 * outputBuffer — they're separate rendering paths.
 */
export interface ToolCallState {
    callId: string;
    taskId: string;
    name: string;
    args: Record<string, unknown>;
    source: ToolEventSource;
    status: 'running' | 'success' | 'error' | 'cancelled';
    /** First seq seen for this callId, for sort ordering. */
    startSeq: number;
    /** Accumulated stdout/stderr deltas from toolCallOutput events. */
    outputBuffer: string;
    /** Final result, populated when toolCallCompleted arrives. */
    result?: ToolDispatchResult;
    /** Wall-clock duration (ms) from started → completed. */
    durationMs?: number;
    /** Started timestamp, for fallback elapsed-time display while running. */
    startedAt: number;
}

/**
 * Apply a lifecycle event to the existing state map. Returns a NEW
 * map (immutable update) — React state updates work this way. The
 * old map is untouched so React's referential-equality short-circuit
 * works correctly for unrelated cards.
 *
 * Out-of-order events:
 *   - Output before started: the started event will arrive shortly
 *     (event ordering is per-task seq, but message channel may
 *     reorder within a single task). We create a placeholder state
 *     with name='?' that the next started event upgrades. Rare —
 *     in practice started always arrives first.
 *   - Completed before output: applied as normal. Output events
 *     arriving after completed are still appended (outputBuffer
 *     accumulates regardless of status).
 *
 * Unknown event types (forward-compat): silently ignored. The webview
 * may run an older bundle than the host extension; if the host adds a
 * new event type, the webview shouldn't crash.
 */
export function applyToolEvent(
    state: Map<string, ToolCallState>,
    event: ToolLifecycleEvent
): Map<string, ToolCallState> {
    const next = new Map(state);
    const existing = next.get(event.callId);

    if (event.type === 'toolCallStarted') {
        // Create or upgrade. If a placeholder exists (output arrived
        // first), preserve its outputBuffer.
        next.set(event.callId, {
            callId: event.callId,
            taskId: event.taskId,
            name: event.name,
            args: event.arguments,
            source: event.source,
            status: 'running',
            startSeq: event.seq,
            outputBuffer: existing?.outputBuffer ?? '',
            startedAt: event.timestamp
        });
    } else if (event.type === 'toolCallOutput') {
        if (existing) {
            next.set(event.callId, {
                ...existing,
                outputBuffer: existing.outputBuffer + event.chunk
            });
        } else {
            // Placeholder for out-of-order case. The next started
            // event will fill in the rest.
            next.set(event.callId, {
                callId: event.callId,
                taskId: event.taskId,
                name: '?',
                args: {},
                source: event.source,
                status: 'running',
                startSeq: event.seq,
                outputBuffer: event.chunk,
                startedAt: event.timestamp
            });
        }
    } else if (event.type === 'toolCallCompleted') {
        if (existing) {
            next.set(event.callId, {
                ...existing,
                status: event.status,
                result: event.result,
                durationMs: event.durationMs
            });
        } else {
            // Completed arrived without started — synthesize from event.
            // Edge case; we still render something.
            next.set(event.callId, {
                callId: event.callId,
                taskId: event.taskId,
                name: '?',
                args: {},
                source: event.source,
                status: event.status,
                startSeq: event.seq,
                outputBuffer: '',
                result: event.result,
                durationMs: event.durationMs,
                startedAt: event.timestamp - event.durationMs
            });
        }
    }
    // Unknown event type → silently ignored (forward-compat).

    return next;
}

/**
 * Get all tool calls for a given taskId, sorted by start order.
 * Used by the per-task render path to interleave cards with other
 * agent steps.
 */
export function toolCallsForTask(
    state: Map<string, ToolCallState>,
    taskId: string
): ToolCallState[] {
    const out: ToolCallState[] = [];
    for (const tc of state.values()) {
        if (tc.taskId === taskId) { out.push(tc); }
    }
    out.sort((a, b) => a.startSeq - b.startSeq);
    return out;
}