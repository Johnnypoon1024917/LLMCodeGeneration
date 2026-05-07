// src/agents/tools/read_file.ts
//
// Read a file's contents from the workspace.
//
// Migrated from the previous in-line implementation in agentTools.ts.
// Behavior is unchanged for the LLM; the new shape returns a
// ToolDispatchResult with `kind: 'file_contents'` UI payload that
// the UI can render as a syntax-highlighted preview.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool, type ToolExecutor } from '../toolRegistry';
import { validateWorkspacePath } from './_pathGuard';
import { checkExclusion, truncateForLlm } from './_contextExclusions';

const definition = {
    type: 'function' as const,
    function: {
        name: 'read_file',
        description: "Read the contents of a specific file in the codebase. Use this to understand existing code, interfaces, or logic.",
        parameters: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: "The relative path to the file (e.g., 'src/utils/api.ts')" }
            },
            required: ['filepath']
        }
    }
};

const executor: ToolExecutor = async (args, ctx) => {
    const filepath = String(args['filepath'] ?? '');
    if (!filepath) {
        return {
            llmContent: "Error: 'filepath' argument is required.",
            uiPayload: { kind: 'error', message: "'filepath' argument is required." }
        };
    }

    // Hotfix (post-2B): reject absolute paths up front. See _pathGuard
    // for the rationale — without this, model-emitted absolute paths
    // silently work on Windows then drift into corruption that breaks
    // every subsequent call. Failing fast on the first absolute path
    // gives the model a clean corrective signal it can self-correct on.
    const pathError = validateWorkspacePath(filepath, 'filepath');
    if (pathError) {
        return {
            llmContent: `Error: ${pathError}`,
            uiPayload: { kind: 'error', message: pathError }
        };
    }

    // V2.2 hotfix #6: context-bloat exclusion. Reject reads of files
    // that are known to bloat the LLM's context window without
    // providing actionable information (lockfiles, build cache,
    // logs, minified output). Production logs showed Qwen 27B (32K
    // context) hitting "input_tokens=28673" mid-task, with reads of
    // these files in the tool history as the main culprit.
    const exclusionReason = checkExclusion(filepath);
    if (exclusionReason) {
        return {
            llmContent: `Error: ${exclusionReason}`,
            uiPayload: { kind: 'error', message: exclusionReason }
        };
    }

    const targetUri = vscode.Uri.file(path.join(ctx.workspaceRoot, filepath));

    // Guardrail: resolve the path and check it actually exists as a file.
    try {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.Directory) {
            const msg = `'${filepath}' is a directory, not a file. Use 'list_directory' instead.`;
            return {
                llmContent: `Error: ${msg}`,
                uiPayload: { kind: 'error', message: msg }
            };
        }
    } catch {
        const msg = `File '${filepath}' does not exist yet.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }

    const fileData = await vscode.workspace.fs.readFile(targetUri);
    const content = new TextDecoder().decode(fileData);

    // V2.2 hotfix #6: truncate the LLM-bound content for very large
    // files. The UI payload still gets the full file (so the user
    // can read everything in the rendered tool card), but the LLM
    // sees a 30KB head + a truncation note. This caps the per-read
    // contribution to context and makes runaway reads recoverable.
    return {
        llmContent: truncateForLlm(content, filepath),
        uiPayload: {
            kind: 'file_contents',
            filepath,
            content
        }
    };
};

registerTool(definition, executor);