"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchWithEvents = dispatchWithEvents;
const toolRegistry_1 = require("./toolRegistry");
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
async function dispatchWithEvents(toolCall, ctx, options) {
    const source = options.source ?? 'coordinator';
    const taskId = options.taskId ?? '';
    const callId = toolCall.id;
    const startTime = Date.now();
    // Parse args once for the started event. If parsing fails we
    // skip the event (the registry will surface the error result
    // directly) — emitting a started event we can't parse seems worse.
    let parsedArgs = {};
    try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
    }
    catch {
        // Args malformed — let the registry handle the error path.
        return (0, toolRegistry_1.dispatchTool)(toolCall, ctx);
    }
    // Pre-dispatch security check.
    if (options.preDispatchHook) {
        const verdict = await options.preDispatchHook(toolCall, parsedArgs);
        if (verdict.blocked) {
            const reason = verdict.reason ?? 'Blocked by policy';
            // Emit started + completed for UI consistency: the user
            // sees the attempt and the block in the same place.
            if (options.emitter) {
                const blockedStarted = {
                    type: 'toolCallStarted',
                    taskId, callId, source,
                    timestamp: startTime,
                    name: toolCall.function.name,
                    arguments: parsedArgs
                };
                options.emitter.emit(blockedStarted);
                const blockedCompleted = {
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
    // V2.1.2 spec-fix-12 — Bug #1: pre-dispatch approval check.
    // Runs AFTER security (so denied-by-policy never reaches the user)
    // but BEFORE the started event (so we don't render a "running"
    // card for a tool we never actually ran). The hook decides
    // internally whether the call needs UI prompting or auto-approves.
    if (options.approvalHook) {
        // Emit started early so the user sees the pending approval as
        // a card alongside whatever they're being asked. UI uses the
        // pending-approval marker on the tool call to show the buttons.
        if (options.emitter) {
            const startedForApproval = {
                type: 'toolCallStarted',
                taskId, callId, source,
                timestamp: startTime,
                name: toolCall.function.name,
                arguments: parsedArgs
            };
            options.emitter.emit(startedForApproval);
        }
        const approved = await options.approvalHook(toolCall, parsedArgs);
        if (!approved) {
            const reason = 'Edit rejected by user';
            if (options.emitter) {
                const rejectedCompleted = {
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
                options.emitter.emit(rejectedCompleted);
            }
            return {
                llmContent: `Rejected: ${reason}. The user did not approve this edit. Stop or propose an alternative.`,
                uiPayload: { kind: 'error', message: reason }
            };
        }
        // Approved — fall through. We already emitted started, so the
        // normal path below should NOT re-emit.
    }
    // Emit started event before the dispatch.
    // (Skipped if approvalHook already emitted started above — the call
    // was approved and we don't want a duplicate started event.)
    if (options.emitter && !options.approvalHook) {
        const startedEvent = {
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
    const wrappedCtx = {
        ...ctx,
        onOutputChunk: (chunk) => {
            if (options.emitter) {
                const outputEvent = {
                    type: 'toolCallOutput',
                    taskId, callId, source,
                    timestamp: Date.now(),
                    chunk
                };
                options.emitter.emit(outputEvent);
            }
            if (callerChunkHandler) {
                try {
                    callerChunkHandler(chunk);
                }
                catch { /* don't crash on caller bugs */ }
            }
        }
    };
    // Honor caller's signal if any.
    if (ctx.signal) {
        wrappedCtx.signal = ctx.signal;
    }
    let result;
    let status = 'success';
    try {
        result = await (0, toolRegistry_1.dispatchTool)(toolCall, wrappedCtx);
        // Inspect uiPayload to decide success vs error. The registry
        // returns kind='error' for tool-level failures.
        if (result.uiPayload.kind === 'error') {
            status = 'error';
        }
    }
    catch (e) {
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
        const completedEvent = {
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
//# sourceMappingURL=toolDispatchWithEvents.js.map