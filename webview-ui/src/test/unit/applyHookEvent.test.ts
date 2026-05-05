// webview-ui/src/test/unit/applyHookEvent.test.ts
//
// PR P1.4: tests for `applyHookEvent`, the reducer that builds hook
// fire state from lifecycle events streamed by the backend. Covers:
//   - Normal happy-path flow: started → output → completed
//   - Out-of-order events: output before started; completed before started
//   - Output continuing to accumulate after completed
//   - Unknown event types ignored (forward-compat)
//   - Immutability: the old map is not mutated
//   - sortedHookFires returns fires by start time
//
// Direct port of applyToolEvent.test.ts patterns. The hook reducer
// has the same out-of-order handling but a slightly different state
// shape (no source, no callId — uses hookFireId).

import { describe, test, expect } from 'vitest';
import {
    applyHookEvent,
    sortedHookFires,
    type HookFireState,
    type HookLifecycleEvent
} from '../../hookEvents';

function startedEvent(overrides: Partial<{
    hookFireId: string;
    hookId: string;
    hookName: string;
    triggerType: 'onFileSave' | 'onCommand' | 'onSchedule';
    filePath: string;
    seq: number;
    timestamp: number;
}> = {}): HookLifecycleEvent {
    const base = {
        type: 'hookFireStarted' as const,
        hookFireId: 'fire-1',
        hookId: 'lint-on-save',
        hookName: 'Lint on save',
        triggerType: 'onFileSave' as const,
        seq: 0,
        timestamp: 1000
    };
    return { ...base, ...overrides };
}

function outputEvent(overrides: Partial<{
    hookFireId: string;
    hookId: string;
    hookName: string;
    chunk: string;
    seq: number;
    timestamp: number;
}> = {}): HookLifecycleEvent {
    return {
        type: 'hookFireOutput' as const,
        hookFireId: 'fire-1',
        hookId: 'lint-on-save',
        hookName: 'Lint on save',
        chunk: '',
        seq: 1,
        timestamp: 1100,
        ...overrides
    };
}

function completedEvent(overrides: Partial<{
    hookFireId: string;
    hookId: string;
    hookName: string;
    status: 'success' | 'error' | 'timeout' | 'skipped';
    durationMs: number;
    errorMessage: string;
    seq: number;
    timestamp: number;
}> = {}): HookLifecycleEvent {
    return {
        type: 'hookFireCompleted' as const,
        hookFireId: 'fire-1',
        hookId: 'lint-on-save',
        hookName: 'Lint on save',
        status: 'success' as const,
        durationMs: 250,
        seq: 2,
        timestamp: 1250,
        ...overrides
    };
}

describe('applyHookEvent — happy path', () => {
    test('started → output → completed produces the expected final state', () => {
        let state = new Map<string, HookFireState>();

        state = applyHookEvent(state, startedEvent({ filePath: 'src/foo.ts' }));
        state = applyHookEvent(state, outputEvent({ chunk: 'all good\n' }));
        state = applyHookEvent(state, completedEvent({ durationMs: 250 }));

        expect(state.size).toBe(1);
        const fire = state.get('fire-1')!;
        expect(fire.status).toBe('success');
        expect(fire.outputBuffer).toBe('all good\n');
        expect(fire.durationMs).toBe(250);
        expect(fire.filePath).toBe('src/foo.ts');
        expect(fire.triggerType).toBe('onFileSave');
    });

    test('multiple output chunks are concatenated in order', () => {
        let state = new Map<string, HookFireState>();
        state = applyHookEvent(state, startedEvent());
        state = applyHookEvent(state, outputEvent({ chunk: 'line 1\n', seq: 1 }));
        state = applyHookEvent(state, outputEvent({ chunk: 'line 2\n', seq: 2 }));
        state = applyHookEvent(state, outputEvent({ chunk: 'line 3\n', seq: 3 }));

        expect(state.get('fire-1')!.outputBuffer).toBe('line 1\nline 2\nline 3\n');
    });

    test('error status carries through with errorMessage', () => {
        let state = new Map<string, HookFireState>();
        state = applyHookEvent(state, startedEvent());
        state = applyHookEvent(state, completedEvent({
            status: 'error',
            errorMessage: 'LLM endpoint 500: server crashed'
        }));

        const fire = state.get('fire-1')!;
        expect(fire.status).toBe('error');
        expect(fire.errorMessage).toBe('LLM endpoint 500: server crashed');
    });
});

describe('applyHookEvent — out of order', () => {
    test('output before started creates placeholder, started upgrades', () => {
        let state = new Map<string, HookFireState>();

        // Output arrives first
        state = applyHookEvent(state, outputEvent({ chunk: 'early output' }));
        let fire = state.get('fire-1')!;
        expect(fire.outputBuffer).toBe('early output');
        expect(fire.status).toBe('running');

        // Started arrives — should upgrade with the real triggerType
        state = applyHookEvent(state, startedEvent({ triggerType: 'onCommand' }));
        fire = state.get('fire-1')!;
        // outputBuffer preserved through upgrade
        expect(fire.outputBuffer).toBe('early output');
        expect(fire.triggerType).toBe('onCommand');
    });

    test('completed before started synthesizes state from completed event', () => {
        let state = new Map<string, HookFireState>();

        state = applyHookEvent(state, completedEvent({
            status: 'timeout',
            durationMs: 60000,
            errorMessage: 'timed out after 60s'
        }));

        const fire = state.get('fire-1')!;
        expect(fire.status).toBe('timeout');
        expect(fire.durationMs).toBe(60000);
        expect(fire.errorMessage).toBe('timed out after 60s');
    });

    test('output arriving after completed still accumulates', () => {
        let state = new Map<string, HookFireState>();
        state = applyHookEvent(state, startedEvent());
        state = applyHookEvent(state, completedEvent({ status: 'success', durationMs: 200 }));
        state = applyHookEvent(state, outputEvent({ chunk: 'late output' }));

        const fire = state.get('fire-1')!;
        // Status should remain 'success' (terminal)
        expect(fire.status).toBe('success');
        // But output gets appended for forward-compat with future
        // streaming-after-completed scenarios
        expect(fire.outputBuffer).toBe('late output');
    });
});

describe('applyHookEvent — forward compat + immutability', () => {
    test('unknown event types are silently ignored', () => {
        let state = new Map<string, HookFireState>();
        state = applyHookEvent(state, startedEvent());

        // Cast-and-dispatch an event with an unknown type. The reducer
        // should leave state unchanged.
        const unknown = { type: 'hookSomethingNew', hookFireId: 'fire-1' } as unknown as HookLifecycleEvent;
        const after = applyHookEvent(state, unknown);

        // State map should be a NEW map (immutable update) but contain
        // the same entries as before
        expect(after.size).toBe(1);
        expect(after.get('fire-1')!.status).toBe('running');
    });

    test('reducer returns a NEW map; old map unchanged', () => {
        const before = new Map<string, HookFireState>();
        const after = applyHookEvent(before, startedEvent());

        expect(before).not.toBe(after);
        expect(before.size).toBe(0);
        expect(after.size).toBe(1);
    });
});

describe('sortedHookFires', () => {
    test('orders fires by startedAt ascending', () => {
        let state = new Map<string, HookFireState>();
        state = applyHookEvent(state, startedEvent({ hookFireId: 'fire-c', timestamp: 3000 }));
        state = applyHookEvent(state, startedEvent({ hookFireId: 'fire-a', timestamp: 1000 }));
        state = applyHookEvent(state, startedEvent({ hookFireId: 'fire-b', timestamp: 2000 }));

        const sorted = sortedHookFires(state);
        expect(sorted.map(f => f.hookFireId)).toEqual(['fire-a', 'fire-b', 'fire-c']);
    });

    test('returns empty array for empty state', () => {
        expect(sortedHookFires(new Map())).toEqual([]);
    });
});