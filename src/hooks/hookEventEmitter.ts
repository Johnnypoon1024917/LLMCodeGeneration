// src/hooks/hookEventEmitter.ts
//
// PR P1.4: seq-stamping emitter for hook lifecycle events.
//
// Direct port of ToolEventEmitter's design. Centralizes seq generation
// so events from a single fire arrive at the webview in monotonic
// order even if the emitter is shared across concurrent fires.
//
// The emitter is owned by SidebarProvider (same point that owns the
// tool emitter and dispatches postMessages). HookManager receives a
// reference via setEmitter() and emits events at fire boundaries.

import type {
    HookLifecycleEvent,
    HookFireStartedEvent,
    HookFireOutputEvent,
    HookFireCompletedEvent
} from './hookProtocol';

/** Sink callback. Receives stamped events ready for webview dispatch. */
export type HookEventSink = (event: HookLifecycleEvent) => void;

/**
 * Per-fire seq counter + sink dispatch.
 *
 * Why per-fire instead of per-hook-id: a hook can be fired twice in
 * quick succession (manual run during an autosave). The two fires
 * have different hookFireIds; their seqs must not interleave.
 */
export class HookEventEmitter {
    /** seq counters keyed by hookFireId. Each fire starts at seq=0. */
    private readonly seqByFire = new Map<string, number>();
    private readonly sink: HookEventSink;

    constructor(sink: HookEventSink) {
        this.sink = sink;
    }

    /**
     * Stamp the event with the next seq for its hookFireId, forward
     * to the sink. Returns the stamped event for tests that want to
     * inspect what was dispatched.
     *
     * Sink errors are caught — like the tool emitter, the sink is
     * fire-and-forget. A throwing sink (rare, mostly tests with
     * assertions) shouldn't crash the agent path.
     */
    emit(event:
        | Omit<HookFireStartedEvent, 'seq'>
        | Omit<HookFireOutputEvent, 'seq'>
        | Omit<HookFireCompletedEvent, 'seq'>
    ): HookLifecycleEvent {
        const next = (this.seqByFire.get(event.hookFireId) ?? 0);
        this.seqByFire.set(event.hookFireId, next + 1);
        const stamped = { ...event, seq: next } as HookLifecycleEvent;
        try {
            this.sink(stamped);
        } catch {
            // Sink threw — drop the event, continue. Same rationale
            // as ToolEventEmitter.
        }
        return stamped;
    }

    /**
     * Drop the seq counter for a fire that's confirmed completed.
     * Optional housekeeping; without this the map grows unboundedly
     * over a long-running session. Calling on an unknown id is a no-op.
     */
    forgetFire(hookFireId: string): void {
        this.seqByFire.delete(hookFireId);
    }
}