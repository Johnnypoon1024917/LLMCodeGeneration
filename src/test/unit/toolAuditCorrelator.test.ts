// src/test/unit/toolAuditCorrelator.test.ts
//
// Unit tests for ToolAuditCorrelator (D11).
//
// What we test:
//   - started events buffer, don't trigger sink
//   - output events are ignored
//   - completed events flush the buffer and call sink with correct payload
//   - status mapping: success → 'ok', error → 'error', cancelled → 'aborted'
//   - error completions extract errorMessage from error-kind payload
//   - outputPreview truncates to 500 chars
//   - completed without matching started silently drops (no partial records)
//   - buffer cap evicts oldest entries when full
//   - buffer entries are removed after completion (no leak)
//
// What we don't test:
//   - SidebarProvider's wiring of the correlator (vscode-dependent;
//     covered by integration testing in the dev host)
//   - AuditLog's own behavior (covered by auditLog.test.ts)

import { ToolAuditCorrelator } from '../../audit/toolAuditCorrelator';
import type { ToolCallPayload } from '../../audit/types';
import type {
    ToolCallStartedEvent,
    ToolCallOutputEvent,
    ToolCallCompletedEvent,
    ToolDispatchResult
} from '../../agents/toolProtocol';

/**
 * Build a started event with sensible defaults. Tests override what they
 * care about and let other fields take stable defaults.
 */
function startedEvent(overrides: Partial<ToolCallStartedEvent> = {}): ToolCallStartedEvent {
    return {
        type: 'toolCallStarted',
        taskId: 'task-1',
        callId: 'call-1',
        seq: 0,
        source: 'coordinator',
        timestamp: 1000,
        name: 'read_file',
        arguments: { filepath: 'src/index.ts' },
        ...overrides,
    };
}

/** Build a successful completed event. */
function completedEvent(overrides: Partial<ToolCallCompletedEvent> = {}): ToolCallCompletedEvent {
    const defaultResult: ToolDispatchResult = {
        llmContent: 'file contents here',
        uiPayload: { kind: 'string', content: 'file contents here' },
    };
    return {
        type: 'toolCallCompleted',
        taskId: 'task-1',
        callId: 'call-1',
        seq: 1,
        source: 'coordinator',
        timestamp: 2000,
        status: 'success',
        result: defaultResult,
        durationMs: 1000,
        ...overrides,
    };
}

function outputEvent(overrides: Partial<ToolCallOutputEvent> = {}): ToolCallOutputEvent {
    return {
        type: 'toolCallOutput',
        taskId: 'task-1',
        callId: 'call-1',
        seq: 1,
        source: 'coordinator',
        timestamp: 1500,
        chunk: 'partial output',
        ...overrides,
    };
}

describe('ToolAuditCorrelator — basic correlation', () => {
    test('started event alone does NOT trigger sink', () => {
        const sink = jest.fn();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());

        expect(sink).not.toHaveBeenCalled();
        // But the event was buffered, ready for completion.
        expect(correlator.bufferSizeForTesting()).toBe(1);
        expect(correlator.hasBufferedForTesting('call-1')).toBe(true);
    });

    test('output event is ignored', () => {
        const sink = jest.fn();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(outputEvent());

        expect(sink).not.toHaveBeenCalled();
        // Buffer still has the started; output didn't disturb it.
        expect(correlator.bufferSizeForTesting()).toBe(1);
    });

    test('started + completed triggers sink with correlated payload', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent({
            name: 'bash_exec',
            arguments: { command: 'ls -la' },
        }));
        correlator.handleEvent(completedEvent({
            result: {
                llmContent: 'total 8\ndrwx...',
                uiPayload: { kind: 'bash_output', stdout: 'total 8\ndrwx...', stderr: '', exitCode: 0, durationMs: 50 },
            },
        }));

        expect(sink).toHaveBeenCalledTimes(1);
        const payload = sink.mock.calls[0]![0]!;
        expect(payload.tool).toBe('bash_exec');
        expect(payload.input).toEqual({ command: 'ls -la' });
        expect(payload.status).toBe('ok');
        expect(payload.outputPreview).toBe('total 8\ndrwx...');
        expect(payload.errorMessage).toBeUndefined();
    });

    test('buffer entry is evicted after completion', () => {
        const sink = jest.fn();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        expect(correlator.bufferSizeForTesting()).toBe(1);

        correlator.handleEvent(completedEvent());
        expect(correlator.bufferSizeForTesting()).toBe(0);
        expect(correlator.hasBufferedForTesting('call-1')).toBe(false);
    });
});

describe('ToolAuditCorrelator — status mapping', () => {
    test('success status maps to "ok"', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({ status: 'success' }));

        expect(sink.mock.calls[0]![0]!.status).toBe('ok');
    });

    test('error status maps to "error" and extracts errorMessage', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            status: 'error',
            result: {
                llmContent: 'Error: ENOENT',
                uiPayload: { kind: 'error', message: 'File not found: foo.ts' },
            },
        }));

        const payload = sink.mock.calls[0]![0]!;
        expect(payload.status).toBe('error');
        expect(payload.errorMessage).toBe('File not found: foo.ts');
    });

    test('cancelled status maps to "aborted" with no errorMessage', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            status: 'cancelled',
            result: {
                llmContent: 'cancelled',
                uiPayload: { kind: 'string', content: 'cancelled' },
            },
        }));

        const payload = sink.mock.calls[0]![0]!;
        expect(payload.status).toBe('aborted');
        expect(payload.errorMessage).toBeUndefined();
    });

    test('error status without error-kind payload still records status but no errorMessage', () => {
        // Defensive: a completed event with status:'error' but a non-error
        // uiPayload kind is unusual but possible. Status should still map
        // to 'error'; errorMessage stays undefined since we have nowhere
        // to extract it from.
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            status: 'error',
            result: {
                llmContent: 'something went wrong',
                uiPayload: { kind: 'string', content: 'something went wrong' },
            },
        }));

        const payload = sink.mock.calls[0]![0]!;
        expect(payload.status).toBe('error');
        expect(payload.errorMessage).toBeUndefined();
    });
});

describe('ToolAuditCorrelator — output preview', () => {
    test('outputs ≤ 500 chars are passed through unchanged', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        const shortContent = 'a'.repeat(500);
        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            result: { llmContent: shortContent, uiPayload: { kind: 'string', content: shortContent } },
        }));

        expect(sink.mock.calls[0]![0]!.outputPreview).toBe(shortContent);
        expect(sink.mock.calls[0]![0]!.outputPreview!.length).toBe(500);
    });

    test('outputs > 500 chars are truncated to first 500', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        const longContent = 'a'.repeat(1000);
        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            result: { llmContent: longContent, uiPayload: { kind: 'string', content: longContent } },
        }));

        const preview = sink.mock.calls[0]![0]!.outputPreview!;
        expect(preview.length).toBe(500);
        expect(preview).toBe('a'.repeat(500));
    });

    test('empty output is preserved as empty string (not undefined)', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        correlator.handleEvent(startedEvent());
        correlator.handleEvent(completedEvent({
            result: { llmContent: '', uiPayload: { kind: 'string', content: '' } },
        }));

        expect(sink.mock.calls[0]![0]!.outputPreview).toBe('');
    });
});

describe('ToolAuditCorrelator — edge cases', () => {
    test('completed without matching started silently drops', () => {
        const sink = jest.fn();
        const correlator = new ToolAuditCorrelator(sink);

        // No started event. Completed arrives anyway (e.g., process restart
        // mid-task lost the in-memory started state).
        correlator.handleEvent(completedEvent());

        expect(sink).not.toHaveBeenCalled();
        // Buffer remains empty — we don't store completed events without
        // their started counterpart.
        expect(correlator.bufferSizeForTesting()).toBe(0);
    });

    test('multiple concurrent calls correlate by callId', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        // Two tools start in parallel.
        correlator.handleEvent(startedEvent({ callId: 'call-A', name: 'read_file', arguments: { filepath: 'a.ts' } }));
        correlator.handleEvent(startedEvent({ callId: 'call-B', name: 'grep', arguments: { pattern: 'foo' } }));
        expect(correlator.bufferSizeForTesting()).toBe(2);

        // call-B completes first (out-of-order is fine).
        correlator.handleEvent(completedEvent({
            callId: 'call-B',
            result: { llmContent: 'no matches', uiPayload: { kind: 'string', content: 'no matches' } },
        }));
        // call-A completes second.
        correlator.handleEvent(completedEvent({
            callId: 'call-A',
            result: { llmContent: 'file content', uiPayload: { kind: 'string', content: 'file content' } },
        }));

        expect(sink).toHaveBeenCalledTimes(2);
        // First sink call was for call-B (grep).
        expect(sink.mock.calls[0]![0]!.tool).toBe('grep');
        expect(sink.mock.calls[0]![0]!.input).toEqual({ pattern: 'foo' });
        // Second sink call was for call-A (read_file).
        expect(sink.mock.calls[1]![0]!.tool).toBe('read_file');
        expect(sink.mock.calls[1]![0]!.input).toEqual({ filepath: 'a.ts' });
        // Both buffers cleared.
        expect(correlator.bufferSizeForTesting()).toBe(0);
    });

    test('buffer cap evicts oldest entries when full', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        // Tiny cap for testability.
        const correlator = new ToolAuditCorrelator(sink, 3);

        correlator.handleEvent(startedEvent({ callId: 'call-1' }));
        correlator.handleEvent(startedEvent({ callId: 'call-2' }));
        correlator.handleEvent(startedEvent({ callId: 'call-3' }));
        expect(correlator.bufferSizeForTesting()).toBe(3);

        // Adding a 4th started exceeds cap; oldest (call-1) is evicted.
        correlator.handleEvent(startedEvent({ callId: 'call-4' }));
        expect(correlator.bufferSizeForTesting()).toBe(3);
        expect(correlator.hasBufferedForTesting('call-1')).toBe(false);
        expect(correlator.hasBufferedForTesting('call-2')).toBe(true);
        expect(correlator.hasBufferedForTesting('call-3')).toBe(true);
        expect(correlator.hasBufferedForTesting('call-4')).toBe(true);

        // The evicted call-1 now has no buffer entry. If its completion
        // arrives later, it's silently dropped (no partial records).
        correlator.handleEvent(completedEvent({ callId: 'call-1' }));
        expect(sink).not.toHaveBeenCalled();
    });

    test('preserves complex input shapes (nested objects)', () => {
        const sink = jest.fn<void, [ToolCallPayload]>();
        const correlator = new ToolAuditCorrelator(sink);

        const complexArgs = {
            filepath: 'src/foo.ts',
            options: {
                encoding: 'utf-8',
                limits: { maxLines: 100, maxBytes: 50000 },
            },
            patterns: ['^import', '^export'],
        };

        correlator.handleEvent(startedEvent({ arguments: complexArgs }));
        correlator.handleEvent(completedEvent());

        expect(sink.mock.calls[0]![0]!.input).toEqual(complexArgs);
    });
});