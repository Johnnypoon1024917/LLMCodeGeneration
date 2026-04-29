// src/agents/tools/run_tests.ts
//
// Run the project's test command. Q1=1C catalog item.
//
// Why this exists when bash_exec covers it: dedicated semantics. The
// LLM can call `run_tests` without knowing which framework is in use;
// the host figures out the right command from package.json or
// `.nexus/test_command` config. This is also the natural integration
// point for the Verifier in 2B-5 (Q8=8C), where verificationAgent
// emits run_tests events for its internal `tsc` / `jest` runs.
//
// Detection strategy: read package.json scripts → "test" key.
// Falls back to `npm test` which Node-default-shells out to a
// reasonable path. For non-Node projects (Python, Rust), 2B-2 ships
// without auto-detection — the LLM uses bash_exec for those today.
// Adding language-specific detection is v1.1.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool, type ToolExecutor } from '../toolRegistry';
import { runCommand, bashOutputPayload, formatLlmContent } from './_execHelper';

const definition = {
    type: 'function' as const,
    function: {
        name: 'run_tests',
        description: "Run the project's test suite. Auto-detects the test command from package.json. Use 'bash_exec' instead if you need a specific test command or non-Node project.",
        parameters: {
            type: 'object',
            properties: {
                testFilter: {
                    type: 'string',
                    description: "Optional filter pattern to pass to the test runner (e.g., 'auth' to run only auth-related tests). Behavior depends on the test runner."
                }
            },
            required: []
        }
    }
};

/**
 * Try to read package.json's test script. Returns null if no
 * package.json, no scripts.test, or any error reading.
 */
async function detectTestCommand(workspaceRoot: string): Promise<string | null> {
    const pkgUri = vscode.Uri.file(path.join(workspaceRoot, 'package.json'));
    try {
        const pkgData = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(new TextDecoder().decode(pkgData)) as {
            scripts?: { test?: string };
        };
        if (pkg.scripts?.test) {
            // We don't return the script body itself — we return
            // `npm test` (or yarn/pnpm if detected), which lets npm
            // resolve the script and inherit the user's PATH/proxy
            // config. The script body might reference local binaries.
            return 'npm test';
        }
    } catch {
        // No package.json or unreadable — caller falls back.
    }
    return null;
}

const executor: ToolExecutor = async (args, ctx) => {
    const testFilter = typeof args['testFilter'] === 'string' ? args['testFilter'] : '';

    const detected = await detectTestCommand(ctx.workspaceRoot);
    let command = detected ?? 'npm test';

    // Append filter if provided. For npm, --testNamePattern is jest's
    // convention; mocha uses --grep. We pick jest's because it's the
    // more common case in the projects we target. If the test runner
    // doesn't recognize the flag, the LLM will see the failure in the
    // result and can re-call with bash_exec for finer control.
    if (testFilter) {
        command += ` -- --testNamePattern="${testFilter.replace(/"/g, '\\"')}"`;
    }

    // Test runs can take a while — bump the default timeout.
    const result = await runCommand(command, ctx, { timeoutMs: 10 * 60 * 1000 });

    return {
        llmContent: formatLlmContent(command, result),
        uiPayload: bashOutputPayload(result)
    };
};

registerTool(definition, executor);