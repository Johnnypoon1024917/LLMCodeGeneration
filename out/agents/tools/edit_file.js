"use strict";
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
const searchReplace_1 = require("../../utilities/searchReplace");
const _pathGuard_1 = require("./_pathGuard");
// V2.1.2 spec-fix-11 #3-DIAG: direct logger import for the wrong-file
// edit investigation. Will be removed when the diagnostic is concluded.
const logger_1 = require("../../logger");
const definition = {
    type: 'function',
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
const executor = async (args, ctx) => {
    const filepath = String(args['filepath'] ?? '');
    const oldText = String(args['old_text'] ?? '');
    const newText = String(args['new_text'] ?? '');
    // ─── #3-DIAG (spec-fix-11) ─────────────────────────────────────
    // Wrong-file edit investigation. Log the filepath the LLM passed.
    // Cross-reference against Coordinator dispatch log to detect
    // "Coder edited a different file than assigned" failure mode.
    logger_1.log.info(`[#3-DIAG] edit_file tool call received with path: "${filepath}" (old_text length: ${oldText.length}, new_text length: ${newText.length})`);
    // ───────────────────────────────────────────────────────────────
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
    const pathError = (0, _pathGuard_1.validateWorkspacePath)(filepath, 'filepath');
    if (pathError) {
        return {
            llmContent: `Error: ${pathError}`,
            uiPayload: { kind: 'error', message: pathError }
        };
    }
    const targetUri = vscode.Uri.file(path.join(ctx.workspaceRoot, filepath));
    let before;
    try {
        const fileData = await vscode.workspace.fs.readFile(targetUri);
        before = new TextDecoder().decode(fileData);
    }
    catch {
        const msg = `File '${filepath}' does not exist. Use 'write_file' to create it.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    // applyBlock throws on no-unique-match. Wrap in try/catch and
    // surface a structured error.
    let after;
    try {
        // blockOffset is used for diagnostics (line numbers in error
        // messages); we don't have a meaningful offset since we're
        // constructing the block synthetically from JSON args, so 0
        // is fine. The parse-error code path in searchReplace.ts that
        // uses offset is upstream of applyBlock.
        after = (0, searchReplace_1.applyBlock)(before, { search: oldText, replace: newText, blockOffset: 0 });
    }
    catch (e) {
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
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=edit_file.js.map