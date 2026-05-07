"use strict";
// src/agents/tools/git_commit.ts
//
// Commit current workspace changes. Q1=1C catalog item.
//
// Behavior: stages all currently-modified files (`git add -A`), then
// commits with the supplied message. We don't expose `git push`,
// `git checkout`, or other state-changing operations — those have
// surprise factor (push to wrong branch, lose work) and the LLM can
// use `bash_exec` for them with explicit user awareness via the
// tool-call card.
Object.defineProperty(exports, "__esModule", { value: true });
const toolRegistry_1 = require("../toolRegistry");
const _execHelper_1 = require("./_execHelper");
const definition = {
    type: 'function',
    function: {
        name: 'git_commit',
        description: "Stage all current workspace changes and create a git commit with the given message. Does NOT push. Use 'bash_exec' for other git operations.",
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: "The commit message. Use clear, present-tense imperative ('Add X', not 'Added X')." }
            },
            required: ['message']
        }
    }
};
const executor = async (args, ctx) => {
    const message = String(args['message'] ?? '');
    if (!message) {
        return {
            llmContent: "Error: 'message' argument is required.",
            uiPayload: { kind: 'error', message: "'message' argument is required." }
        };
    }
    // Reject empty / whitespace-only messages — git itself accepts
    // these only with --allow-empty-message which we don't want.
    if (!message.trim()) {
        const msg = `Commit message cannot be empty or whitespace-only.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    // Pass message via stdin-friendly heredoc to avoid shell escaping
    // bugs. We use git's `-F -` to read from stdin... but that needs
    // process pipe wiring not exposed by runCommand. Simpler: shell
    // single-quote the message and escape any single quotes within.
    const escapedMessage = message.replace(/'/g, "'\\''");
    // Two-phase: stage, then commit. We chain via && so a failure to
    // stage aborts the commit attempt (no half-state).
    const command = `git add -A && git commit -m '${escapedMessage}'`;
    const result = await (0, _execHelper_1.runCommand)(command, ctx);
    return {
        llmContent: (0, _execHelper_1.formatLlmContent)(command, result),
        uiPayload: (0, _execHelper_1.bashOutputPayload)(result)
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=git_commit.js.map