"use strict";
// src/agents/tools/write_file.ts
//
// Create or overwrite a file at a relative path. Q1=1C catalog item.
//
// New for 2B-2. Replaces the procedural verificationAgent.writeFile
// path for cases where the LLM wants to create/overwrite content
// directly (rather than emit SEARCH/REPLACE blocks for editing).
//
// Q4=4C: UI payload is `kind: 'diff'` showing the before/after pair.
// For new files the `before` is empty string; for overwrites it's
// the prior content. This lets the UI render a unified-diff view
// regardless of whether the file existed.
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
const _pathGuard_1 = require("./_pathGuard");
// V2.1.2 spec-fix-11 #3-DIAG: direct logger import for the wrong-file
// edit investigation. Will be removed when the diagnostic is concluded.
const logger_1 = require("../../logger");
const definition = {
    type: 'function',
    function: {
        name: 'write_file',
        description: "Create a new file or overwrite an existing one at a relative path. The file's parent directories are created if they don't exist. Use 'edit_file' instead for surgical changes to an existing file.",
        parameters: {
            type: 'object',
            properties: {
                filepath: { type: 'string', description: "The relative path to the file (e.g., 'src/utils/helper.ts')" },
                content: { type: 'string', description: "The complete file content. Will overwrite the file if it exists." }
            },
            required: ['filepath', 'content']
        }
    }
};
const executor = async (args, ctx) => {
    const filepath = String(args['filepath'] ?? '');
    const content = String(args['content'] ?? '');
    // ─── #3-DIAG (spec-fix-11) ─────────────────────────────────────
    // Wrong-file edit investigation. Log the filepath the LLM
    // actually passed to write_file. Cross-reference against the
    // Coordinator's dispatch log to detect "Coder ignored its
    // assigned file" failure mode.
    logger_1.log.info(`[#3-DIAG] write_file tool call received with path: "${filepath}" (content length: ${content.length} chars)`);
    // ───────────────────────────────────────────────────────────────
    if (!filepath) {
        return {
            llmContent: "Error: 'filepath' argument is required.",
            uiPayload: { kind: 'error', message: "'filepath' argument is required." }
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
    // Read prior content for the diff payload. Missing file = empty
    // before; we don't return an error because that's the expected
    // case for new file creation.
    let before = '';
    try {
        const priorData = await vscode.workspace.fs.readFile(targetUri);
        before = new TextDecoder().decode(priorData);
        // Refuse to write if the path is a directory. The fs.writeFile
        // would throw an OS error that's unhelpful; we surface a
        // structured error early.
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.Directory) {
            const msg = `'${filepath}' is a directory, not a file. Cannot overwrite.`;
            return {
                llmContent: `Error: ${msg}`,
                uiPayload: { kind: 'error', message: msg }
            };
        }
    }
    catch {
        // File doesn't exist yet — that's fine. before stays as ''.
    }
    // No-op detection: if the new content is identical to the existing
    // content, skip the write but still return a successful diff
    // payload so the UI can show "no changes." This avoids unnecessary
    // file modification timestamps and FS event churn.
    if (before === content) {
        return {
            llmContent: `No changes to '${filepath}' (file already matches the requested content).`,
            uiPayload: {
                kind: 'diff',
                filepath,
                before,
                after: content
            }
        };
    }
    // Ensure parent directory exists. createDirectory is idempotent
    // on existing dirs (vscode docs guarantee no-op for existing).
    const parentDir = path.dirname(filepath);
    if (parentDir && parentDir !== '.') {
        const parentUri = vscode.Uri.file(path.join(ctx.workspaceRoot, parentDir));
        try {
            await vscode.workspace.fs.createDirectory(parentUri);
        }
        catch (e) {
            // Directory creation can fail for legitimate reasons (path
            // collision with a file at intermediate level). Surface as
            // a structured error.
            const msg = `Cannot create parent directory for '${filepath}': ${e instanceof Error ? e.message : String(e)}`;
            return {
                llmContent: `Error: ${msg}`,
                uiPayload: { kind: 'error', message: msg }
            };
        }
    }
    const encoded = new TextEncoder().encode(content);
    await vscode.workspace.fs.writeFile(targetUri, encoded);
    const verb = before ? 'Overwrote' : 'Created';
    const llmContent = `${verb} ${filepath} (${content.split('\n').length} lines, ${encoded.byteLength} bytes).`;
    return {
        llmContent,
        uiPayload: {
            kind: 'diff',
            filepath,
            before,
            after: content
        }
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=write_file.js.map