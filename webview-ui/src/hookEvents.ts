// webview-ui/src/hookEvents.ts
//
// PR P1.4: frontend mirror of the backend hookProtocol types + the
// reducer that accumulates per-fire state from the event stream.
//
// Direct parallel of toolEvents.ts. See that file's preamble for the
// rationale on hand-mirroring backend types instead of importing.
//
// Backend source of truth: src/hooks/hookProtocol.ts
// Sync invariant: when backend types change, this file changes too.

// ─── Lifecycle events (mirror of backend HookLifecycleEvent) ────────

export type HookTriggerType = 'onFileSave' | 'onCommand' | 'onSchedule';

interface HookEventHeader {
    hookFireId: string;
    hookId: string;
    hookName: string;
    seq: number;
    timestamp: number;
}

export interface HookFireStartedEvent extends HookEventHeader {
    type: 'hookFireStarted';
    triggerType: HookTriggerType;
    filePath?: string;
}

export interface HookFireOutputEvent extends HookEventHeader {
    type: 'hookFireOutput';
    chunk: string;
}

export interface HookFireCompletedEvent extends HookEventHeader {
    type: 'hookFireCompleted';
    status: 'success' | 'error' | 'timeout' | 'skipped';
    durationMs: number;
    errorMessage?: string;
}

export type HookLifecycleEvent =
    | HookFireStartedEvent
    | HookFireOutputEvent
    | HookFireCompletedEvent;

// ─── Per-fire accumulated state ─────────────────────────────────────

/**
 * State the HookFireCard renders from. Built up as events arrive:
 *
 *   1. hookFireStarted → state created with status='running' and an
 *      empty output buffer
 *   2. hookFireOutput → chunk appended to output buffer (typically one
 *      single-chunk emission today; streaming-capable in the future)
 *   3. hookFireCompleted → status set to terminal value, durationMs
 *      filled, errorMessage captured if present
 *
 * Out-of-order tolerance mirrors toolEvents.ts: if output or completed
 * arrives before started (rare; can happen across a slow webview
 * message channel), placeholder state is synthesized with hookName='?'
 * and the next started event upgrades it.
 */
export interface HookFireState {
    hookFireId: string;
    hookId: string;
    hookName: string;
    triggerType: HookTriggerType;
    /** File path (workspace-relative) when triggerType === 'onFileSave'. */
    filePath?: string;
    status: 'running' | 'success' | 'error' | 'timeout' | 'skipped';
    /** First seq seen for this fire — used for stable sort order in the
     *  cards region. */
    startSeq: number;
    /** Accumulated chunks from hookFireOutput events. Markdown OK. */
    outputBuffer: string;
    /** Wall-clock duration ms; set when terminal event arrives. */
    durationMs?: number;
    /** Cause for status ∈ {error, timeout, skipped}. */
    errorMessage?: string;
    /** Started timestamp for fallback "running for Xs" display. */
    startedAt: number;
}

/**
 * Reducer: apply one HookLifecycleEvent to the state map. Returns a
 * NEW map (immutable update) so React's referential-equality
 * short-circuit works correctly.
 *
 * Forward-compat: unknown event types are silently ignored. A newer
 * host can add event types without crashing an older webview bundle.
 */
export function applyHookEvent(
    state: Map<string, HookFireState>,
    event: HookLifecycleEvent
): Map<string, HookFireState> {
    const next = new Map(state);
    const existing = next.get(event.hookFireId);

    if (event.type === 'hookFireStarted') {
        next.set(event.hookFireId, {
            hookFireId: event.hookFireId,
            hookId: event.hookId,
            hookName: event.hookName,
            triggerType: event.triggerType,
            ...(event.filePath !== undefined ? { filePath: event.filePath } : {}),
            status: 'running',
            startSeq: event.seq,
            outputBuffer: existing?.outputBuffer ?? '',
            startedAt: event.timestamp
        });
    } else if (event.type === 'hookFireOutput') {
        if (existing) {
            next.set(event.hookFireId, {
                ...existing,
                outputBuffer: existing.outputBuffer + event.chunk
            });
        } else {
            // Out-of-order placeholder. The next started event will
            // upgrade it. Rare in practice.
            next.set(event.hookFireId, {
                hookFireId: event.hookFireId,
                hookId: event.hookId,
                hookName: event.hookName,
                triggerType: 'onCommand',
                status: 'running',
                startSeq: event.seq,
                outputBuffer: event.chunk,
                startedAt: event.timestamp
            });
        }
    } else if (event.type === 'hookFireCompleted') {
        if (existing) {
            next.set(event.hookFireId, {
                ...existing,
                status: event.status,
                durationMs: event.durationMs,
                ...(event.errorMessage !== undefined
                    ? { errorMessage: event.errorMessage }
                    : {})
            });
        } else {
            // Completed arrived without started. Synthesize.
            next.set(event.hookFireId, {
                hookFireId: event.hookFireId,
                hookId: event.hookId,
                hookName: event.hookName,
                triggerType: 'onCommand',
                status: event.status,
                startSeq: event.seq,
                outputBuffer: '',
                durationMs: event.durationMs,
                ...(event.errorMessage !== undefined
                    ? { errorMessage: event.errorMessage }
                    : {}),
                startedAt: event.timestamp - event.durationMs
            });
        }
    }
    // Unknown event type → silently ignored (forward-compat).

    return next;
}

/**
 * Sort hook fires by startSeq so the chat-thread region renders them
 * in the order they fired. We sort by startedAt as the secondary key
 * because seq is per-fire (always 0 for started), not global.
 */
export function sortedHookFires(state: Map<string, HookFireState>): HookFireState[] {
    const out = Array.from(state.values());
    out.sort((a, b) => a.startedAt - b.startedAt);
    return out;
}