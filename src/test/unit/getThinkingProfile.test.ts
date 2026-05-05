// src/test/unit/getThinkingProfile.test.ts
//
// V2.0: tests for getThinkingProfile.
//
// Verifies:
//   - Per-role config key reads (thinkingPlanner/Coder/Verifier)
//   - Default true when no per-role key set
//   - Sampling presets match Qwen 3.6's documented recommendations:
//       thinking ON:  temp=0.6, top_p=0.95, top_k=20, presence=0.0
//       thinking OFF: temp=0.7, top_p=0.8,  top_k=20, presence=1.5
//   - preserveThinking gated on enableThinking
//   - Defensive fallback when deps not initialized

import { getThinkingProfile } from '../../llmService';
import { setDeps, type ConfigSource, type ExtensionDeps } from '../../container';
import * as vscode from 'vscode';

function makeConfigSource(values: Record<string, unknown>): ConfigSource {
    return {
        get<T>(key: string, defaultValue?: T): T | undefined {
            if (key in values) { return values[key] as T; }
            return defaultValue;
        }
    };
}

function makeTestDeps(configValues: Record<string, unknown>): ExtensionDeps {
    return {
        state: {
            get: () => undefined,
            update: async () => undefined,
            keys: () => []
        } as unknown as vscode.Memento,
        secrets: {
            get: async () => undefined,
            store: async () => undefined,
            delete: async () => undefined,
            onDidChange: () => ({ dispose: () => {} })
        } as unknown as vscode.SecretStorage,
        extensionUri: { scheme: 'file', path: '/' } as unknown as vscode.Uri,
        subscriptions: [],
        config: makeConfigSource(configValues),
        audit: {
            emit: async () => {},
            logLlmCall: async () => {},
            logToolCall: async () => {}
        } as unknown as import('../../audit/AuditLog').AuditLog
    };
}

describe('getThinkingProfile — defaults', () => {
    it('returns thinking-ON profile for planner with no config', async () => {
        setDeps(makeTestDeps({}));
        const p = await getThinkingProfile('planner');
        expect(p.enableThinking).toBe(true);
        expect(p.preserveThinking).toBe(true);
        expect(p.temperature).toBe(0.6);
        expect(p.topP).toBe(0.95);
        expect(p.topK).toBe(20);
        expect(p.presencePenalty).toBe(0.0);
    });

    it('returns thinking-ON profile for coder with no config', async () => {
        setDeps(makeTestDeps({}));
        const p = await getThinkingProfile('coder');
        expect(p.enableThinking).toBe(true);
        expect(p.preserveThinking).toBe(true);
    });

    it('returns thinking-ON profile for verifier with no config', async () => {
        setDeps(makeTestDeps({}));
        const p = await getThinkingProfile('verifier');
        expect(p.enableThinking).toBe(true);
        expect(p.preserveThinking).toBe(true);
    });

    it('returns thinking-ON profile for default role with no config', async () => {
        setDeps(makeTestDeps({}));
        const p = await getThinkingProfile('default');
        expect(p.enableThinking).toBe(true);
    });

    it('returns thinking-ON profile when called with no role argument', async () => {
        setDeps(makeTestDeps({}));
        const p = await getThinkingProfile();
        expect(p.enableThinking).toBe(true);
    });
});

describe('getThinkingProfile — explicit thinking-on config', () => {
    it('respects thinkingPlanner=true (idempotent with default)', async () => {
        setDeps(makeTestDeps({ thinkingPlanner: true }));
        const p = await getThinkingProfile('planner');
        expect(p.enableThinking).toBe(true);
        expect(p.temperature).toBe(0.6);
    });

    it('returns thinking-ON sampling preset', async () => {
        setDeps(makeTestDeps({ thinkingCoder: true }));
        const p = await getThinkingProfile('coder');
        expect(p.temperature).toBe(0.6);
        expect(p.topP).toBe(0.95);
        expect(p.topK).toBe(20);
        expect(p.presencePenalty).toBe(0.0);
    });
});

describe('getThinkingProfile — explicit thinking-off config', () => {
    it('respects thinkingPlanner=false', async () => {
        setDeps(makeTestDeps({ thinkingPlanner: false }));
        const p = await getThinkingProfile('planner');
        expect(p.enableThinking).toBe(false);
        expect(p.preserveThinking).toBe(false);
    });

    it('returns thinking-OFF sampling preset', async () => {
        setDeps(makeTestDeps({ thinkingCoder: false }));
        const p = await getThinkingProfile('coder');
        expect(p.temperature).toBe(0.7);
        expect(p.topP).toBe(0.8);
        expect(p.topK).toBe(20);
        expect(p.presencePenalty).toBe(1.5);
    });

    it('forces preserveThinking off when thinking is off', async () => {
        // Even if user sets preserveThinking=true, it has no effect
        // when thinking is disabled — preservation requires reasoning
        setDeps(makeTestDeps({
            thinkingCoder: false,
            preserveThinking: true,
        }));
        const p = await getThinkingProfile('coder');
        expect(p.enableThinking).toBe(false);
        expect(p.preserveThinking).toBe(false);
    });
});

describe('getThinkingProfile — preserveThinking flag', () => {
    it('defaults to true when thinking is on', async () => {
        setDeps(makeTestDeps({ thinkingPlanner: true }));
        const p = await getThinkingProfile('planner');
        expect(p.preserveThinking).toBe(true);
    });

    it('respects explicit preserveThinking=false', async () => {
        setDeps(makeTestDeps({
            thinkingCoder: true,
            preserveThinking: false,
        }));
        const p = await getThinkingProfile('coder');
        expect(p.enableThinking).toBe(true);
        expect(p.preserveThinking).toBe(false);
    });

    it('respects explicit preserveThinking=true', async () => {
        setDeps(makeTestDeps({
            thinkingVerifier: true,
            preserveThinking: true,
        }));
        const p = await getThinkingProfile('verifier');
        expect(p.preserveThinking).toBe(true);
    });
});

describe('getThinkingProfile — per-role independence', () => {
    it('respects different settings per role in the same config', async () => {
        setDeps(makeTestDeps({
            thinkingPlanner: true,
            thinkingCoder: false,
            thinkingVerifier: true,
        }));
        expect((await getThinkingProfile('planner')).enableThinking).toBe(true);
        expect((await getThinkingProfile('coder')).enableThinking).toBe(false);
        expect((await getThinkingProfile('verifier')).enableThinking).toBe(true);
    });

    it('default role does not read per-role keys', async () => {
        setDeps(makeTestDeps({
            // thinkingPlanner is set false but 'default' should not
            // pick it up — the 'default' role goes straight to the
            // global default-true behavior
            thinkingPlanner: false,
        }));
        const p = await getThinkingProfile('default');
        expect(p.enableThinking).toBe(true);
    });
});

describe('getThinkingProfile — defensive fallback', () => {
    it('returns thinking-ON defaults when deps are not initialized', async () => {
        // Reset by setting an undefined-like state — we can't actually
        // un-set the global deps, but we can simulate the failure path
        // by having a config source that throws on get(). The function
        // catches and falls back.
        setDeps({
            ...makeTestDeps({}),
            config: {
                get: () => { throw new Error('config source unavailable'); }
            }
        });
        const p = await getThinkingProfile('coder');
        // Despite the throwing config, we still get a sensible profile
        expect(p.enableThinking).toBe(true);
        expect(p.temperature).toBe(0.6);
    });
});