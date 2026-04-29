// src/agents/tools/_execHelper.ts
//
// Shared subprocess execution helper for bash_exec, run_tests,
// install_package, git_commit, and any future shell-running tools.
//
// Why not just use child_process.exec directly: we need consistent
// behavior across all four tools for:
//   - Streaming stdout/stderr to the caller via onOutputChunk
//   - Honoring the abort signal (Q5=5B per-task cancel)
//   - Timing out runaway commands (some servers have no useful
//     activity but a model could run `sleep infinity`)
//   - Capturing both stdout AND stderr separately AND interleaved
//     (the LLM benefits from "command failed: stderr was X" but the
//     UI wants the same chronological stream a terminal shows)
//   - Producing the same `bash_output` UI payload shape regardless
//     of which tool kicked off the command
//
// Implementation uses `child_process.spawn` (not `exec`) because we
// need the streaming stdout/stderr that comes with a long-lived
// process handle, not the buffered all-at-once result.

import { spawn } from 'child_process';
import type { ToolExecutionContext } from '../toolRegistry';
import type { ToolResult } from '../toolProtocol';

/**
 * Defaults for command execution. Configurable per call.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB cap on each of stdout/stderr

export interface RunCommandOptions {
    /** Working directory. Defaults to ctx.workspaceRoot. */
    cwd?: string;
    /** Timeout in milliseconds. After this, the process is killed
     *  with SIGTERM, then SIGKILL after a grace period. */
    timeoutMs?: number;
    /** Environment variables to merge with the inherited env. */
    env?: Record<string, string>;
}

export interface RunCommandResult {
    stdout: string;
    stderr: string;
    /** Interleaved stdout+stderr in chronological order. Useful for
     *  the LLM-bound content where preserving order matters more than
     *  separating streams. */
    combined: string;
    exitCode: number;
    /** True if the command ran to completion. False if killed by
     *  timeout or abort signal. */
    completed: boolean;
    durationMs: number;
}

/**
 * Run a shell command. The command is passed to /bin/sh -c (Unix)
 * or cmd.exe /d /s /c (Windows). Each tool that needs subprocess
 * execution wraps this helper.
 *
 * Streaming: chunks of stdout/stderr are forwarded to
 * `ctx.onOutputChunk` as they arrive. The full content is also
 * returned in the final result. Callers that don't care about
 * streaming can ignore onOutputChunk.
 *
 * Output cap: we collect at most MAX_OUTPUT_BYTES per stream. If a
 * command produces more (e.g. `find /` dumping a million paths),
 * later bytes are dropped from the result but the truncation is
 * noted in `combined`. Without this, a chatty command can OOM the
 * extension.
 */
export async function runCommand(
    command: string,
    ctx: ToolExecutionContext,
    options?: RunCommandOptions
): Promise<RunCommandResult> {
    const startTime = Date.now();
    const cwd = options?.cwd ?? ctx.workspaceRoot;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const env: Record<string, string | undefined> = { ...process.env, ...(options?.env ?? {}) };

    // Choose shell based on platform. /bin/sh on Unix, cmd on Windows.
    // -c (Unix) and /d /s /c (Windows) tell the shell to run the
    // following string as a command and exit.
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    return new Promise<RunCommandResult>((resolve) => {
        const child = spawn(shell, shellArgs, {
            cwd,
            env: env as NodeJS.ProcessEnv,
            shell: false,
            // detached: true on Unix makes the child a process group leader.
            // Without this, SIGTERM to the shell doesn't kill the shell's
            // children — `sh -c "sleep 30"` would orphan sleep and keep it
            // running. With detached:true, we can kill -pgid to terminate
            // the entire group.
            // On Windows, detached has different semantics (creates a new
            // console window) which we don't want, so leave it false.
            detached: !isWindows
        });

        // Helper: kill the entire process group (Unix) or just the
        // child (Windows). Wrapped in try/catch because the process
        // may already have exited.
        const killGroup = (signal: NodeJS.Signals): void => {
            try {
                if (!isWindows && child.pid) {
                    // Negative pid signals the process group.
                    process.kill(-child.pid, signal);
                } else {
                    child.kill(signal);
                }
            } catch {
                // Process already exited — fine.
            }
        };

        let stdoutBuf = '';
        let stderrBuf = '';
        let combined = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let completed = false;
        let timedOut = false;
        let aborted = false;

        const truncationNotice = '\n[output truncated — exceeded size limit]\n';

        const handleChunk = (data: Buffer, kind: 'stdout' | 'stderr'): void => {
            const text = data.toString('utf8');
            if (kind === 'stdout') {
                if (stdoutBytes < MAX_OUTPUT_BYTES) {
                    const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
                    const slice = text.length > remaining ? text.substring(0, remaining) : text;
                    stdoutBuf += slice;
                    stdoutBytes += slice.length;
                    combined += slice;
                    if (stdoutBytes >= MAX_OUTPUT_BYTES && !stdoutBuf.endsWith(truncationNotice)) {
                        stdoutBuf += truncationNotice;
                        combined += truncationNotice;
                    }
                }
            } else {
                if (stderrBytes < MAX_OUTPUT_BYTES) {
                    const remaining = MAX_OUTPUT_BYTES - stderrBytes;
                    const slice = text.length > remaining ? text.substring(0, remaining) : text;
                    stderrBuf += slice;
                    stderrBytes += slice.length;
                    combined += slice;
                    if (stderrBytes >= MAX_OUTPUT_BYTES && !stderrBuf.endsWith(truncationNotice)) {
                        stderrBuf += truncationNotice;
                        combined += truncationNotice;
                    }
                }
            }
            if (ctx.onOutputChunk) {
                // Forward the chunk regardless of cap — caller decides
                // what to do with continued output. Capping is for
                // memory in the result buffers, not for streaming.
                try {
                    ctx.onOutputChunk(text);
                } catch {
                    // Caller's callback threw — don't crash the subprocess.
                }
            }
        };

        child.stdout.on('data', (d: Buffer) => handleChunk(d, 'stdout'));
        child.stderr.on('data', (d: Buffer) => handleChunk(d, 'stderr'));

        // Timeout: SIGTERM after timeoutMs, SIGKILL after a 2s grace.
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2000);
        }, timeoutMs);

        // Abort signal: same termination path as timeout, but flagged
        // differently for the result.
        const onAbort = (): void => {
            aborted = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2000);
        };
        if (ctx.signal) {
            if (ctx.signal.aborted) {
                onAbort();
            } else {
                ctx.signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        child.on('close', (code: number | null) => {
            clearTimeout(timeoutTimer);
            if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

            completed = !timedOut && !aborted;
            const exitCode = code ?? -1;

            if (timedOut) {
                const msg = `\n[command timed out after ${timeoutMs}ms]\n`;
                stderrBuf += msg;
                combined += msg;
            }
            if (aborted) {
                const msg = `\n[command aborted by user]\n`;
                stderrBuf += msg;
                combined += msg;
            }

            resolve({
                stdout: stdoutBuf,
                stderr: stderrBuf,
                combined,
                exitCode,
                completed,
                durationMs: Date.now() - startTime
            });
        });

        child.on('error', (err: Error) => {
            // Spawn-level error (command not found, permission denied,
            // etc.). Surface as a result with non-zero exit code so
            // the dispatcher can build a structured response without
            // a separate error path.
            clearTimeout(timeoutTimer);
            if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

            stderrBuf += `\n[spawn error: ${err.message}]\n`;
            combined += `\n[spawn error: ${err.message}]\n`;
            resolve({
                stdout: stdoutBuf,
                stderr: stderrBuf,
                combined,
                exitCode: -1,
                completed: false,
                durationMs: Date.now() - startTime
            });
        });
    });
}

/**
 * Convert a runCommand result into a `ToolResult` payload of kind
 * `bash_output`. Used by the subprocess-family tools that all share
 * this output shape.
 */
export function bashOutputPayload(result: RunCommandResult): ToolResult {
    return {
        kind: 'bash_output',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs
    };
}

/**
 * Format a runCommand result as a string for the LLM-bound content.
 * Interleaved stdout/stderr (chronological), prefixed with metadata
 * the LLM can reason about.
 */
export function formatLlmContent(command: string, result: RunCommandResult): string {
    const status = result.completed
        ? (result.exitCode === 0 ? 'succeeded' : `exited with code ${result.exitCode}`)
        : (result.exitCode === -1 ? 'failed (signal/error)' : `terminated`);

    const header = `Command: ${command}\nStatus: ${status} (${result.durationMs}ms)`;

    if (!result.combined.trim()) {
        return `${header}\n(no output)`;
    }
    return `${header}\nOutput:\n${result.combined}`;
}