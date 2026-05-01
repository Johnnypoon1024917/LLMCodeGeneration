// src/test/unit/rateLimitHook.test.ts
//
// Unit tests for buildRateLimitHook and composeHooks (D12).
//
// What we test:
//   - buildRateLimitHook returns a hook that consults a RateLimiter
//   - hook returns blocked=false when limiter allows
//   - hook returns blocked=true with limiter's reason when denied
//   - composeHooks runs hooks left-to-right
//   - composeHooks returns first blocking verdict
//   - composeHooks short-circuits (later hooks not called after a block)
//   - composeHooks with 0 hooks returns allow-all
//   - composeHooks with 1 hook returns it directly (no extra wrapper)

import { buildRateLimitHook, composeHooks } from '../../agents/rateLimitHook';
import { RateLimiter } from '../../agents/rateLimiter';
import type { ToolCall } from '../../llm';
import type { PreDispatchHook } from '../../agents/toolDispatchWithEvents';

/** Build a stub ToolCall with the given function name. */
function fakeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
    return {
        id: 'call-test-1',
        type: 'function',
        function: {
            name,
            arguments: JSON.stringify(args)
        }
    };
}

describe('buildRateLimitHook — basic', () => {
    test('returns blocked=false when limiter allows', async () => {
        const limiter = new RateLimiter({ maxTotal: 10 });
        const hook = buildRateLimitHook(limiter);

        const verdict = await hook(fakeToolCall('read_file'), {});

        expect(verdict.blocked).toBe(false);
        expect(verdict.reason).toBeUndefined();
        // Limiter consumed one slot.
        expect(limiter.getTotalCount()).toBe(1);
    });

    test('returns blocked=true with reason when limiter denies', async () => {
        const limiter = new RateLimiter({ maxTotal: 1 });
        const hook = buildRateLimitHook(limiter);

        // First call uses the budget.
        const first = await hook(fakeToolCall('read_file'), {});
        expect(first.blocked).toBe(false);

        // Second call denied.
        const second = await hook(fakeToolCall('read_file'), {});
        expect(second.blocked).toBe(true);
        expect(second.reason).toBeDefined();
        expect(second.reason).toContain('Per-task tool-call limit');
    });

    test('per-tool denial passes through tool-specific reason', async () => {
        const limiter = new RateLimiter({
            maxTotal: 100,
            perTool: { bash_exec: 0 }
        });
        const hook = buildRateLimitHook(limiter);

        const verdict = await hook(fakeToolCall('bash_exec'), { command: 'ls' });

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toContain('bash_exec');
    });

    test('hook ignores the args parameter (uses only tool name)', async () => {
        const limiter = new RateLimiter({ maxTotal: 10 });
        const hook = buildRateLimitHook(limiter);

        // Two different arg shapes for the same tool name → same counter.
        await hook(fakeToolCall('read_file'), { filepath: 'a.ts' });
        await hook(fakeToolCall('read_file'), { filepath: 'b.ts', extra: 'ignored' });

        expect(limiter.getCountForTool('read_file')).toBe(2);
    });
});

describe('composeHooks — empty/single', () => {
    test('zero hooks returns allow-all', async () => {
        const composed = composeHooks();
        const verdict = await composed(fakeToolCall('any'), {});
        expect(verdict.blocked).toBe(false);
    });

    test('single hook is returned directly (same observable behavior)', async () => {
        const inner: PreDispatchHook = async () => ({ blocked: true, reason: 'test' });
        const composed = composeHooks(inner);
        const verdict = await composed(fakeToolCall('any'), {});
        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe('test');
    });
});

describe('composeHooks — multi-hook ordering', () => {
    test('runs hooks left-to-right', async () => {
        const callOrder: string[] = [];
        const hookA: PreDispatchHook = async () => {
            callOrder.push('A');
            return { blocked: false };
        };
        const hookB: PreDispatchHook = async () => {
            callOrder.push('B');
            return { blocked: false };
        };
        const hookC: PreDispatchHook = async () => {
            callOrder.push('C');
            return { blocked: false };
        };

        const composed = composeHooks(hookA, hookB, hookC);
        await composed(fakeToolCall('any'), {});

        expect(callOrder).toEqual(['A', 'B', 'C']);
    });

    test('all hooks must allow for composed to allow', async () => {
        const allow: PreDispatchHook = async () => ({ blocked: false });
        const composed = composeHooks(allow, allow, allow);
        const verdict = await composed(fakeToolCall('any'), {});
        expect(verdict.blocked).toBe(false);
    });

    test('first blocking hook wins (security before rate limit)', async () => {
        const security: PreDispatchHook = async () => ({
            blocked: true,
            reason: 'blocked by security'
        });
        const rateLimit: PreDispatchHook = async () => ({
            blocked: true,
            reason: 'blocked by rate limit'
        });

        const composed = composeHooks(security, rateLimit);
        const verdict = await composed(fakeToolCall('bash_exec'), {});

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe('blocked by security');
    });

    test('later hooks NOT called after a block (short-circuit)', async () => {
        const hookA: PreDispatchHook = async () => ({ blocked: true, reason: 'A blocks' });
        let bCalled = false;
        const hookB: PreDispatchHook = async () => {
            bCalled = true;
            return { blocked: false };
        };

        const composed = composeHooks(hookA, hookB);
        await composed(fakeToolCall('any'), {});

        expect(bCalled).toBe(false);
    });

    test('middle hook can block; later hooks then skipped', async () => {
        const callOrder: string[] = [];
        const hookA: PreDispatchHook = async () => {
            callOrder.push('A');
            return { blocked: false };
        };
        const hookB: PreDispatchHook = async () => {
            callOrder.push('B');
            return { blocked: true, reason: 'B blocks' };
        };
        const hookC: PreDispatchHook = async () => {
            callOrder.push('C');
            return { blocked: false };
        };

        const composed = composeHooks(hookA, hookB, hookC);
        const verdict = await composed(fakeToolCall('any'), {});

        expect(callOrder).toEqual(['A', 'B']);
        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe('B blocks');
    });
});

describe('composeHooks — integration with rate limit', () => {
    test('security allow + rate limit allow → composed allows and consumes budget', async () => {
        const security: PreDispatchHook = async () => ({ blocked: false });
        const limiter = new RateLimiter({ maxTotal: 5 });
        const rateLimit = buildRateLimitHook(limiter);

        const composed = composeHooks(security, rateLimit);
        const verdict = await composed(fakeToolCall('read_file'), {});

        expect(verdict.blocked).toBe(false);
        expect(limiter.getTotalCount()).toBe(1);
    });

    test('security blocks → rate limit hook NOT consulted (no budget consumed)', async () => {
        const security: PreDispatchHook = async () => ({
            blocked: true,
            reason: 'security says no'
        });
        const limiter = new RateLimiter({ maxTotal: 5 });
        const rateLimit = buildRateLimitHook(limiter);

        const composed = composeHooks(security, rateLimit);
        const verdict = await composed(fakeToolCall('bash_exec'), {});

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toBe('security says no');
        // Critical: budget was NOT consumed by a call that security
        // already rejected. Otherwise, an attacker could exhaust the
        // budget by repeatedly trying blocked commands.
        expect(limiter.getTotalCount()).toBe(0);
    });

    test('security allow + rate limit denies → composed reports rate-limit reason', async () => {
        const security: PreDispatchHook = async () => ({ blocked: false });
        const limiter = new RateLimiter({ maxTotal: 0 });  // exhausted from start
        const rateLimit = buildRateLimitHook(limiter);

        const composed = composeHooks(security, rateLimit);
        const verdict = await composed(fakeToolCall('read_file'), {});

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toContain('Per-task tool-call limit');
    });
});