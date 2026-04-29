// src/agents/tools/edit_file.ts
//
// Apply a search/replace patch to an existing file. Q1=1C catalog item.
//
// New for 2B-2. Uses the existing `applyBlock` utility (battle-tested
// from Coordinator + verificationAgent's prior usage) which has tiered
// matching: exact → trailing-whitespace-insensitive → leading-indent-
// tolerant. If no tier finds a unique match, the edit fails with a
// structured error rather than corrupting the file.
//
// Q4=4C: UI payload is `kind: 'diff'` with before/after.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool, type ToolExecutor } from '../toolRegistry';
import { applyBlock } from '../../utilities/searchReplace';
import { validateWorkspacePath } from './_pathGuard';

const definition = {
    type: 'function' as const,
    function: {
        name: 'edit_file',
        description: "Apply a surgical edit to an existing file by replacing a specific block of text. The 'old_text' must match exactly (or with tolerant whitespace handling). Use 'write_file' when you want to overwrite the entire file.",
        parameters: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: "The relative path to the file to edit." },
                old_text: { type: 'string', description: "The exact text to find in the file. Must be unique within the file." },
                new_text: { type: 'string', description: "The replacement text. Use empty string to delete the matched block." }
            },
            required: ['filepath', 'old_text', 'new_text']
        }
    }
};

const executor: ToolExecutor = async (args, ctx) => {
    const filepath = String(args['filepath'] ?? '');
    const oldText = String(args['old_text'] ?? '');
    const newText = String(args['new_text'] ?? '');

    if (!filepath) {
        return {
            llmContent: "Error: 'filepath' argument is required.",
            uiPayload: { kind: 'error', message: "'filepath' argument is required." }
        };
    }
    if (!oldText) {
        return {
            llmContent: "Error: 'old_text' must be non-empty. To create a new file, use 'write_file' instead.",
            uiPayload: { kind: 'error', message: "'old_text' must be non-empty." }
        };
    }

    // Hotfix (post-2B): reject absolute paths. See _pathGuard rationale.
    const pathError = validateWorkspacePath(filepath, 'filepath');
    if (pathError) {
        return {
            llmContent: `Error: ${pathError}`,
            uiPayload: { kind: 'error', message: pathError }
        };
    }

    const targetUri = vscode.Uri.file(path.join(ctx.workspaceRoot, filepath));

    let before: string;
    try {
        const fileData = await vscode.workspace.fs.readFile(targetUri);
        before = new TextDecoder().decode(fileData);
    } catch {
        const msg = `File '${filepath}' does not exist. Use 'write_file' to create it.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }

    // applyBlock throws on no-unique-match. Wrap in try/catch and
    // surface a structured error.
    let after: string;
    try {
        // blockOffset is used for diagnostics (line numbers in error
        // messages); we don't have a meaningful offset since we're
        // constructing the block synthetically from JSON args, so 0
        // is fine. The parse-error code path in searchReplace.ts that
        // uses offset is upstream of applyBlock.
        after = applyBlock(before, { search: oldText, replace: newText, blockOffset: 0 });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            llmContent: `Error applying edit to '${filepath}': ${msg}`,
            uiPayload: { kind: 'error', message: `Edit failed: ${msg}` }
        };
    }

    if (before === after) {
        // The match was found but the replacement is identical to the
        // original. This is technically a successful edit but worth
        // flagging so the LLM doesn't think it changed something it
        // didn't. (Most likely: the model emitted a noop edit by
        // accident.)
        return {
            llmContent: `No changes to '${filepath}' (replacement was identical to original).`,
            uiPayload: { kind: 'diff', filepath, before, after }
        };
    }

    const encoded = new TextEncoder().encode(after);
    await vscode.workspace.fs.writeFile(targetUri, encoded);

    return {
        llmContent: `Edited ${filepath} (${after.split('\n').length} lines after edit).`,
        uiPayload: { kind: 'diff', filepath, before, after }
    };
};

registerTool(definition, executor);