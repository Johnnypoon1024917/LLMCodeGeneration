// src/test/unit/verifierAgent.test.ts
//
// Tests for the C-6 verifier emitter integration. Focuses on the
// `runVerifierCommand` helper that wraps `env.runCommand` calls with
// lifecycle events.
//
// What this file covers:
//   - Emitter wiring: started + completed(success) on success
//   - Emitter wiring: started + completed(error) on failure, with
//     stdout/stderr captured from the error object
//   - Re-throw behavior preserved (verifier's catch-and-restore path
//     must still work)
//   - No-emitter path: command runs normally, no events fire
//   - Source tag: 'verifier-internal' on every emitted event
//
// What this file does NOT cover:
//   - The full `runVerificationAgent` flow — that's an integration
//     test surface (compile + install + LLM PRD review). Lots of
//     mocks. Out of scope for C-6 polish; the unit-level coverage
//     here verifies the wiring works.

import { runVerifierCommand } from '../../agents/VerifierAgent';
import { ToolEventEmitter } from '../../agents/toolEventEmitter';
import type { ToolLifecycleEvent } from '../../agents/toolProtocol';
import type { IEnvironment } from '../../interfaces/IEnvironment';

// Minimal IEnvironment stub. Only `runCommand` is exercised; the
// other methods would never be called by runVerifierCommand.
function makeEnv(runCommandImpl: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string }>): IEnvironment {
    return {
        readFile: async () => '',
        writeFile: async () => undefined,
        deleteFile: async () => undefined,
        runCommand: runCommandImpl,
        log: () => undefined,
    };
}

describe('runVerifierCommand — C-6 emitter wiring', () => {
    test('emits started + completed(success) when command succeeds', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        const env = makeEnv(async () => ({ stdout: 'compiled OK', stderr: '' }));

        const result = await runVerifierCommand({
            env,
            cmd: 'tsc --noEmit foo.ts',
            workspaceRoot: '/repo',
            label: 'tsc compile',
            emitter,
            taskId: 'task::verifier::foo.ts',
        });

        expect(result).toEqual({ stdout: 'compiled OK', stderr: '' });
        expect(events).toHaveLength(2);

        const started = events[0]!;
        expect(started.type).toBe('toolCallStarted');
        expect(started.source).toBe('verifier-internal');
        expect(started.taskId).toBe('task::verifier::foo.ts');
        if (started.type === 'toolCallStarted') {
            expect(started.name).toBe('tsc compile');
            expect(started.arguments).toEqual({
                command: 'tsc --noEmit foo.ts',
                cwd: '/repo',
            });
        }

        const completed = events[1]!;
        expect(completed.type).toBe('toolCallCompleted');
        if (completed.type === 'toolCallCompleted') {
            expect(completed.status).toBe('success');
            expect(completed.source).toBe('verifier-internal');
            expect(completed.result.uiPayload.kind).toBe('bash_output');
            if (completed.result.uiPayload.kind === 'bash_output') {
                expect(completed.result.uiPayload.stdout).toBe('compiled OK');
                expect(completed.result.uiPayload.stderr).toBe('');
                expect(completed.result.uiPayload.exitCode).toBe(0);
                expect(typeof completed.result.uiPayload.durationMs).toBe('number');
            }
        }
    });

    test('emits started + completed(error) when command fails, captures stdout/stderr from error', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        // Simulate the shape `child_process.exec` rejection produces:
        // an Error object with `.stdout` and `.stderr` fields attached.
        const execErr = Object.assign(new Error('Command failed'), {
            stdout: 'partial stdout output',
            stderr: 'TS2304: Cannot find name "foo"',
        });
        const env = makeEnv(async () => { throw execErr; });

        await expect(runVerifierCommand({
            env,
            cmd: 'tsc --noEmit broken.ts',
            workspaceRoot: '/repo',
            label: 'tsc compile',
            emitter,
            taskId: 'task::verifier::broken.ts',
        })).rejects.toBe(execErr); // Original error re-thrown unchanged.

        expect(events).toHaveLength(2);
        const completed = events[1]!;
        expect(completed.type).toBe('toolCallCompleted');
        if (completed.type === 'toolCallCompleted') {
            expect(completed.status).toBe('error');
            expect(completed.result.uiPayload.kind).toBe('bash_output');
            if (completed.result.uiPayload.kind === 'bash_output') {
                expect(completed.result.uiPayload.stdout).toBe('partial stdout output');
                expect(completed.result.uiPayload.stderr).toContain('TS2304');
                expect(completed.result.uiPayload.exitCode).toBe(1);
            }
        }
    });

    test('handles errors without structured stdout/stderr fields (falls back to message)', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        // A plain Error — no .stdout/.stderr properties attached.
        const env = makeEnv(async () => { throw new Error('child_process failed to spawn'); });

        await expect(runVerifierCommand({
            env,
            cmd: 'broken-command',
            workspaceRoot: '/repo',
            label: 'broken',
            emitter,
            taskId: 'task::v',
        })).rejects.toThrow();

        const completed = events[1]!;
        if (completed.type === 'toolCallCompleted' && completed.result.uiPayload.kind === 'bash_output') {
            expect(completed.result.uiPayload.stdout).toBe('');
            // Falls back to errorMessage(err) when there's no .stderr.
            expect(completed.result.uiPayload.stderr).toContain('child_process failed');
        }
    });

    test('no events fire when emitter is absent (backwards-compat path)', async () => {
        let runCommandCalled = false;
        const env = makeEnv(async () => {
            runCommandCalled = true;
            return { stdout: '', stderr: '' };
        });

        // No emitter, no taskId — verifier still works the legacy way.
        const result = await runVerifierCommand({
            env,
            cmd: 'tsc',
            workspaceRoot: '/repo',
            label: 'tsc compile',
        });

        expect(runCommandCalled).toBe(true);
        expect(result).toEqual({ stdout: '', stderr: '' });
        // No events fired — there's no emitter to capture into. The
        // assertion is implicit: this test would crash on missing
        // emitter access if the helper tried to emit anyway.
    });

    test('no events fire when emitter is provided but taskId is absent', async () => {
        // Defensive: the verifier signature has emitter and taskId as
        // separate optional params. If a caller passes one without
        // the other, we want graceful degradation (no events) rather
        // than a crash.
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));

        await runVerifierCommand({
            env,
            cmd: 'tsc',
            workspaceRoot: '/repo',
            label: 'tsc compile',
            emitter,
            // taskId intentionally omitted
        });

        expect(events).toHaveLength(0);
    });

    test('events carry monotonic per-task seq numbers (started=0, completed=1)', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));

        await runVerifierCommand({
            env, cmd: 'cmd1', workspaceRoot: '/repo', label: 'l1',
            emitter, taskId: 'task-A',
        });

        // ToolEventEmitter stamps seq monotonically per taskId.
        expect(events[0]!.seq).toBe(0);
        expect(events[1]!.seq).toBe(1);
    });

    test('shares the same source tag with the toolProtocol reservation', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));

        await runVerifierCommand({
            env, cmd: 'cmd', workspaceRoot: '/repo', label: 'l',
            emitter, taskId: 't',
        });

        // The 'verifier-internal' source value is reserved in
        // toolProtocol.ts's ToolEventSource union. Verify we use it
        // (not 'verifier' or 'coordinator' or anything else).
        for (const ev of events) {
            expect(ev.source).toBe('verifier-internal');
        }
    });

    test('callId is unique per invocation', async () => {
        const events: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => events.push(e));
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));

        // Run two commands; their callIds should differ.
        await runVerifierCommand({
            env, cmd: 'cmd1', workspaceRoot: '/repo', label: 'l1',
            emitter, taskId: 't',
        });
        await runVerifierCommand({
            env, cmd: 'cmd2', workspaceRoot: '/repo', label: 'l2',
            emitter, taskId: 't',
        });

        // Events: started1, completed1, started2, completed2
        const callIds = events.map(e => e.callId);
        expect(new Set(callIds).size).toBe(2);  // 2 unique callIds
        // Within each pair, started and completed share a callId.
        expect(callIds[0]).toBe(callIds[1]);
        expect(callIds[2]).toBe(callIds[3]);
        expect(callIds[0]).not.toBe(callIds[2]);
    });
});

// ────────────────────────────────────────────────────────────────────
// Project-mode compile helpers (C-7 / option-2 / Component 4.5 work)
//
// Tests for the helpers introduced for the project-mode verifier
// rewrite. Covers:
//   - tsconfig discovery walks up directory tree, returns null when absent
//   - tsc output parser extracts file/line/col/code/message tuples
//   - Relevance partitioning: definitely-relevant / likely-relevant /
//     pre-existing splits
//   - Install retry filtering: only modules from touched files

import {
    findProjectTsconfig,
    parseTscOutput,
    isErrorRelevant,
    partitionErrors,
    extractMissingModules,
    formatErrorsForCritique,
} from '../../agents/VerifierAgent';

describe('findProjectTsconfig — C-7 tsconfig discovery', () => {
    test('finds tsconfig.json at workspace root', async () => {
        const calls: string[] = [];
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));
        env.readFile = async (filepath: string) => {
            calls.push(filepath);
            if (filepath === '/repo/tsconfig.json') return '{}';
            throw new Error('ENOENT');
        };

        const found = await findProjectTsconfig(env, '/repo/src/components', '/repo');
        expect(found).toBe('/repo/tsconfig.json');
        // Should have walked from src/components up to repo
        expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    test('finds tsconfig.json in a subdirectory (monorepo nearest-config pattern)', async () => {
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));
        env.readFile = async (filepath: string) => {
            // Only the packages/web/tsconfig.json exists
            if (filepath === '/repo/packages/web/tsconfig.json') return '{}';
            throw new Error('ENOENT');
        };

        const found = await findProjectTsconfig(
            env,
            '/repo/packages/web/src/components',
            '/repo'
        );
        expect(found).toBe('/repo/packages/web/tsconfig.json');
    });

    test('returns null when no tsconfig.json found anywhere up to workspace root', async () => {
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));
        env.readFile = async () => { throw new Error('ENOENT'); };

        const found = await findProjectTsconfig(env, '/repo/src/foo', '/repo');
        expect(found).toBeNull();
    });

    test('does not escape above workspace root', async () => {
        const calls: string[] = [];
        const env = makeEnv(async () => ({ stdout: '', stderr: '' }));
        env.readFile = async (filepath: string) => {
            calls.push(filepath);
            // Pretend tsconfig exists at /etc (above /repo)
            if (filepath === '/etc/tsconfig.json') return '{}';
            throw new Error('ENOENT');
        };

        const found = await findProjectTsconfig(env, '/repo/src/foo', '/repo');
        // Walk should stop at /repo, never check /etc
        expect(found).toBeNull();
        for (const c of calls) {
            // Every checked path must be under /repo (or equal to /repo + trailing config name)
            expect(c.startsWith('/repo')).toBe(true);
        }
    });
});

describe('parseTscOutput — C-7 tsc output parser', () => {
    test('parses standard tsc error lines', () => {
        const output = [
            "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.",
            "src/baz.ts(42,1): error TS2322: Type 'number' is not assignable to type 'string'.",
        ].join('\n');
        const errors = parseTscOutput(output);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toMatchObject({
            file: 'src/foo.ts', line: 10, column: 5, code: '2304',
            message: "Cannot find name 'bar'.",
        });
        expect(errors[1]).toMatchObject({
            file: 'src/baz.ts', line: 42, column: 1, code: '2322',
        });
    });

    test('skips continuation lines (no error TSCODE prefix)', () => {
        const output = [
            "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.",
            "  Did you mean 'baz'?",
            "  More context here",
            "src/quux.ts(1,1): error TS1005: ';' expected.",
        ].join('\n');
        const errors = parseTscOutput(output);
        // Only the two real error lines should parse.
        expect(errors).toHaveLength(2);
        expect(errors.map(e => e.code)).toEqual(['2304', '1005']);
    });

    test('handles Windows CRLF line endings', () => {
        const output = "src/foo.ts(10,5): error TS2304: Cannot find name 'bar'.\r\nsrc/baz.ts(1,1): error TS1005: ';' expected.\r\n";
        const errors = parseTscOutput(output);
        expect(errors).toHaveLength(2);
    });

    test('returns empty array for non-error output (banner, version, etc.)', () => {
        const output = "Version 5.0.4\nUsage: tsc [options]\n";
        const errors = parseTscOutput(output);
        expect(errors).toEqual([]);
    });
});

describe('isErrorRelevant — C-7 touched-file scoping', () => {
    const errorIn = (file: string, message = 'some error'): import('../../agents/VerifierAgent').ParsedTscError => ({
        file, line: 1, column: 1, code: '0000', message, raw: '',
    });

    test('definitely relevant: error is in a touched file (basename match)', () => {
        const e = errorIn('src/foo.ts');
        expect(isErrorRelevant(e, ['src/foo.ts'])).toBe(true);
    });

    test('definitely relevant: error is in a touched file (different relative paths)', () => {
        // tsc emits relative-from-cwd; touched file is given with explicit relative path.
        // Suffix-alignment check should pick up the match.
        const e = errorIn('foo.ts');
        expect(isErrorRelevant(e, ['src/foo.ts'])).toBe(true);
    });

    test('likely relevant: error in different file mentions touched file by symbol', () => {
        // Coder modified utils.ts; downstream caller in Foo.tsx broke.
        const e = errorIn('src/components/Foo.tsx', "Module './utils' has no exported member 'helper'.");
        expect(isErrorRelevant(e, ['src/utils.ts'])).toBe(true);
    });

    test('not relevant: error in untouched file with no symbol overlap', () => {
        const e = errorIn('src/some-other.ts', "Cannot find name 'unrelated'.");
        expect(isErrorRelevant(e, ['src/foo.ts'])).toBe(false);
    });

    test('all errors relevant when touchedFiles is empty (no filter)', () => {
        const e = errorIn('any/file.ts');
        expect(isErrorRelevant(e, [])).toBe(true);
    });
});

describe('partitionErrors — C-7 error bucketing', () => {
    const mk = (file: string, message = ''): import('../../agents/VerifierAgent').ParsedTscError =>
        ({ file, line: 1, column: 1, code: '0', message, raw: `${file}(1,1): error TS0: ${message}` });

    test('splits errors into relevant and unrelated buckets', () => {
        const errors = [
            mk('src/foo.ts', 'error in touched file'),
            mk('src/bar.ts', "Cannot find module 'foo' (mentions touched symbol)"),
            mk('src/unrelated.ts', 'pre-existing project issue'),
        ];
        const { relevant, unrelated } = partitionErrors(errors, ['src/foo.ts']);
        // foo.ts (in-file) and bar.ts (mentions 'foo') are relevant.
        expect(relevant).toHaveLength(2);
        expect(unrelated).toHaveLength(1);
        expect(unrelated[0]!.file).toBe('src/unrelated.ts');
    });
});

describe('extractMissingModules — C-7 install-retry filtering', () => {
    const mk = (file: string, message: string): import('../../agents/VerifierAgent').ParsedTscError =>
        ({ file, line: 1, column: 1, code: '2307', message, raw: '' });

    const missingPkgRegex = /Cannot find module '([^']+)'/;

    test('extracts modules from touched-file errors only', () => {
        const errors = [
            mk('src/foo.ts', "Cannot find module 'lodash'"),
            mk('src/foo.ts', "Cannot find module 'react'"),
            mk('src/unrelated.ts', "Cannot find module 'pre-existing-broken'"),
        ];
        const modules = extractMissingModules(errors, ['src/foo.ts'], missingPkgRegex);
        expect(modules.sort()).toEqual(['lodash', 'react']);
        expect(modules).not.toContain('pre-existing-broken');
    });

    test('filters out relative imports', () => {
        const errors = [
            mk('src/foo.ts', "Cannot find module './local-helper'"),
            mk('src/foo.ts', "Cannot find module 'lodash'"),
        ];
        const modules = extractMissingModules(errors, ['src/foo.ts'], missingPkgRegex);
        expect(modules).toEqual(['lodash']);
    });

    test('deduplicates module names', () => {
        const errors = [
            mk('src/foo.ts', "Cannot find module 'lodash'"),
            mk('src/foo.ts', "Cannot find module 'lodash'"),
        ];
        const modules = extractMissingModules(errors, ['src/foo.ts'], missingPkgRegex);
        expect(modules).toEqual(['lodash']);
    });

    test('returns empty when no missing-module errors in touched files', () => {
        const errors = [
            mk('src/foo.ts', "Type 'number' is not assignable to type 'string'"),
        ];
        const modules = extractMissingModules(errors, ['src/foo.ts'], missingPkgRegex);
        expect(modules).toEqual([]);
    });
});

describe('formatErrorsForCritique — C-7 error formatting', () => {
    test('joins raw lines with newlines', () => {
        const errors = [
            { file: 'a', line: 1, column: 1, code: '0', message: '', raw: "src/a.ts(1,1): error TS0: foo" },
            { file: 'b', line: 2, column: 2, code: '0', message: '', raw: "src/b.ts(2,2): error TS0: bar" },
        ];
        const out = formatErrorsForCritique(errors);
        expect(out).toContain('src/a.ts(1,1)');
        expect(out).toContain('src/b.ts(2,2)');
    });

    test('returns empty string for empty error list', () => {
        expect(formatErrorsForCritique([])).toBe('');
    });
});