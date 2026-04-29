// src/test/unit/securityHook.test.ts
//
// Tests for the security hook factory (Component 2B-3b).
//
// We use the `customAskMonitor` injection slot to script verdicts
// without an LLM round-trip. The real askSecurityMonitor's internal
// behavior is tested elsewhere (or trusted as integration surface).

import { buildSecurityHook, allowAllHook } from '../../agents/securityHook';

function makeToolCall(name: string, args: Record<string, unknown>) {
    return {
        id: 'c1',
        type: 'function' as const,
        function: { name, arguments: JSON.stringify(args) }
    };
}

describe('buildSecurityHook — bash_exec gating', () => {
    test('blocks bash_exec when monitor returns true', async () => {
        const hook = buildSecurityHook({
            customAskMonitor: async (_cmd: string) => true // block
        });

        const verdict = await hook(
            makeToolCall('bash_exec', { command: 'rm -rf /' }),
            { command: 'rm -rf /' }
        );

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toContain('Security Monitor');
        expect(verdict.reason).toContain('rm -rf /');
    });

    test('allows bash_exec when monitor returns false', async () => {
        const hook = buildSecurityHook({
            customAskMonitor: async () => false // allow
        });

        const verdict = await hook(
            makeToolCall('bash_exec', { command: 'npm test' }),
            { command: 'npm test' }
        );

        expect(verdict.blocked).toBe(false);
    });

    test('does NOT call monitor for non-bash tools', async () => {
        let monitorCalled = false;
        const hook = buildSecurityHook({
            customAskMonitor: async () => {
                monitorCalled = true;
                return true; // would block if called
            }
        });

        const verdict = await hook(
            makeToolCall('read_file', { filepath: 'src/x.ts' }),
            { filepath: 'src/x.ts' }
        );

        expect(verdict.blocked).toBe(false);
        expect(monitorCalled).toBe(false);
    });

    test('allows bash_exec when scrutinizeBash is false (opt-out)', async () => {
        let monitorCalled = false;
        const hook = buildSecurityHook({
            scrutinizeBash: false,
            customAskMonitor: async () => {
                monitorCalled = true;
                return true;
            }
        });

        const verdict = await hook(
            makeToolCall('bash_exec', { command: 'anything goes' }),
            { command: 'anything goes' }
        );

        expect(verdict.blocked).toBe(false);
        expect(monitorCalled).toBe(false);
    });

    test('allows bash_exec with empty command (lets dispatcher handle missing-arg)', async () => {
        let monitorCalled = false;
        const hook = buildSecurityHook({
            customAskMonitor: async () => {
                monitorCalled = true;
                return true;
            }
        });

        const verdict = await hook(
            makeToolCall('bash_exec', {}),
            {}
        );

        // Empty command falls through to allow — the dispatcher will
        // surface the missing-arg error. Hook is for policy, not validation.
        expect(verdict.blocked).toBe(false);
        expect(monitorCalled).toBe(false);
    });

    test('truncates very long commands in the block reason', async () => {
        const longCommand = 'echo ' + 'a'.repeat(200);
        const hook = buildSecurityHook({
            customAskMonitor: async () => true
        });

        const verdict = await hook(
            makeToolCall('bash_exec', { command: longCommand }),
            { command: longCommand }
        );

        expect(verdict.blocked).toBe(true);
        expect(verdict.reason).toContain('...'); // truncation indicator
        // Reason itself is bounded in length
        expect(verdict.reason!.length).toBeLessThan(200);
    });

    test('default config (no scrutinizeBash flag) defaults to true', async () => {
        let monitorCalled = false;
        const hook = buildSecurityHook({
            customAskMonitor: async () => {
                monitorCalled = true;
                return true;
            }
        });

        await hook(
            makeToolCall('bash_exec', { command: 'rm /' }),
            { command: 'rm /' }
        );

        // scrutinizeBash defaults to true; monitor should have been called
        expect(monitorCalled).toBe(true);
    });
});

describe('allowAllHook', () => {
    test('always returns blocked: false', async () => {
        const verdict = await allowAllHook(
            makeToolCall('bash_exec', { command: 'rm -rf /' }),
            { command: 'rm -rf /' }
        );

        expect(verdict.blocked).toBe(false);
    });
});