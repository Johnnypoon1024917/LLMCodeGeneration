"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const toolRegistry_1 = require("../toolRegistry");
const _execHelper_1 = require("./_execHelper");
const definition = {
    type: 'function',
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
async function detectTestCommand(workspaceRoot) {
    const pkgUri = vscode.Uri.file(path.join(workspaceRoot, 'package.json'));
    try {
        const pkgData = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(new TextDecoder().decode(pkgData));
        if (pkg.scripts?.test) {
            // We don't return the script body itself — we return
            // `npm test` (or yarn/pnpm if detected), which lets npm
            // resolve the script and inherit the user's PATH/proxy
            // config. The script body might reference local binaries.
            return 'npm test';
        }
    }
    catch {
        // No package.json or unreadable — caller falls back.
    }
    return null;
}
const executor = async (args, ctx) => {
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
    const result = await (0, _execHelper_1.runCommand)(command, ctx, { timeoutMs: 10 * 60 * 1000 });
    return {
        llmContent: (0, _execHelper_1.formatLlmContent)(command, result),
        uiPayload: (0, _execHelper_1.bashOutputPayload)(result)
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=run_tests.js.map