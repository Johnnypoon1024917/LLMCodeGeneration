// src/test/unit/toolEventEmitter.test.ts
//
// Tests for the seq-stamping event emitter (Component 2B-3, Q3=3C).

jest.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { fs: { stat: jest.fn(), readFile: jest.fn() } },
    FileType: { Directory: 2, File: 1, SymbolicLink: 64 }
}));

import { ToolEventEmitter } from '../../agents/toolEventEmitter';
import type { ToolLifecycleEvent } from '../../agents/toolProtocol';

describe('ToolEventEmitter — seq stamping', () => {
    let captured: ToolLifecycleEvent[];
    let emitter: ToolEventEmitter;

    beforeEach(() => {
        captured = [];
        emitter = new ToolEventEmitter((e) => captured.push(e));
    });

    test('first event for a task gets seq=0', () => {
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-1',
            callId: 'c1',
            source: 'coordinator',
            timestamp: Date.now(),
            name: 'read_file',
            arguments: {}
        });

        expect(captured[0]?.seq).toBe(0);
    });

    test('subsequent events for the same task increment seq', () => {
        for (let i = 0; i < 5; i++) {
            emitter.emit({
                type: 'toolCallOutput',
                taskId: 'task-1',
                callId: `c${i}`,
                source: 'coordinator',
                timestamp: Date.now(),
                chunk: `chunk ${i}`
            });
        }

        expect(captured.map(e => e.seq)).toEqual([0, 1, 2, 3, 4]);
    });

    test('seq counters are independent per taskId', () => {
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-A',
            callId: 'a1', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-B',
            callId: 'b1', source: 'coordinator',
            timestamp: Date.now(),
            name: 'bar', arguments: {}
        });
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-A',
            callId: 'a2', source: 'coordinator',
            timestamp: Date.now(),
            name: 'baz', arguments: {}
        });

        // Per-task ordering: task-A should be 0, 1; task-B should be 0
        expect(captured[0]?.seq).toBe(0); // task-A
        expect(captured[1]?.seq).toBe(0); // task-B
        expect(captured[2]?.seq).toBe(1); // task-A
    });

    test('resetTask clears one task without affecting others', () => {
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-X',
            callId: 'x1', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-Y',
            callId: 'y1', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });

        emitter.resetTask('task-X');

        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-X',
            callId: 'x2', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });
        emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-Y',
            callId: 'y2', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });

        // x2 should restart at 0 (task-X was reset), y2 continues at 1
        expect(captured[2]?.seq).toBe(0);
        expect(captured[3]?.seq).toBe(1);
    });

    test('emit returns the stamped event for inspection', () => {
        const stamped = emitter.emit({
            type: 'toolCallStarted',
            taskId: 'task-1',
            callId: 'c1', source: 'coordinator',
            timestamp: Date.now(),
            name: 'foo', arguments: {}
        });

        expect(stamped.seq).toBe(0);
        expect(stamped.taskId).toBe('task-1');
        expect(stamped.callId).toBe('c1');
    });

    test('sink throwing does not crash emit', () => {
        const throwingEmitter = new ToolEventEmitter(() => {
            throw new Error('sink error');
        });

        // Should not throw — agent's main flow must continue even if
        // the sink (postMessage, audit log, etc.) fails.
        expect(() => {
            throwingEmitter.emit({
                type: 'toolCallStarted',
                taskId: 'task-1',
                callId: 'c1', source: 'coordinator',
                timestamp: Date.now(),
                name: 'foo', arguments: {}
            });
        }).not.toThrow();
    });
});