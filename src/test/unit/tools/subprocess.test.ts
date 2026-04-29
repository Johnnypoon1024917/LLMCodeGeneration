// src/test/unit/tools/subprocess.test.ts
//
// Tests for the subprocess-family tool (bash_exec). These tests
// actually spawn child processes — using `echo` and similar
// portable commands. Skipped on non-Unix platforms where the shell
// command shape differs.
//
// Why real subprocess: the value of these tests is verifying the
// runCommand helper's stream/abort/timeout plumbing. Mocking
// child_process.spawn would test the test, not the code.
//
// Compatible across Linux/macOS via /bin/sh -c. We use simple
// commands that exist on both. Windows CI would need its own variant.

jest.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { fs: { stat: jest.fn(), readFile: jest.fn() } },
    FileType: { Directory: 2, File: 1, SymbolicLink: 64 }
}));

import { dispatchTool, type ToolExecutionContext } from '../../../agents/toolRegistry';
import '../../../agents/tools';
import * as os from 'os';

const isWindows = process.platform === 'win32';

describe('bash_exec tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: os.tmpdir() };

    // Subprocess tests can be slower than the 5s default — bump the
    // per-test timeout for this entire describe block. SIGTERM →
    // SIGKILL grace period is 2s alone, plus subprocess spawn cost.
    jest.setTimeout(15000);

    test('runs a successful command and returns bash_output', async () => {
        // `echo` exists on both Unix and Windows
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'echo hello' }) } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('bash_output');
        const payload = result.uiPayload as { kind: 'bash_output'; stdout: string; exitCode: number };
        expect(payload.exitCode).toBe(0);
        expect(payload.stdout).toContain('hello');
        expect(result.llmContent).toContain('Status: succeeded');
    });

    test('returns non-zero exit code for failing command', async () => {
        // `false` exits with 1 on Unix; on Windows we use `exit 1`
        const command = isWindows ? 'exit 1' : 'false';
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: JSON.stringify({ command }) } },
            ctx
        );

        const payload = result.uiPayload as { kind: 'bash_output'; exitCode: number };
        expect(payload.exitCode).toBe(1);
        expect(result.llmContent).toContain('exited with code 1');
    });

    test('captures stderr separately from stdout', async () => {
        // Write to stderr in a portable way: redirect echo to fd 2
        const command = isWindows
            ? 'echo errmsg 1>&2'
            : 'echo errmsg >&2';
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: JSON.stringify({ command }) } },
            ctx
        );

        const payload = result.uiPayload as { kind: 'bash_output'; stdout: string; stderr: string };
        expect(payload.stderr).toContain('errmsg');
        expect(payload.stdout).not.toContain('errmsg');
    });

    test('honors abort signal mid-command', async () => {
        // Skip on Windows where `sleep` syntax differs
        if (isWindows) return;

        const abortCtl = new AbortController();
        const cmdCtx: ToolExecutionContext = {
            workspaceRoot: os.tmpdir(),
            signal: abortCtl.signal
        };

        // Start a long sleep, then abort 100ms later
        const dispatchPromise = dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'sleep 30' }) } },
            cmdCtx
        );
        setTimeout(() => abortCtl.abort(), 100);

        const result = await dispatchPromise;
        const payload = result.uiPayload as { kind: 'bash_output'; exitCode: number };
        expect(payload.exitCode).not.toBe(0);
        expect(result.llmContent).toContain('aborted');
    });

    test('honors timeout option', async () => {
        if (isWindows) return;

        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'bash_exec',
                    arguments: JSON.stringify({ command: 'sleep 30', timeoutMs: 100 })
                }
            },
            { workspaceRoot: os.tmpdir() }
        );

        const payload = result.uiPayload as { kind: 'bash_output'; exitCode: number };
        expect(payload.exitCode).not.toBe(0);
        expect(result.llmContent).toContain('timed out');
    });

    test('forwards output chunks via onOutputChunk callback', async () => {
        const chunks: string[] = [];
        const cmdCtx: ToolExecutionContext = {
            workspaceRoot: os.tmpdir(),
            onOutputChunk: (chunk: string) => chunks.push(chunk)
        };

        await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'echo streamed' }) } },
            cmdCtx
        );

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.join('')).toContain('streamed');
    });

    test('returns error for missing command argument', async () => {
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'bash_exec', arguments: '{}' } },
            { workspaceRoot: os.tmpdir() }
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain("'command'");
    });
});

describe('install_package tool — argument validation', () => {
    test('rejects shell-special characters in package name', async () => {
        const result = await dispatchTool(
            {
                id: 'c1', type: 'function',
                function: {
                    name: 'install_package',
                    arguments: JSON.stringify({ packageName: 'evil; rm -rf /' })
                }
            },
            { workspaceRoot: os.tmpdir() }
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('shell-special characters');
    });
});