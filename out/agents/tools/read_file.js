"use strict";
// src/agents/tools/read_file.ts
//
// Read a file's contents from the workspace.
//
// Migrated from the previous in-line implementation in agentTools.ts.
// Behavior is unchanged for the LLM; the new shape returns a
// ToolDispatchResult with `kind: 'file_contents'` UI payload that
// the UI can render as a syntax-highlighted preview.
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
const _contextExclusions_1 = require("./_contextExclusions");
const definition = {
    type: 'function',
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
const executor = async (args, ctx) => {
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
    const pathError = (0, _pathGuard_1.validateWorkspacePath)(filepath, 'filepath');
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
    const exclusionReason = (0, _contextExclusions_1.checkExclusion)(filepath);
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
    }
    catch {
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
        llmContent: (0, _contextExclusions_1.truncateForLlm)(content, filepath),
        uiPayload: {
            kind: 'file_contents',
            filepath,
            content
        }
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=read_file.js.map