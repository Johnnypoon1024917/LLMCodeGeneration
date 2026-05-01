// src/test/unit/applyToolEvent.test.ts
//
// Tests for `applyToolEvent`, the reducer that builds tool-card state
// from lifecycle events streamed by the backend. Covers:
//   - Normal happy-path flow: started → output (multiple) → completed
//   - Out-of-order events: output arriving before started
//   - Out-of-order events: completed arriving before started
//   - Output continuing to accumulate after completed
//   - Unknown event types ignored (forward-compat)
//   - Immutability: the old map is not mutated
//
// `applyToolEvent` is on the critical path for every tool-card render.
// Bugs here silently corrupt or lose card state. Worth exhaustive
// coverage.

import { describe, test, expect } from 'vitest';
import { applyToolEvent, type ToolCallState, type ToolLifecycleEvent } from '../../toolEvents';

// Minimal event factories. Only fields the reducer reads are populated.
function startedEvent(overrides: Partial<{
    callId: string; taskId: string; seq: number; name: string;
    args: Record<string, unknown>; timestamp: number;
}> = {}): ToolLifecycleEvent {
    return {
        type: 'toolCallStarted',
        callId: overrides.callId ?? 'call-1',
        taskId: overrides.taskId ?? 'task-1',
        seq: overrides.seq ?? 0,
        source: 'coordinator',
        timestamp: overrides.timestamp ?? 1000,
        name: overrides.name ?? 'read_file',
        arguments: overrides.args ?? { path: '/tmp/x.ts' },
    };
}

function outputEvent(overrides: Partial<{
    callId: string; taskId: string; seq: number; chunk: string; timestamp: number;
}> = {}): ToolLifecycleEvent {
    return {
        type: 'toolCallOutput',
        callId: overrides.callId ?? 'call-1',
        taskId: overrides.taskId ?? 'task-1',
        seq: overrides.seq ?? 1,
        source: 'coordinator',
        timestamp: overrides.timestamp ?? 1010,
        chunk: overrides.chunk ?? 'partial output',
    };
}

function completedEvent(overrides: Partial<{
    callId: string; taskId: string; seq: number; status: 'success' | 'error' | 'cancelled';
    durationMs: number; timestamp: number;
}> = {}): ToolLifecycleEvent {
    return {
        type: 'toolCallCompleted',
        callId: overrides.callId ?? 'call-1',
        taskId: overrides.taskId ?? 'task-1',
        seq: overrides.seq ?? 2,
        source: 'coordinator',
        timestamp: overrides.timestamp ?? 1100,
        status: overrides.status ?? 'success',
        durationMs: overrides.durationMs ?? 100,
        result: { llmContent: 'done', uiPayload: { kind: 'string', content: 'done' } },
    };
}

describe('applyToolEvent — happy path', () => {
    test('toolCallStarted creates a new card with status=running', () => {
        const state = new Map<string, ToolCallState>();
        const next = applyToolEvent(state, startedEvent({ callId: 'c1', name: 'read_file' }));

        expect(next.size).toBe(1);
        const card = next.get('c1')!;
        expect(card).toMatchObject({
            callId: 'c1',
            taskId: 'task-1',
            name: 'read_file',
            status: 'running',
            outputBuffer: '',
            startSeq: 0,
        });
    });

    test('toolCallOutput appends to outputBuffer of existing card', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1' }));
        state = applyToolEvent(state, outputEvent({ callId: 'c1', chunk: 'first ' }));
        state = applyToolEvent(state, outputEvent({ callId: 'c1', chunk: 'second' }));

        const card = state.get('c1')!;
        expect(card.outputBuffer).toBe('first second');
        expect(card.status).toBe('running');
    });

    test('toolCallCompleted sets status, result, and durationMs', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1' }));
        state = applyToolEvent(state, completedEvent({ callId: 'c1', status: 'success', durationMs: 250 }));

        const card = state.get('c1')!;
        expect(card.status).toBe('success');
        expect(card.durationMs).toBe(250);
        expect(card.result).toBeDefined();
    });

    test('error status preserved through completion', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1' }));
        state = applyToolEvent(state, completedEvent({ callId: 'c1', status: 'error' }));
        expect(state.get('c1')!.status).toBe('error');
    });

    test('cancelled status preserved through completion', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1' }));
        state = applyToolEvent(state, completedEvent({ callId: 'c1', status: 'cancelled' }));
        expect(state.get('c1')!.status).toBe('cancelled');
    });
});

describe('applyToolEvent — out-of-order events', () => {
    test('output before started creates placeholder, started upgrades it', () => {
        let state = new Map<string, ToolCallState>();
        // Output arrives FIRST (race condition in postMessage delivery).
        state = applyToolEvent(state, outputEvent({ callId: 'c1', chunk: 'early' }));
        const placeholder = state.get('c1')!;
        expect(placeholder.name).toBe('?');
        expect(placeholder.outputBuffer).toBe('early');

        // Started arrives second — should upgrade name + args, preserve buffer.
        state = applyToolEvent(state, startedEvent({ callId: 'c1', name: 'read_file' }));
        const upgraded = state.get('c1')!;
        expect(upgraded.name).toBe('read_file');
        expect(upgraded.outputBuffer).toBe('early'); // buffer preserved
        expect(upgraded.status).toBe('running');
    });

    test('completed before started synthesizes a placeholder card', () => {
        const state = new Map<string, ToolCallState>();
        const next = applyToolEvent(state, completedEvent({ callId: 'c1', status: 'error', durationMs: 50 }));
        // Edge-case event arrives without prior started — reducer should
        // still create a card so the user sees SOMETHING about the failure.
        const card = next.get('c1')!;
        expect(card).toBeDefined();
        expect(card.name).toBe('?');
        expect(card.status).toBe('error');
        expect(card.durationMs).toBe(50);
    });

    test('output continues to accumulate after completed', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1' }));
        state = applyToolEvent(state, completedEvent({ callId: 'c1' }));
        // Late output event — should still append, not be dropped.
        state = applyToolEvent(state, outputEvent({ callId: 'c1', chunk: 'late' }));

        expect(state.get('c1')!.outputBuffer).toBe('late');
        expect(state.get('c1')!.status).toBe('success'); // status retained from completion
    });
});

describe('applyToolEvent — multiple cards', () => {
    test('events for different callIds maintain separate state', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1', name: 'read_file', seq: 0 }));
        state = applyToolEvent(state, startedEvent({ callId: 'c2', name: 'write_file', seq: 1 }));
        state = applyToolEvent(state, outputEvent({ callId: 'c1', chunk: 'A' }));
        state = applyToolEvent(state, outputEvent({ callId: 'c2', chunk: 'B' }));

        expect(state.size).toBe(2);
        expect(state.get('c1')!.outputBuffer).toBe('A');
        expect(state.get('c2')!.outputBuffer).toBe('B');
        expect(state.get('c1')!.name).toBe('read_file');
        expect(state.get('c2')!.name).toBe('write_file');
    });

    test('startSeq preserves first-seen ordering', () => {
        let state = new Map<string, ToolCallState>();
        state = applyToolEvent(state, startedEvent({ callId: 'c1', seq: 5 }));
        state = applyToolEvent(state, startedEvent({ callId: 'c2', seq: 3 }));
        state = applyToolEvent(state, startedEvent({ callId: 'c3', seq: 7 }));

        // Cards sorted by startSeq should be c2 (3), c1 (5), c3 (7).
        const sorted = Array.from(state.values()).sort((a, b) => a.startSeq - b.startSeq);
        expect(sorted.map(c => c.callId)).toEqual(['c2', 'c1', 'c3']);
    });
});

describe('applyToolEvent — immutability', () => {
    test('original state map is not mutated', () => {
        const original = new Map<string, ToolCallState>();
        original.set('c1', {
            callId: 'c1', taskId: 'task-1', name: 'old', args: {},
            source: 'coordinator', status: 'running', startSeq: 0,
            outputBuffer: 'pre', startedAt: 0
        });

        applyToolEvent(original, outputEvent({ callId: 'c1', chunk: 'new' }));

        // The ORIGINAL map's card still has the OLD buffer. The reducer
        // returned a new map; the input was untouched.
        expect(original.get('c1')!.outputBuffer).toBe('pre');
    });

    test('returns a new Map instance, not the same reference', () => {
        const state = new Map<string, ToolCallState>();
        const next = applyToolEvent(state, startedEvent());
        expect(next).not.toBe(state);
    });
});

describe('applyToolEvent — forward-compat', () => {
    test('unknown event types are silently ignored', () => {
        const state = new Map<string, ToolCallState>();
        // TypeScript would normally reject this, but we cast through
        // unknown to test the runtime behavior. Older webviews receiving
        // events from newer backends should ignore unknown types.
        const fakeEvent = {
            type: 'toolCallSomethingNew',
            callId: 'c1',
            taskId: 'task-1',
            seq: 0,
            source: 'coordinator',
            timestamp: 0,
        } as unknown as ToolLifecycleEvent;

        const next = applyToolEvent(state, fakeEvent);
        // No card created, no crash, just identity.
        expect(next.size).toBe(0);
    });
});