// src/hooks/hookProtocol.ts
//
// PR P1.4: lifecycle events for hook firing. Mirrors the
// toolProtocol pattern but is a separate type because:
//
//   1. Hooks are NOT tool calls. They're triggered by file save,
//      schedule, or manual invocation — not invoked by the LLM.
//   2. They have no `arguments` object (a hook's prompt template is
//      part of the hook definition, not per-fire).
//   3. They have no LLM-visible result (hooks output to chat + audit,
//      not back into the agent's context).
//   4. The source discriminator is different ('hook' vs the
//      coordinator/planner/verifier-internal triad on tool events).
//
// Folding hooks into ToolLifecycleEvent would require adding nullable
// fields on every variant and would obscure intent at every consumer.
// A parallel protocol with the same shape language is cleaner.
//
// Wire format (host → webview):
//   { type: 'hookEvent', event: HookLifecycleEvent }
//
// The webview's reducer (hookEvents.ts) accumulates state by hookFireId
// the same way toolEvents.ts accumulates by callId.

/**
 * What triggered a hook to fire. Mirrors HookContext.triggerType from
 * HookSchema.ts so the UI can render the trigger reason without
 * needing to import the hook definition.
 */
export type HookTriggerType = 'onFileSave' | 'onCommand' | 'onSchedule';

/**
 * Common header on every hook event. `seq` is monotonic per
 * `hookFireId` (one fire = one card; events are inherently ordered
 * within a single fire). Unlike tool events which sequence per task
 * to capture interleaving across concurrent calls, hooks rarely
 * interleave with each other.
 */
export interface HookEventHeader {
    /** Unique identifier for this specific fire. UUIDv4. The webview
     *  uses this to key the rendered card. */
    hookFireId: string;
    /** The hook's id (filename without `.md`). Multiple fires of the
     *  same hook share this but have distinct hookFireId. */
    hookId: string;
    /** Human-readable hook name from the hook definition's frontmatter
     *  `name:` field. Falls back to hookId when absent. */
    hookName: string;
    /** Monotonic sequence within this fire. Started=0, output chunks
     *  starting at 1, completed last. */
    seq: number;
    /** Wall-clock timestamp (ms since epoch). Used for audit log
     *  correlation and the "ran at HH:MM:SS" header label. */
    timestamp: number;
}

/**
 * Hook fire started. Carries trigger context so the UI can render
 * "saved Foo.ts → ran lint-on-save".
 */
export interface HookFireStartedEvent extends HookEventHeader {
    type: 'hookFireStarted';
    triggerType: HookTriggerType;
    /** File path that triggered the fire, when applicable (onFileSave).
     *  Workspace-relative when possible. Null/absent for onCommand and
     *  onSchedule triggers. */
    filePath?: string;
}

/**
 * Hook produced output. Streamed in chunks for non-streaming hooks
 * we get one chunk; for future streaming implementations we may get
 * many. The UI accumulates by hookFireId.
 */
export interface HookFireOutputEvent extends HookEventHeader {
    type: 'hookFireOutput';
    /** Plain text chunk. Markdown OK; the UI uses the same renderer
     *  as the assistant message body. */
    chunk: string;
}

/**
 * Hook fire completed. Carries final status + duration.
 *
 * Status semantics:
 *   - 'success' — hook ran to completion, output is whatever was
 *                 streamed via output events
 *   - 'error'   — hook errored (LLM call failed, schema invalid, etc.).
 *                 errorMessage holds the human-readable cause.
 *   - 'timeout' — hook hit HOOK_FIRE_TIMEOUT_MS (60s currently). The
 *                 abort completed cleanly; no error message.
 *   - 'skipped' — fire was suppressed (concurrency cap, debounce).
 *                 Carries reason in errorMessage. Useful for the UI
 *                 to render a muted card explaining why.
 */
export interface HookFireCompletedEvent extends HookEventHeader {
    type: 'hookFireCompleted';
    status: 'success' | 'error' | 'timeout' | 'skipped';
    /** Wall-clock duration from started→completed (ms). */
    durationMs: number;
    /** Present on error/timeout/skipped. Absent on success. */
    errorMessage?: string;
}

export type HookLifecycleEvent =
    | HookFireStartedEvent
    | HookFireOutputEvent
    | HookFireCompletedEvent;

export type EmittedHookEvent = Omit<HookLifecycleEvent, 'seq'>;