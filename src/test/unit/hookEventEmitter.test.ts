// src/test/unit/hookEventEmitter.test.ts
//
// PR P1.4: tests for the hook lifecycle emitter.
//
// Covers:
//   - seq stamping is monotonic per hookFireId, independent across fires
//   - sink receives stamped events
//   - sink errors don't crash subsequent emits
//   - forgetFire clears the seq counter for one fire without affecting others

import { HookEventEmitter } from '../../hooks/hookEventEmitter';
import type {
    HookLifecycleEvent,
    HookFireStartedEvent,
    HookFireOutputEvent,
    HookFireCompletedEvent
} from '../../hooks/hookProtocol';

function startedEvent(hookFireId: string, hookId = 'lint-on-save'): Omit<HookFireStartedEvent, 'seq'> {
    return {
        type: 'hookFireStarted',
        hookFireId,
        hookId,
        hookName: hookId,
        triggerType: 'onFileSave',
        timestamp: Date.now()
    };
}

function outputEvent(hookFireId: string, chunk: string): Omit<HookFireOutputEvent, 'seq'> {
    return {
        type: 'hookFireOutput',
        hookFireId,
        hookId: 'lint-on-save',
        hookName: 'lint-on-save',
        chunk,
        timestamp: Date.now()
    };
}

function completedEvent(
    hookFireId: string,
    status: HookFireCompletedEvent['status'] = 'success'
): Omit<HookFireCompletedEvent, 'seq'> {
    return {
        type: 'hookFireCompleted',
        hookFireId,
        hookId: 'lint-on-save',
        hookName: 'lint-on-save',
        status,
        durationMs: 250,
        timestamp: Date.now()
    };
}

describe('HookEventEmitter', () => {
    it('stamps events with monotonic seq per hookFireId', () => {
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => received.push(e));

        emitter.emit(startedEvent('fire-1'));
        emitter.emit(outputEvent('fire-1', 'output line 1'));
        emitter.emit(completedEvent('fire-1'));

        expect(received).toHaveLength(3);
        expect(received[0]!.seq).toBe(0);
        expect(received[1]!.seq).toBe(1);
        expect(received[2]!.seq).toBe(2);
    });

    it('keeps seq counters independent across different fires', () => {
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => received.push(e));

        // Interleave events from two fires
        emitter.emit(startedEvent('fire-1'));
        emitter.emit(startedEvent('fire-2'));
        emitter.emit(outputEvent('fire-1', 'a'));
        emitter.emit(outputEvent('fire-2', 'b'));
        emitter.emit(completedEvent('fire-1'));
        emitter.emit(completedEvent('fire-2'));

        // fire-1 should have seqs 0, 1, 2
        const fire1Seqs = received.filter((e) => e.hookFireId === 'fire-1').map((e) => e.seq);
        expect(fire1Seqs).toEqual([0, 1, 2]);

        // fire-2 should also have seqs 0, 1, 2 — independent counter
        const fire2Seqs = received.filter((e) => e.hookFireId === 'fire-2').map((e) => e.seq);
        expect(fire2Seqs).toEqual([0, 1, 2]);
    });

    it('forwards stamped events through the sink', () => {
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => received.push(e));

        const stamped = emitter.emit(startedEvent('fire-1'));

        expect(stamped.seq).toBe(0);
        expect(received).toHaveLength(1);
        expect(received[0]).toBe(stamped);
    });

    it('does not crash when sink throws', () => {
        let throws = true;
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => {
            if (throws) {
                throws = false;
                throw new Error('sink boom');
            }
            received.push(e);
        });

        // First emit triggers the throw — should not propagate
        expect(() => emitter.emit(startedEvent('fire-1'))).not.toThrow();

        // Second emit should still work
        emitter.emit(outputEvent('fire-1', 'recovered'));
        expect(received).toHaveLength(1);
        expect(received[0]!.type).toBe('hookFireOutput');
    });

    it('forgetFire clears seq counter for a specific fire', () => {
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => received.push(e));

        emitter.emit(startedEvent('fire-1'));
        emitter.emit(completedEvent('fire-1'));
        emitter.forgetFire('fire-1');

        // A re-emission with the same fire id starts at seq=0 again
        // (this isn't a real scenario but proves the counter was cleared)
        const stamped = emitter.emit(startedEvent('fire-1'));
        expect(stamped.seq).toBe(0);
    });

    it('forgetFire is a no-op for unknown fire ids', () => {
        const emitter = new HookEventEmitter(() => {});
        expect(() => emitter.forgetFire('never-existed')).not.toThrow();
    });

    it('preserves event payload fields through stamping', () => {
        const received: HookLifecycleEvent[] = [];
        const emitter = new HookEventEmitter((e) => received.push(e));

        const stamped = emitter.emit({
            type: 'hookFireStarted',
            hookFireId: 'fire-1',
            hookId: 'auto-format',
            hookName: 'Auto Format',
            triggerType: 'onFileSave',
            filePath: 'src/foo.ts',
            timestamp: 1234567
        });

        if (stamped.type !== 'hookFireStarted') { throw new Error('wrong type'); }
        expect(stamped.hookId).toBe('auto-format');
        expect(stamped.hookName).toBe('Auto Format');
        expect(stamped.triggerType).toBe('onFileSave');
        expect(stamped.filePath).toBe('src/foo.ts');
        expect(stamped.timestamp).toBe(1234567);
    });
});