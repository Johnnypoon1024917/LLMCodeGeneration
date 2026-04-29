// src/agents/tools/bash_exec.ts
//
// Execute a shell command in the workspace. Q1=1C catalog item.
//
// SECURITY SURFACE: This is the most powerful tool in the catalog.
// Once exposed, the LLM can run arbitrary commands with the user's
// permissions. The Coordinator (in 2B-3) is responsible for hooking
// into the existing Security Monitor (SidebarProvider:158) to inspect
// commands BEFORE this dispatcher runs. This dispatcher itself
// performs no security checks — separating policy from mechanism.
//
// Scope-by-design: the cwd is fixed to the workspace root. We don't
// allow the LLM to specify cwd via args because that's an attack
// vector (chdir to /tmp, write malicious script, exec it). If the
// LLM wants to run something in a subdirectory, it can use `cd subdir
// && command` in the command string.

import { registerTool, type ToolExecutor } from '../toolRegistry';
import { runCommand, bashOutputPayload, formatLlmContent } from './_execHelper';

const definition = {
    type: 'function' as const,
    function: {
        name: 'bash_exec',
        description: "Execute a shell command in the workspace root. Returns stdout, stderr, and the exit code. Useful for running build commands, file operations, or one-off scripts.",
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: "The shell command to execute (e.g., 'npm test', 'ls -la src/')" },
                timeoutMs: { type: 'number', description: "Optional timeout in milliseconds. Defaults to 5 minutes (300000ms). Maximum 30 minutes." }
            },
            required: ['command']
        }
    }
};

const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes ceiling

const executor: ToolExecutor = async (args, ctx) => {
    const command = String(args['command'] ?? '');
    if (!command) {
        return {
            llmContent: "Error: 'command' argument is required.",
            uiPayload: { kind: 'error', message: "'command' argument is required." }
        };
    }

    // Clamp the user-supplied timeout to the ceiling. Values out of
    // range or non-numeric fall back to the helper's default.
    const rawTimeout = args['timeoutMs'];
    const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 && rawTimeout <= MAX_TIMEOUT_MS
        ? rawTimeout
        : undefined;

    const opts = timeoutMs !== undefined ? { timeoutMs } : undefined;
    const result = await runCommand(command, ctx, opts);

    return {
        llmContent: formatLlmContent(command, result),
        uiPayload: bashOutputPayload(result)
    };
};

registerTool(definition, executor);