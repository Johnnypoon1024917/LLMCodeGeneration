// webview-ui/src/test/unit/thinkingModeState.test.ts
//
// Tests for thinking-mode aggregate state + bulk-toggle decision logic.
// Pure functions, no React, no DOM.

import { describe, test, expect } from 'vitest';
import {
    aggregateThinkingState,
    bulkToggleFromState,
} from '../../thinkingModeState';

describe('aggregateThinkingState', () => {
    test('all three on → "on"', () => {
        expect(aggregateThinkingState({
            planner: true, coder: true, verifier: true,
        })).toBe('on');
    });

    test('all three off → "off"', () => {
        expect(aggregateThinkingState({
            planner: false, coder: false, verifier: false,
        })).toBe('off');
    });

    test('only planner off → "mixed"', () => {
        expect(aggregateThinkingState({
            planner: false, coder: true, verifier: true,
        })).toBe('mixed');
    });

    test('only coder off → "mixed"', () => {
        expect(aggregateThinkingState({
            planner: true, coder: false, verifier: true,
        })).toBe('mixed');
    });

    test('only verifier off → "mixed"', () => {
        expect(aggregateThinkingState({
            planner: true, coder: true, verifier: false,
        })).toBe('mixed');
    });

    test('two of three off → "mixed"', () => {
        expect(aggregateThinkingState({
            planner: false, coder: false, verifier: true,
        })).toBe('mixed');
    });

    test('only verifier on → "mixed"', () => {
        // Reasonable real-world config: speed up Planner+Coder for
        // interactive feel, but keep Verifier accurate for compliance.
        expect(aggregateThinkingState({
            planner: false, coder: false, verifier: true,
        })).toBe('mixed');
    });
});

describe('bulkToggleFromState', () => {
    test('"on" → all flip to false', () => {
        expect(bulkToggleFromState('on')).toEqual({
            planner: false, coder: false, verifier: false,
        });
    });

    test('"off" → all flip to true', () => {
        expect(bulkToggleFromState('off')).toEqual({
            planner: true, coder: true, verifier: true,
        });
    });

    test('"mixed" → all flip to false (most common user intent)', () => {
        // From a mixed state, the most common click intent is "I
        // want to turn off all this thinking, give me speed". The
        // alternative (mixed → on) would surprise users who
        // deliberately turned off ONE agent — clicking the pill
        // would re-enable their customization. Mixed → off is
        // less surprising.
        expect(bulkToggleFromState('mixed')).toEqual({
            planner: false, coder: false, verifier: false,
        });
    });

    test('toggle round-trip from on → off → on', () => {
        // Starting with all on, click → all off → click → all on
        const after1 = bulkToggleFromState(
            aggregateThinkingState({ planner: true, coder: true, verifier: true })
        );
        expect(after1).toEqual({ planner: false, coder: false, verifier: false });

        const after2 = bulkToggleFromState(aggregateThinkingState(after1));
        expect(after2).toEqual({ planner: true, coder: true, verifier: true });
    });

    test('toggle from mixed clears customization (predictable behavior)', () => {
        // User had {planner: true, coder: false, verifier: true} → mixed.
        // Clicking the pill should NOT preserve "coder: false" — the
        // expectation is "this button sets all three to the same value".
        // After click → all-off; after second click → all-on (NOT
        // restoring the prior mixed state).
        const start = { planner: true, coder: false, verifier: true };
        const state1 = aggregateThinkingState(start);
        expect(state1).toBe('mixed');

        const after1 = bulkToggleFromState(state1);
        expect(after1).toEqual({ planner: false, coder: false, verifier: false });

        const after2 = bulkToggleFromState(aggregateThinkingState(after1));
        expect(after2).toEqual({ planner: true, coder: true, verifier: true });
    });
});