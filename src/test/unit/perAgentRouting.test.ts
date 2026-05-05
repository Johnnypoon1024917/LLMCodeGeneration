// src/test/unit/perAgentRouting.test.ts
//
// Tests for per-agent model routing in getLLMConfig. The infrastructure
// for routing was added piecemeal during the Coordinator rewrite (C-1
// through C-7) — this test file is the formal coverage that the
// resolution behavior actually works correctly across all four roles
// ('default', 'planner', 'coder', 'verifier').
//
// Specifically: we verify the precedence rule documented in
// llmService.ts L165-173:
//
//   1. `nexuscode.modelPlanner` / `modelCoder` / `modelVerifier`
//      (matching the role parameter)
//   2. `nexuscode.model` (global default)
//   3. hardcoded fallback (DEFAULT_MODEL — currently 'qwen3.6-27b')
//
// The 'default' role skips step 1 and goes straight to the global,
// which matches old behavior — useful for code paths that aren't
// role-tagged yet.
//
// These tests are the regression guard for the C1 backend feature.

import { getLLMConfig } from '../../llmService';
import { setDeps, type ConfigSource, type ExtensionDeps } from '../../container';
import * as vscode from 'vscode';

/**
 * Build a minimal ConfigSource backed by a plain object. The keys are
 * `nexuscode.*` style identifiers; the test sets only the keys it cares
 * about and the rest return undefined.
 */
function makeConfigSource(values: Record<string, unknown>): ConfigSource {
    return {
        get<T>(key: string, defaultValue?: T): T | undefined {
            if (key in values) { return values[key] as T; }
            return defaultValue;
        }
    };
}

/**
 * Build a minimal ExtensionDeps suitable for testing. Most fields are
 * stubs because getLLMConfig only reads `config` and `secrets`.
 */
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

describe('getLLMConfig — per-agent model routing', () => {
    describe('default role (no role argument or role="default")', () => {
        test('uses global nexuscode.model when set', async () => {
            setDeps(makeTestDeps({ model: 'global-model' }));
            const cfg = await getLLMConfig();
            expect(cfg.model).toBe('global-model');
        });

        test('uses hardcoded fallback when global is unset', async () => {
            setDeps(makeTestDeps({}));
            const cfg = await getLLMConfig();
            // Hardcoded fallback per llmService.ts (DEFAULT_MODEL constant).
            // If you change DEFAULT_MODEL in llmService.ts, update this
            // string too — these tests are the regression guard.
            expect(cfg.model).toBe('qwen3.6-27b');
        });

        test('explicit role="default" matches no-argument behavior', async () => {
            setDeps(makeTestDeps({ model: 'global-model' }));
            const cfg = await getLLMConfig('default');
            expect(cfg.model).toBe('global-model');
        });

        test('default role IGNORES per-role overrides (uses global only)', async () => {
            // Per the documented precedence: 'default' role skips step 1.
            // Setting modelPlanner shouldn't affect a default-role call.
            setDeps(makeTestDeps({
                model: 'global-model',
                modelPlanner: 'planner-only-model'
            }));
            const cfg = await getLLMConfig('default');
            expect(cfg.model).toBe('global-model');
        });
    });

    describe('planner role', () => {
        test('uses nexuscode.modelPlanner when set', async () => {
            setDeps(makeTestDeps({
                model: 'global-model',
                modelPlanner: 'pro-reasoning-model'
            }));
            const cfg = await getLLMConfig('planner');
            expect(cfg.model).toBe('pro-reasoning-model');
        });

        test('falls back to nexuscode.model when modelPlanner is unset', async () => {
            setDeps(makeTestDeps({ model: 'global-model' }));
            const cfg = await getLLMConfig('planner');
            expect(cfg.model).toBe('global-model');
        });

        test('falls back to hardcoded fallback when both unset', async () => {
            setDeps(makeTestDeps({}));
            const cfg = await getLLMConfig('planner');
            expect(cfg.model).toBe('qwen3.6-27b');
        });

        test('does NOT use modelCoder or modelVerifier', async () => {
            // Defensive: planner-role lookup must not pick up other-role keys.
            setDeps(makeTestDeps({
                model: 'global-model',
                modelCoder: 'coder-model',
                modelVerifier: 'verifier-model'
            }));
            const cfg = await getLLMConfig('planner');
            // No modelPlanner set → falls back to global, NOT to other-role keys.
            expect(cfg.model).toBe('global-model');
        });
    });

    describe('coder role', () => {
        test('uses nexuscode.modelCoder when set', async () => {
            setDeps(makeTestDeps({
                model: 'global-model',
                modelCoder: 'fast-flash-model'
            }));
            const cfg = await getLLMConfig('coder');
            expect(cfg.model).toBe('fast-flash-model');
        });

        test('falls back to nexuscode.model when modelCoder is unset', async () => {
            setDeps(makeTestDeps({
                model: 'global-model',
                modelPlanner: 'pro-model'
            }));
            const cfg = await getLLMConfig('coder');
            expect(cfg.model).toBe('global-model');
        });
    });

    describe('verifier role', () => {
        test('uses nexuscode.modelVerifier when set', async () => {
            setDeps(makeTestDeps({
                model: 'global-model',
                modelVerifier: 'verifier-model'
            }));
            const cfg = await getLLMConfig('verifier');
            expect(cfg.model).toBe('verifier-model');
        });

        test('falls back to nexuscode.model when modelVerifier is unset', async () => {
            setDeps(makeTestDeps({ model: 'global-model' }));
            const cfg = await getLLMConfig('verifier');
            expect(cfg.model).toBe('global-model');
        });
    });

    describe('precedence — all three role keys set independently', () => {
        test('each role gets its own model when all are configured', async () => {
            setDeps(makeTestDeps({
                model: 'global-model',
                modelPlanner: 'plan-model',
                modelCoder: 'code-model',
                modelVerifier: 'verify-model'
            }));

            const planner = await getLLMConfig('planner');
            const coder = await getLLMConfig('coder');
            const verifier = await getLLMConfig('verifier');
            const def = await getLLMConfig('default');

            expect(planner.model).toBe('plan-model');
            expect(coder.model).toBe('code-model');
            expect(verifier.model).toBe('verify-model');
            expect(def.model).toBe('global-model');
        });

        test('mixed configuration — only some roles overridden', async () => {
            // Realistic scenario: planner upgraded to pro, coder/verifier
            // stay on global flash for cost.
            setDeps(makeTestDeps({
                model: 'flash-default',
                modelPlanner: 'pro-planner'
            }));

            expect((await getLLMConfig('planner')).model).toBe('pro-planner');
            expect((await getLLMConfig('coder')).model).toBe('flash-default');
            expect((await getLLMConfig('verifier')).model).toBe('flash-default');
            expect((await getLLMConfig('default')).model).toBe('flash-default');
        });
    });

    describe('edge cases', () => {
        test('empty string for per-role key is treated as unset', async () => {
            // Per llmService.ts L177: `config.get<string>('modelPlanner') || globalModel`
            // Empty string is falsy in JS, so `||` falls through to globalModel.
            setDeps(makeTestDeps({
                model: 'global-model',
                modelPlanner: ''
            }));
            const cfg = await getLLMConfig('planner');
            expect(cfg.model).toBe('global-model');
        });

        test('endpoint comes from nexuscode.apiEndpoint, not affected by role', async () => {
            setDeps(makeTestDeps({
                apiEndpoint: 'http://custom:9000/v1/chat',
                model: 'm',
                modelPlanner: 'planner'
            }));
            const planner = await getLLMConfig('planner');
            const coder = await getLLMConfig('coder');
            // Both share the endpoint. Per-role routing affects only model
            // identifier, not endpoint URL. (Future v1.1 may add per-role
            // endpoint routing — currently unsupported.)
            expect(planner.endpoint).toBe('http://custom:9000/v1/chat');
            expect(coder.endpoint).toBe('http://custom:9000/v1/chat');
        });
    });
});