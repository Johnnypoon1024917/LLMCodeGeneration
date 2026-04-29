// src/agents/toolDispatchWithEvents.ts
//
// Component 2B-3: wraps `dispatchTool` with lifecycle event emission
// and security policy hooks.
//
// The split between this file and `src/agents/toolRegistry.ts`:
//
//   - `toolRegistry` is mechanism: route by name, validate args,
//     call executor, return result.
//   - `toolDispatchWithEvents` is policy: emit events for the UI,
//     run pre-dispatch security checks, surface to audit log.
//
// Why separate: the registry is shared by all callers (Coordinator,
// planner, verifier in 2B-5). Each caller may want different policy.
// Coordinator does live UI events + Security Monitor for bash_exec;
// planner does silent dispatch (its own status updates suffice). The
// registry stays minimal; this file layers in policy.

import type { ToolCall } from '../llm';
import type {
    ToolDispatchResult,
    ToolCallStartedEvent,
    ToolCallOutputEvent,
    ToolCallCompletedEvent
} from './toolProtocol';
import {
    dispatchTool,
    type ToolExecutionContext
} from './toolRegistry';
import type { ToolEventEmitter } from './toolEventEmitter';

/**
 * Pre-dispatch hook. Returns true to BLOCK the dispatch, false to
 * ALLOW. Called for every tool call before the executor runs.
 *
 * Why a hook rather than an inline check: keeps the security policy
 * decoupled from the dispatch mechanism. The Coordinator passes a
 * hook that consults the Security Monitor for `bash_exec`; the
 * planner passes no hook (or an always-allow hook). Tests pass
 * scripted hooks for assertion.
 */
export type PreDispatchHook = (
    toolCall: ToolCall,
    args: Record<string, unknown>
) => Promise<{ blocked: boolean; reason?: string }>;

/**
 * Options for the wrapped dispatcher. All fields optional — when
 * absent, the wrapper degrades gracefully:
 *   - no emitter: events are dropped (silent dispatch)
 *   - no preDispatchHook: every call is allowed
 *   - no source: defaults to 'coordinator'
 */
export interface DispatchWithEventsOptions {
    /** Event emitter for lifecycle events. */
    emitter?: ToolEventEmitter;
    /** Pre-dispatch security hook. */
    preDispatchHook?: PreDispatchHook;
    /** Tag for the event `source` field (Q8=8C). Default 'coordinator'. */
    source?: 'coordinator' | 'planner' | 'verifier-internal';
    /** Task ID to attach to events. Required when emitter is provided. */
    taskId?: string;
}

/**
 * Dispatch a tool with full lifecycle event emission.
 *
 * Behavior:
 *   1. If a preDispatchHook is set and returns blocked=true:
 *      - Emit `toolCallStarted` (so UI shows the attempt)
 *      - Emit `toolCallCompleted` with status='error' carrying the
 *        block reason
 *      - Return an error result (LLM sees "blocked by Security
 *        Monitor: <reason>" in its message history)
 *   2. Otherwise:
 *      - Emit `toolCallStarted` with parsed args
 *      - Construct a ctx that wires `onOutputChunk` → `toolCallOutput`
 *        events
 *      - Call dispatchTool
 *      - Emit `toolCallCompleted` with the result
 *      - Return the result
 *
 * Caller's `ctx.onOutputChunk` callback is preserved if provided —
 * we chain it after our own event emission so callers that want to
 * accumulate output for their own logic still get the chunks.
 */
export async function dispatchWithEvents(
    toolCall: ToolCall,
    ctx: ToolExecutionContext,
    options: DispatchWithEventsOptions
): Promise<ToolDispatchResult> {
    const source = options.source ?? 'coordinator';
    const taskId = options.taskId ?? '';
    const callId = toolCall.id;
    const startTime = Date.now();

    // Parse args once for the started event. If parsing fails we
    // skip the event (the registry will surface the error result
    // directly) — emitting a started event we can't parse seems worse.
    let parsedArgs: Record<string, unknown> = {};
    try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
    } catch {
        // Args malformed — let the registry handle the error path.
        return dispatchTool(toolCall, ctx);
    }

    // Pre-dispatch security check.
    if (options.preDispatchHook) {
        const verdict = await options.preDispatchHook(toolCall, parsedArgs);
        if (verdict.blocked) {
            const reason = verdict.reason ?? 'Blocked by policy';
            // Emit started + completed for UI consistency: the user
            // sees the attempt and the block in the same place.
            if (options.emitter) {
                const blockedStarted: Omit<ToolCallStartedEvent, 'seq'> = {
                    type: 'toolCallStarted',
                    taskId, callId, source,
                    timestamp: startTime,
                    name: toolCall.function.name,
                    arguments: parsedArgs
                };
                options.emitter.emit(blockedStarted);
                const blockedCompleted: Omit<ToolCallCompletedEvent, 'seq'> = {
                    type: 'toolCallCompleted',
                    taskId, callId, source,
                    timestamp: Date.now(),
                    status: 'error',
                    durationMs: Date.now() - startTime,
                    result: {
                        llmContent: `Error: ${reason}`,
                        uiPayload: { kind: 'error', message: reason }
                    }
                };
                options.emitter.emit(blockedCompleted);
            }
            return {
                llmContent: `Blocked: ${reason}`,
                uiPayload: { kind: 'error', message: reason }
            };
        }
    }

    // Emit started event before the dispatch.
    if (options.emitter) {
        const startedEvent: Omit<ToolCallStartedEvent, 'seq'> = {
            type: 'toolCallStarted',
            taskId, callId, source,
            timestamp: startTime,
            name: toolCall.function.name,
            arguments: parsedArgs
        };
        options.emitter.emit(startedEvent);
    }

    // Wire onOutputChunk to emit toolCallOutput events. Preserve the
    // caller's chunk handler if any.
    const callerChunkHandler = ctx.onOutputChunk;
    const wrappedCtx: ToolExecutionContext = {
        ...ctx,
        onOutputChunk: (chunk: string) => {
            if (options.emitter) {
                const outputEvent: Omit<ToolCallOutputEvent, 'seq'> = {
                    type: 'toolCallOutput',
                    taskId, callId, source,
                    timestamp: Date.now(),
                    chunk
                };
                options.emitter.emit(outputEvent);
            }
            if (callerChunkHandler) {
                try { callerChunkHandler(chunk); } catch { /* don't crash on caller bugs */ }
            }
        }
    };

    // Honor caller's signal if any.
    if (ctx.signal) wrappedCtx.signal = ctx.signal;

    let result: ToolDispatchResult;
    let status: 'success' | 'error' | 'cancelled' = 'success';
    try {
        result = await dispatchTool(toolCall, wrappedCtx);
        // Inspect uiPayload to decide success vs error. The registry
        // returns kind='error' for tool-level failures.
        if (result.uiPayload.kind === 'error') {
            status = 'error';
        }
    } catch (e) {
        // Should not happen — dispatchTool catches executor exceptions
        // already. If we get here, it's something deeper (e.g. registry
        // throw on programmer error). Surface as error result.
        const msg = e instanceof Error ? e.message : String(e);
        result = {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
        status = 'error';
    }

    // Detect cancellation — if the signal was aborted during the
    // dispatch, we're cancelled regardless of how the executor
    // returned. Status takes precedence over success/error.
    if (ctx.signal?.aborted) {
        status = 'cancelled';
    }

    if (options.emitter) {
        const completedEvent: Omit<ToolCallCompletedEvent, 'seq'> = {
            type: 'toolCallCompleted',
            taskId, callId, source,
            timestamp: Date.now(),
            status,
            durationMs: Date.now() - startTime,
            result
        };
        options.emitter.emit(completedEvent);
    }

    return result;
}