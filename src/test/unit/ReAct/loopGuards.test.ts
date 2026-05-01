// src/test/unit/ReAct/loopGuards.test.ts
//
// Unit tests for the ReAct hardening guards (StuckLoopDetector,
// DispatchCache, TotalCallBudget). These are pure logic — no LLM,
// no filesystem, no mocks needed.
//
// Each guard's behavior is locked in here so we can refactor the
// engine's main loop with confidence that the hardening semantics
// don't drift.

import {
    StuckLoopDetector,
    DispatchCache,
    TotalCallBudget
} from '../../../agents/ReAct/loopGuards';
import {
    ReActStuckLoopError,
    ReActBudgetExceededError
} from '../../../agents/ReAct/ReActConfig';
import type { ToolCall } from '../../../llm';

// ─── Helper to build minimal ToolCall fixtures ────────────────────────
function tc(name: string, args: string, id: string = 'call_' + name): ToolCall {
    return {
        id,
        type: 'function' as const,
        function: { name, arguments: args }
    };
}

describe('StuckLoopDetector', () => {
    test('produces stable signature regardless of tool-call order', () => {
        const detector = new StuckLoopDetector();
        const sig1 = detector.computeSignature([
            tc('read_file', '{"filepath":"a.ts"}'),
            tc('list_directory', '{"dirpath":"src"}')
        ]);
        const sig2 = detector.computeSignature([
            tc('list_directory', '{"dirpath":"src"}'),
            tc('read_file', '{"filepath":"a.ts"}')
        ]);
        expect(sig1).toBe(sig2);
    });

    test('signatures differ when arguments differ', () => {
        const detector = new StuckLoopDetector();
        const sig1 = detector.computeSignature([tc('read_file', '{"filepath":"a.ts"}')]);
        const sig2 = detector.computeSignature([tc('read_file', '{"filepath":"b.ts"}')]);
        expect(sig1).not.toBe(sig2);
    });

    test('checkAndRecord throws ReActStuckLoopError on repeated signature', () => {
        const detector = new StuckLoopDetector();
        const sig = detector.computeSignature([tc('read_file', '{"filepath":"a.ts"}')]);
        detector.checkAndRecord(sig); // first turn — records, doesn't throw
        expect(() => detector.checkAndRecord(sig)).toThrow(ReActStuckLoopError);
    });

    test('checkAndRecord does not throw when signatures differ across turns', () => {
        const detector = new StuckLoopDetector();
        detector.checkAndRecord(
            detector.computeSignature([tc('read_file', '{"filepath":"a.ts"}')])
        );
        // Different signature next turn — should NOT throw.
        expect(() => detector.checkAndRecord(
            detector.computeSignature([tc('read_file', '{"filepath":"b.ts"}')])
        )).not.toThrow();
    });

    test('reset clears the prior signature so a chatty intermission is forgiven', () => {
        const detector = new StuckLoopDetector();
        const sig = detector.computeSignature([tc('read_file', '{"filepath":"a.ts"}')]);
        detector.checkAndRecord(sig);
        detector.reset();
        // After reset, the same sig is allowed again.
        expect(() => detector.checkAndRecord(sig)).not.toThrow();
    });

    test('empty signature is not flagged as stuck even if repeated', () => {
        // Empty signatures happen on tool-free turns, which we
        // explicitly tolerate. Otherwise back-to-back chatty turns
        // would trigger false positives.
        const detector = new StuckLoopDetector();
        detector.checkAndRecord("");
        expect(() => detector.checkAndRecord("")).not.toThrow();
    });
});

describe('DispatchCache', () => {
    test('priorTurn returns undefined for a new call', () => {
        const cache = new DispatchCache();
        expect(cache.priorTurn(tc('read_file', '{"filepath":"a.ts"}'))).toBeUndefined();
    });

    test('record + priorTurn round-trip preserves the turn number', () => {
        const cache = new DispatchCache();
        const call = tc('read_file', '{"filepath":"a.ts"}');
        cache.record(call, 3);
        expect(cache.priorTurn(call)).toBe(3);
    });

    test('different argument JSON produces different cache key (no false dedup)', () => {
        const cache = new DispatchCache();
        cache.record(tc('read_file', '{"filepath":"a.ts"}'), 0);
        // Whitespace-only difference in JSON should NOT collide — the
        // key is the raw arguments string (not normalized).
        expect(cache.priorTurn(tc('read_file', '{"filepath": "a.ts"}'))).toBeUndefined();
    });

    test('has() reflects record() state', () => {
        const cache = new DispatchCache();
        const call = tc('list_directory', '{"dirpath":"src"}');
        expect(cache.has(call)).toBe(false);
        cache.record(call, 0);
        expect(cache.has(call)).toBe(true);
    });

    test('size() reflects number of distinct cached calls', () => {
        const cache = new DispatchCache();
        expect(cache.size()).toBe(0);
        cache.record(tc('read_file', '{"filepath":"a.ts"}'), 0);
        cache.record(tc('read_file', '{"filepath":"b.ts"}'), 0);
        cache.record(tc('read_file', '{"filepath":"a.ts"}'), 1); // duplicate key
        expect(cache.size()).toBe(2);
    });

    test('buildCachedMessage tells the model to stop and emit', () => {
        const msg = DispatchCache.buildCachedMessage(2);
        expect(msg).toMatch(/already dispatched/i);
        expect(msg).toMatch(/turn 3/); // 2 + 1 = 3 (1-indexed display)
        expect(msg).toMatch(/Do not repeat/i);
        expect(msg).toMatch(/emit the final output/i);
    });

    test('keyFor matches the same format produced by StuckLoopDetector', () => {
        // The two systems agree on what "same call" means.
        const call = tc('read_file', '{"filepath":"a.ts"}');
        const cacheKey = DispatchCache.keyFor(call);
        expect(cacheKey).toBe('read_file::{"filepath":"a.ts"}');
    });
});

describe('TotalCallBudget', () => {
    test('does not throw when staying under the limit', () => {
        const budget = new TotalCallBudget(10);
        expect(() => budget.checkBeforeDispatch([
            tc('read_file', '{}'),
            tc('list_directory', '{}')
        ])).not.toThrow();
    });

    test('throws ReActBudgetExceededError when next batch would exceed limit', () => {
        const budget = new TotalCallBudget(3);
        budget.record(2);
        // 2 (already dispatched) + 2 (in this batch) = 4 > 3
        expect(() => budget.checkBeforeDispatch([
            tc('read_file', '{}'),
            tc('list_directory', '{}')
        ])).toThrow(ReActBudgetExceededError);
    });

    test('total() reports cumulative dispatched count', () => {
        const budget = new TotalCallBudget(30);
        expect(budget.total()).toBe(0);
        budget.record(5);
        expect(budget.total()).toBe(5);
        budget.record(3);
        expect(budget.total()).toBe(8);
    });

    test('error diagnosis identifies "re-reading" pattern when most calls are dedup hits', () => {
        const budget = new TotalCallBudget(2);
        budget.record(2);
        const cache = new DispatchCache();
        cache.record(tc('read_file', '{"filepath":"a.ts"}'), 0);
        cache.record(tc('read_file', '{"filepath":"b.ts"}'), 0);
        try {
            budget.checkBeforeDispatch([
                tc('read_file', '{"filepath":"a.ts"}'),
                tc('read_file', '{"filepath":"b.ts"}')
            ], cache);
            fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(ReActBudgetExceededError);
            expect((e as ReActBudgetExceededError).diagnosis).toMatch(/re-reading/i);
        }
    });

    test('error diagnosis identifies "search" pattern when most calls are searches', () => {
        const budget = new TotalCallBudget(2);
        budget.record(2);
        try {
            budget.checkBeforeDispatch([
                tc('search_codebase', '{"keyword":"x"}'),
                tc('search_codebase', '{"keyword":"y"}')
            ]);
            fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(ReActBudgetExceededError);
            expect((e as ReActBudgetExceededError).diagnosis).toMatch(/search_codebase/i);
        }
    });

    test('error diagnosis falls through to generic when no pattern dominates', () => {
        const budget = new TotalCallBudget(2);
        budget.record(2);
        try {
            budget.checkBeforeDispatch([
                tc('read_file', '{"filepath":"a"}'),
                tc('list_directory', '{"dirpath":"b"}')
            ]);
            fail('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(ReActBudgetExceededError);
            expect((e as ReActBudgetExceededError).diagnosis).toMatch(/exploring without converging/i);
        }
    });

    test('error message includes both the budget and the dispatched count', () => {
        const budget = new TotalCallBudget(5);
        budget.record(4);
        try {
            budget.checkBeforeDispatch([
                tc('read_file', '{}'),
                tc('list_directory', '{}')
            ]);
            fail('should have thrown');
        } catch (e) {
            const err = e as ReActBudgetExceededError;
            expect(err.totalDispatched).toBe(4);
            expect(err.budget).toBe(5);
            expect(err.message).toContain('5');
        }
    });
});