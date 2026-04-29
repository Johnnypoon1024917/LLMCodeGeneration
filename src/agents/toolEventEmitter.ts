// src/agents/toolEventEmitter.ts
//
// Component 2B-3: seq-stamping event emitter.
//
// Per Q3=3C lock: all `ToolLifecycleEvent`s carry monotonic seq numbers
// per task. The seq is assigned CENTRALLY (here) rather than by each
// emitter, because:
//
//   - A single task can have multiple concurrent emitters (Coordinator's
//     ReAct loop, Verifier in 2B-5, future sub-agents). If each emitter
//     generated its own seq, ordering would drift.
//   - The protocol type system enforces this: emitters create
//     `EmittedEvent = Omit<ToolLifecycleEvent, 'seq'>` and trust the
//     emitter to stamp. The compiler catches drift if a future
//     contributor tries to set seq directly.
//
// The emitter is stateful per-task: it tracks the next seq for each
// taskId. It's owned by SidebarProvider (the single point that
// postMessages the webview) and passed down to Coordinator via the
// ctx pattern.
//
// Lifecycle of an event:
//   1. Coordinator wraps a dispatchTool call
//   2. Coordinator creates an EmittedEvent (no seq)
//   3. Coordinator calls emitter.emit(eventNoSeq)
//   4. Emitter assigns the next seq for this taskId
//   5. Emitter forwards the stamped event to its sink callback
//   6. SidebarProvider's sink callback postMessages to webview

import type {
    ToolLifecycleEvent
} from './toolProtocol';

/**
 * Sink callback signature. Receives stamped events ready for dispatch
 * (typically postMessage to the webview). The sink can throw or
 * return synchronously; the emitter doesn't care about completion —
 * it's fire-and-forget.
 */
export type ToolEventSink = (event: ToolLifecycleEvent) => void;

/**
 * Per-task seq counter + sink dispatch. One instance per session
 * (typically owned by SidebarProvider).
 */
export class ToolEventEmitter {
    /** seq counters keyed by taskId. Each task starts at seq=0. */
    private readonly seqByTask = new Map<string, number>();
    private readonly sink: ToolEventSink;

    constructor(sink: ToolEventSink) {
        this.sink = sink;
    }

    /**
     * Stamp the event with the next seq for its taskId, then forward
     * to the sink. Returns the stamped event for callers that want
     * to inspect what was emitted (mostly tests).
     *
     * Accepts any of the three event variants without seq. Not
     * `EmittedEvent` (which is the discriminated union) because
     * TypeScript can't infer which variant from a constructed object
     * literal — the union breaks excess-property checks. The intersect-
     * ion of "all three variants" is what we want at the API boundary.
     */
    emit(event:
        | Omit<import('./toolProtocol').ToolCallStartedEvent, 'seq'>
        | Omit<import('./toolProtocol').ToolCallOutputEvent, 'seq'>
        | Omit<import('./toolProtocol').ToolCallCompletedEvent, 'seq'>
    ): ToolLifecycleEvent {
        const next = (this.seqByTask.get(event.taskId) ?? 0);
        this.seqByTask.set(event.taskId, next + 1);
        const stamped = { ...event, seq: next } as ToolLifecycleEvent;
        try {
            this.sink(stamped);
        } catch {
            // Sink threw — don't crash the agent. The event is lost
            // for this dispatch but the agent's main flow continues.
            // In practice the sink is postMessage which doesn't throw,
            // but tests may install assertions that throw.
        }
        return stamped;
    }

    /**
     * Reset the seq counter for a specific task. Used when a task
     * is restarted or when the user explicitly clears its history.
     * Most code shouldn't call this — the counter is per-task and
     * task IDs should be unique-per-run anyway.
     */
    resetTask(taskId: string): void {
        this.seqByTask.delete(taskId);
    }

    /**
     * Reset ALL counters. Used in tests for isolation.
     */
    resetAllForTesting(): void {
        this.seqByTask.clear();
    }
}

/**
 * Convenience factory. Mirrors the pattern of getProvider() in
 * `src/llm/index.ts`. Tests typically construct emitters directly
 * with their own sink rather than using this.
 */
export function createToolEventEmitter(sink: ToolEventSink): ToolEventEmitter {
    return new ToolEventEmitter(sink);
}