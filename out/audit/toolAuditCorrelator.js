"use strict";
// src/audit/toolAuditCorrelator.ts
//
// D11: tool-call audit correlation.
//
// The tool-event lifecycle has three event types (started / output /
// completed). For audit logging, we need ONE record per tool invocation
// with both the input (from started) and the output/status (from
// completed). This module owns that correlation:
//
//   - started → buffer (tool name, input args)
//   - output  → ignore (intermediate streaming chunks)
//   - completed → look up buffered started, build full ToolCallPayload,
//                 hand to a logging callback, evict the buffer entry
//
// Lives outside SidebarProvider so it's testable without vscode mocking.
// SidebarProvider holds an instance of this and feeds it events from
// the ToolEventEmitter sink.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolAuditCorrelator = void 0;
/**
 * Per-instance audit correlator. Construct once per SidebarProvider
 * (one per VS Code window). Holds a buffer of in-flight tool calls.
 *
 * NOT thread-safe — assumes events arrive serially through the sink
 * callback, which is true for the single ToolEventEmitter that owns it.
 */
class ToolAuditCorrelator {
    /**
     * Cap on buffer size. Bounds memory if `completed` events get lost
     * (e.g., process crash mid-task and restart with same SidebarProvider
     * instance — extremely rare). 1000 in-flight tool calls already
     * indicates a bug elsewhere; this is a leak guard, not a feature.
     */
    static DEFAULT_BUFFER_CAP = 1000;
    buffer = new Map();
    sink;
    cap;
    constructor(sink, cap = ToolAuditCorrelator.DEFAULT_BUFFER_CAP) {
        this.sink = sink;
        this.cap = cap;
    }
    /**
     * Process a single tool lifecycle event. Started events buffer;
     * completed events flush; output events are ignored.
     */
    handleEvent(event) {
        if (event.type === 'toolCallStarted') {
            this.handleStarted(event);
            return;
        }
        if (event.type === 'toolCallCompleted') {
            this.handleCompleted(event);
            return;
        }
        // toolCallOutput: streaming chunks are not audited. The
        // completed event's outputPreview captures what the LLM
        // ultimately saw, which is what compliance review needs.
    }
    handleStarted(event) {
        // Evict oldest entry if buffer is full. Map preserves insertion
        // order, so keys().next().value is the oldest.
        if (this.buffer.size >= this.cap) {
            const oldestKey = this.buffer.keys().next().value;
            if (oldestKey !== undefined) {
                this.buffer.delete(oldestKey);
            }
        }
        this.buffer.set(event.callId, {
            tool: event.name,
            input: event.arguments,
            startedAt: event.timestamp,
        });
    }
    handleCompleted(event) {
        const started = this.buffer.get(event.callId);
        if (!started) {
            // Completed without matching started — shouldn't happen
            // under normal operation. Skip rather than emit a partial
            // record (audit records should be self-consistent).
            return;
        }
        this.buffer.delete(event.callId);
        // Map completion status to ToolCallPayload's status enum.
        // ToolCallCompletedEvent uses 'success' | 'error' | 'cancelled'.
        // ToolCallPayload uses 'ok' | 'error' | 'aborted'.
        let status;
        if (event.status === 'success')
            status = 'ok';
        else if (event.status === 'error')
            status = 'error';
        else
            status = 'aborted';
        // Output preview: ToolCallPayload spec is "first 500 chars".
        // Use llmContent (the text the LLM sees) — for structured
        // payloads (diff, file_contents, etc.) llmContent is already
        // rendered as text.
        const outputPreview = event.result.llmContent.length > 500
            ? event.result.llmContent.slice(0, 500)
            : event.result.llmContent;
        // Pull error message from error-kind payloads. For success
        // and cancelled completions, errorMessage stays undefined.
        let errorMessage;
        if (event.status === 'error' && event.result.uiPayload.kind === 'error') {
            errorMessage = event.result.uiPayload.message;
        }
        const payload = {
            tool: started.tool,
            input: started.input,
            status,
            outputPreview,
        };
        if (errorMessage !== undefined) {
            payload.errorMessage = errorMessage;
        }
        this.sink(payload);
    }
    /**
     * Get the current buffer size. Tests use this to verify eviction
     * and entry-removal-on-completion. Production code shouldn't need it.
     */
    bufferSizeForTesting() {
        return this.buffer.size;
    }
    /**
     * Get whether a specific callId is currently buffered. Tests use
     * this to verify entries are removed after completion.
     */
    hasBufferedForTesting(callId) {
        return this.buffer.has(callId);
    }
}
exports.ToolAuditCorrelator = ToolAuditCorrelator;
//# sourceMappingURL=toolAuditCorrelator.js.map