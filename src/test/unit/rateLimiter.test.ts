// src/test/unit/rateLimiter.test.ts
//
// Unit tests for RateLimiter (D12).
//
// What we test:
//   - default config (no args) gives DEFAULT_MAX_TOTAL cap, no per-tool
//   - tryConsume increments counters on allow
//   - tryConsume does NOT increment on deny
//   - global cap exhaustion blocks all further calls
//   - per-tool cap exhaustion blocks that tool but not others
//   - per-tool cap of 0 blocks all calls to that tool from the start
//   - global maxTotal of 0 blocks all calls regardless of per-tool
//   - inspection helpers (getTotalCount, getCountForTool, getRemainingTotal)
//
// What we don't test:
//   - VS Code config reading (lives in CoderAgent.readRateLimitConfig;
//     covered by integration testing in dev host since it requires
//     vscode mocking)
//   - Hook integration (covered by rateLimitHook.test.ts)

import { RateLimiter } from '../../agents/rateLimiter';

describe('RateLimiter — defaults', () => {
    test('no config gives DEFAULT_MAX_TOTAL (100) and no per-tool caps', () => {
        const limiter = new RateLimiter();
        expect(limiter.getMaxTotal()).toBe(100);
        expect(limiter.getMaxTotal()).toBe(RateLimiter.DEFAULT_MAX_TOTAL);
        expect(limiter.getCapForTool('bash_exec')).toBeUndefined();
    });

    test('empty config object behaves identically to no config', () => {
        const limiter = new RateLimiter({});
        expect(limiter.getMaxTotal()).toBe(RateLimiter.DEFAULT_MAX_TOTAL);
    });

    test('config with only maxTotal preserves it; perTool defaults to empty', () => {
        const limiter = new RateLimiter({ maxTotal: 50 });
        expect(limiter.getMaxTotal()).toBe(50);
        expect(limiter.getCapForTool('any_tool')).toBeUndefined();
    });

    test('config with only perTool preserves it; maxTotal defaults to default', () => {
        const limiter = new RateLimiter({ perTool: { bash_exec: 5 } });
        expect(limiter.getMaxTotal()).toBe(RateLimiter.DEFAULT_MAX_TOTAL);
        expect(limiter.getCapForTool('bash_exec')).toBe(5);
    });
});

describe('RateLimiter — counter behavior', () => {
    test('first tryConsume returns allowed=true and increments', () => {
        const limiter = new RateLimiter({ maxTotal: 10 });

        const verdict = limiter.tryConsume('read_file');

        expect(verdict.allowed).toBe(true);
        expect(verdict.reason).toBeUndefined();
        expect(limiter.getTotalCount()).toBe(1);
        expect(limiter.getCountForTool('read_file')).toBe(1);
    });

    test('multiple tryConsume calls accumulate counters', () => {
        const limiter = new RateLimiter({ maxTotal: 10 });

        limiter.tryConsume('read_file');
        limiter.tryConsume('read_file');
        limiter.tryConsume('write_file');

        expect(limiter.getTotalCount()).toBe(3);
        expect(limiter.getCountForTool('read_file')).toBe(2);
        expect(limiter.getCountForTool('write_file')).toBe(1);
    });

    test('denied calls do NOT increment counters', () => {
        const limiter = new RateLimiter({ maxTotal: 2 });

        limiter.tryConsume('read_file');
        limiter.tryConsume('read_file');
        // Now at the cap. Next call should be denied.
        const verdict = limiter.tryConsume('read_file');

        expect(verdict.allowed).toBe(false);
        // Counter stayed at 2, NOT 3.
        expect(limiter.getTotalCount()).toBe(2);
        expect(limiter.getCountForTool('read_file')).toBe(2);
    });

    test('getCountForTool returns 0 for never-consumed tools', () => {
        const limiter = new RateLimiter();
        expect(limiter.getCountForTool('never_called')).toBe(0);
    });
});

describe('RateLimiter — global cap', () => {
    test('exhausts after maxTotal calls and denies further', () => {
        const limiter = new RateLimiter({ maxTotal: 3 });

        expect(limiter.tryConsume('a').allowed).toBe(true);
        expect(limiter.tryConsume('b').allowed).toBe(true);
        expect(limiter.tryConsume('c').allowed).toBe(true);

        const denied = limiter.tryConsume('d');
        expect(denied.allowed).toBe(false);
        expect(denied.reason).toContain('Per-task tool-call limit reached');
        expect(denied.reason).toContain('3');
    });

    test('global cap of 0 blocks every call from the start', () => {
        const limiter = new RateLimiter({ maxTotal: 0 });

        const verdict = limiter.tryConsume('read_file');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('limit reached');
        // No work was done.
        expect(limiter.getTotalCount()).toBe(0);
    });

    test('global cap denial reason mentions the configured limit', () => {
        const limiter = new RateLimiter({ maxTotal: 7 });
        for (let i = 0; i < 7; i++) limiter.tryConsume('x');
        const denied = limiter.tryConsume('x');
        expect(denied.reason).toContain('7');
    });
});

describe('RateLimiter — per-tool caps', () => {
    test('per-tool cap blocks that tool but not others', () => {
        const limiter = new RateLimiter({
            maxTotal: 100,
            perTool: { bash_exec: 2 }
        });

        expect(limiter.tryConsume('bash_exec').allowed).toBe(true);
        expect(limiter.tryConsume('bash_exec').allowed).toBe(true);
        expect(limiter.tryConsume('bash_exec').allowed).toBe(false);

        // Other tools unaffected.
        expect(limiter.tryConsume('read_file').allowed).toBe(true);
        expect(limiter.tryConsume('write_file').allowed).toBe(true);
    });

    test('per-tool cap of 0 blocks all calls to that tool', () => {
        const limiter = new RateLimiter({
            maxTotal: 100,
            perTool: { dangerous_tool: 0 }
        });

        const verdict = limiter.tryConsume('dangerous_tool');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('dangerous_tool');
        expect(limiter.getCountForTool('dangerous_tool')).toBe(0);
    });

    test('global cap takes precedence over per-tool slack', () => {
        // Global says max 3 total; per-tool says read_file has 100.
        // Per-tool can't exceed global.
        const limiter = new RateLimiter({
            maxTotal: 3,
            perTool: { read_file: 100 }
        });

        limiter.tryConsume('read_file');
        limiter.tryConsume('read_file');
        limiter.tryConsume('read_file');

        const denied = limiter.tryConsume('read_file');
        expect(denied.allowed).toBe(false);
        // Reason mentions the GLOBAL limit, not the per-tool cap.
        expect(denied.reason).toContain('Per-task tool-call limit');
    });

    test('per-tool denial reason mentions the tool name and cap', () => {
        const limiter = new RateLimiter({
            maxTotal: 100,
            perTool: { bash_exec: 4 }
        });

        for (let i = 0; i < 4; i++) limiter.tryConsume('bash_exec');
        const denied = limiter.tryConsume('bash_exec');

        expect(denied.reason).toContain('bash_exec');
        expect(denied.reason).toContain('4');
    });

    test('multiple per-tool caps are independent', () => {
        const limiter = new RateLimiter({
            maxTotal: 100,
            perTool: { bash_exec: 2, write_file: 5 }
        });

        // Exhaust bash_exec.
        limiter.tryConsume('bash_exec');
        limiter.tryConsume('bash_exec');
        expect(limiter.tryConsume('bash_exec').allowed).toBe(false);

        // write_file still has budget.
        for (let i = 0; i < 5; i++) {
            expect(limiter.tryConsume('write_file').allowed).toBe(true);
        }
        expect(limiter.tryConsume('write_file').allowed).toBe(false);
    });
});

describe('RateLimiter — inspection', () => {
    test('getRemainingTotal reflects consumed budget', () => {
        const limiter = new RateLimiter({ maxTotal: 10 });
        expect(limiter.getRemainingTotal()).toBe(10);

        limiter.tryConsume('a');
        limiter.tryConsume('b');
        expect(limiter.getRemainingTotal()).toBe(8);
    });

    test('getRemainingTotal floors at 0 (never negative)', () => {
        const limiter = new RateLimiter({ maxTotal: 2 });
        limiter.tryConsume('a');
        limiter.tryConsume('b');
        // Already at cap.
        expect(limiter.getRemainingTotal()).toBe(0);
        // Denied attempt doesn't push remaining below 0.
        limiter.tryConsume('c');
        expect(limiter.getRemainingTotal()).toBe(0);
    });

    test('getCapForTool returns configured value or undefined', () => {
        const limiter = new RateLimiter({
            perTool: { bash_exec: 5 }
        });
        expect(limiter.getCapForTool('bash_exec')).toBe(5);
        expect(limiter.getCapForTool('not_configured')).toBeUndefined();
    });
});

describe('RateLimiter — config isolation', () => {
    test('mutating the config object after construction does not affect the limiter', () => {
        const config: { maxTotal: number; perTool: Record<string, number> } = {
            maxTotal: 5,
            perTool: { bash_exec: 2 }
        };
        const limiter = new RateLimiter(config);

        // Mutate the original config.
        config.maxTotal = 999;
        config.perTool['bash_exec'] = 999;
        config.perTool['new_tool'] = 42;

        // Limiter still uses the values it was constructed with.
        expect(limiter.getMaxTotal()).toBe(5);
        expect(limiter.getCapForTool('bash_exec')).toBe(2);
        expect(limiter.getCapForTool('new_tool')).toBeUndefined();
    });

    test('two limiters are independent (no shared state)', () => {
        const limiterA = new RateLimiter({ maxTotal: 10 });
        const limiterB = new RateLimiter({ maxTotal: 10 });

        for (let i = 0; i < 5; i++) limiterA.tryConsume('read_file');

        expect(limiterA.getTotalCount()).toBe(5);
        expect(limiterB.getTotalCount()).toBe(0);
    });
});