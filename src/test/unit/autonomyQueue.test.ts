// webview-ui/src/test/unit/autonomyQueue.test.ts
//
// Tests for autonomy queue decision logic. Pure functions, no React,
// no DOM. Covers every branch of advanceAutonomyQueue and
// buildInitialAutonomyQueue.
//
// Why this exists: the queue advancement logic in App.tsx's message
// handler is hard to test directly (event bus + React state). Pulling
// the decision logic into a pure module means we can hit every branch
// here without spinning up the UI.

import { describe, test, expect } from 'vitest';
import {
    advanceAutonomyQueue,
    buildInitialAutonomyQueue,
} from '../../autonomyQueue';

describe('advanceAutonomyQueue — terminal-state decision logic', () => {
    test('approved + head matches → advance with remaining queue', () => {
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0', 'task-1', 'task-2'],
            completedTask: 'task-0',
            status: 'approved',
            haltRequested: false,
        });
        expect(decision.action).toBe('advance');
        if (decision.action === 'advance') {
            expect(decision.nextQueue).toEqual(['task-1', 'task-2']);
            expect(decision.nextTaskKey).toBe('task-1');
        }
    });

    test('approved + last in queue → finish with empty queue', () => {
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-2'],
            completedTask: 'task-2',
            status: 'approved',
            haltRequested: false,
        });
        expect(decision.action).toBe('finish');
        if (decision.action === 'finish') {
            expect(decision.nextQueue).toEqual([]);
        }
    });

    test('rejected → halt with reason "rejected"', () => {
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0', 'task-1'],
            completedTask: 'task-0',
            status: 'rejected',
            haltRequested: false,
        });
        expect(decision.action).toBe('halt');
        if (decision.action === 'halt') {
            expect(decision.reason).toBe('rejected');
            expect(decision.failedTask).toBe('task-0');
        }
    });

    test('error → halt with reason "error"', () => {
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0'],
            completedTask: 'task-0',
            status: 'error',
            haltRequested: false,
        });
        expect(decision.action).toBe('halt');
        if (decision.action === 'halt') {
            expect(decision.reason).toBe('error');
        }
    });

    test('halt requested → ignore even if status would advance', () => {
        // User clicked Halt between dispatch and completion. Even if
        // the task succeeded, we don't advance — they've explicitly
        // chosen to stop.
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0', 'task-1'],
            completedTask: 'task-0',
            status: 'approved',
            haltRequested: true,
        });
        expect(decision.action).toBe('ignore');
    });

    test('halt requested → ignore even if status would halt', () => {
        // Halt + reject is the same outcome (ignore) — user already
        // owns the stop decision.
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0'],
            completedTask: 'task-0',
            status: 'rejected',
            haltRequested: true,
        });
        expect(decision.action).toBe('ignore');
    });

    test('empty queue → ignore (stale completion)', () => {
        // Late completion from a task dispatched before halt, OR
        // a manually-clicked plan-mode task while autonomy queue
        // is empty. Either way, nothing to do.
        const decision = advanceAutonomyQueue({
            prevQueue: [],
            completedTask: 'task-0',
            status: 'approved',
            haltRequested: false,
        });
        expect(decision.action).toBe('ignore');
    });

    test('completion does not match queue head → ignore', () => {
        // Defensive: the task that completed is not the one we're
        // waiting for. Could happen with click-races or stray events
        // from a different session. Don't advance — we don't know
        // what to do.
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0', 'task-1'],
            completedTask: 'task-99',
            status: 'approved',
            haltRequested: false,
        });
        expect(decision.action).toBe('ignore');
    });

    test('approved + head matches but second-from-head also "completed" — only head decides', () => {
        // Even if events somehow arrive for task-1 while task-0 is
        // still queue head, we reject task-1's event as "doesn't
        // match head" and wait for task-0's actual event.
        const decision = advanceAutonomyQueue({
            prevQueue: ['task-0', 'task-1'],
            completedTask: 'task-1',
            status: 'approved',
            haltRequested: false,
        });
        expect(decision.action).toBe('ignore');
    });
});

describe('buildInitialAutonomyQueue — start-from-mid-list semantics', () => {
    test('all tasks unstarted → all in queue', () => {
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1', 'task-2'],
            {}
        );
        expect(queue).toEqual(['task-0', 'task-1', 'task-2']);
    });

    test('skips approved tasks (resume from middle)', () => {
        // User ran tasks 0 and 1 in plan mode, switched to autonomy,
        // clicked Run All — should resume at task-2.
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1', 'task-2', 'task-3'],
            { 'task-0': 'approved', 'task-1': 'approved' }
        );
        expect(queue).toEqual(['task-2', 'task-3']);
    });

    test('rejected tasks re-enter queue (allows retry-from-failure)', () => {
        // Failed task: include for re-run. The autonomy loop will
        // reset its UI state via dispatchTaskExecution.
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1'],
            { 'task-0': 'rejected' }
        );
        expect(queue).toEqual(['task-0', 'task-1']);
    });

    test('error-state tasks re-enter queue', () => {
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1'],
            { 'task-0': 'error' }
        );
        expect(queue).toEqual(['task-0', 'task-1']);
    });

    test('preserves order when skipping', () => {
        // Order-preservation matters: tasks usually have implicit
        // dependencies. task-3 should not run before task-2.
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1', 'task-2', 'task-3'],
            { 'task-1': 'approved' }
        );
        expect(queue).toEqual(['task-0', 'task-2', 'task-3']);
    });

    test('all tasks already approved → empty queue', () => {
        const queue = buildInitialAutonomyQueue(
            ['task-0', 'task-1'],
            { 'task-0': 'approved', 'task-1': 'approved' }
        );
        expect(queue).toEqual([]);
    });

    test('empty input → empty queue', () => {
        expect(buildInitialAutonomyQueue([], {})).toEqual([]);
    });
});