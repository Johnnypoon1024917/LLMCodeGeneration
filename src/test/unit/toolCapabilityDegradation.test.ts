// src/test/unit/toolCapabilityDegradation.test.ts
//
// Tests for the per-endpoint capability tracker that flips an
// endpoint into 'degraded' state after N consecutive responses with
// no native tool calls. This is the runtime detection path for
// misconfigured inference servers (most commonly Qwen 2.5 Coder on
// vLLM without --tool-call-parser hermes).
//
// Pure-logic tests — no network. Each test resets the cache so
// state from one test doesn't leak into another.

import {
    recordToolUsageResult,
    setToolCapability,
    resetToolCapabilityCache,
    getToolCapability,
} from '../../llm/OpenAICompatibleProvider';

const TEST_ENDPOINT = 'http://test.example.com:8001/v1/chat/completions';

describe('Tool capability degradation tracking', () => {
    beforeEach(() => {
        resetToolCapabilityCache();
    });

    test('starts with no cached capability', () => {
        expect(getToolCapability(TEST_ENDPOINT)).toBeUndefined();
    });

    test('one prose response does not trigger degradation', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBeUndefined();
    });

    test('two consecutive prose responses do not trigger degradation', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBeUndefined();
    });

    test('three consecutive prose responses trigger degraded state', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBe('degraded');
    });

    test('a successful tool-call response resets the counter', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, true);   // success — resets
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        // Two prose after the reset shouldn't trigger
        expect(getToolCapability(TEST_ENDPOINT)).toBeUndefined();
    });

    test('degraded endpoint promotes to supported on a successful call', () => {
        // Force into degraded
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBe('degraded');

        // A success while degraded promotes back to supported
        recordToolUsageResult(TEST_ENDPOINT, true);
        expect(getToolCapability(TEST_ENDPOINT)).toBe('supported');
    });

    test('unsupported endpoints are sticky — recording does not promote them', () => {
        setToolCapability(TEST_ENDPOINT, 'unsupported');

        // Even multiple successes shouldn't promote out of unsupported.
        // The 'unsupported' state means the server rejected the
        // `tools` field with a 400; recording successful tool use
        // there doesn't make sense (couldn't have happened).
        recordToolUsageResult(TEST_ENDPOINT, true);
        recordToolUsageResult(TEST_ENDPOINT, true);
        expect(getToolCapability(TEST_ENDPOINT)).toBe('unsupported');
    });

    test('per-endpoint isolation — counters do not leak across endpoints', () => {
        const endpointA = 'http://a.example.com/v1/chat/completions';
        const endpointB = 'http://b.example.com/v1/chat/completions';

        recordToolUsageResult(endpointA, false);
        recordToolUsageResult(endpointA, false);
        recordToolUsageResult(endpointB, false);
        recordToolUsageResult(endpointA, false);  // 3rd for A — degraded

        expect(getToolCapability(endpointA)).toBe('degraded');
        expect(getToolCapability(endpointB)).toBeUndefined();
    });

    test('degraded persists once set even after more prose', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        // Already degraded — more prose responses don't change state
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBe('degraded');
    });

    test('reset clears both state and counters', () => {
        recordToolUsageResult(TEST_ENDPOINT, false);
        recordToolUsageResult(TEST_ENDPOINT, false);
        resetToolCapabilityCache();

        // Counter was cleared — three more should be needed to degrade,
        // not just one.
        recordToolUsageResult(TEST_ENDPOINT, false);
        expect(getToolCapability(TEST_ENDPOINT)).toBeUndefined();
    });

    test('test hook setToolCapability respects the type', () => {
        setToolCapability(TEST_ENDPOINT, 'degraded');
        expect(getToolCapability(TEST_ENDPOINT)).toBe('degraded');

        setToolCapability(TEST_ENDPOINT, 'supported');
        expect(getToolCapability(TEST_ENDPOINT)).toBe('supported');
    });
});