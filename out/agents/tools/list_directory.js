"use strict";
// src/agents/tools/list_directory.ts
//
// List files and folders inside a directory.
//
// Migrated from agentTools.ts. UI payload is `kind: 'directory'`,
// letting the UI render a tree-style display rather than a flat
// "[DIR] foo / [FILE] bar.ts" string.
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
        name: 'list_directory',
        description: "List all files and folders inside a specific directory. Use this to find out what files exist in a folder.",
        parameters: {
            type: 'object',
            properties: {
                dirpath: { type: 'string', description: "The relative path to the directory (e.g., 'src/components')" }
            },
            required: ['dirpath']
        }
    }
};
/**
 * Map a vscode.FileType to our protocol's coarser tri-state. We
 * collapse `Unknown` into `file` because the LLM doesn't have any
 * useful action to take on an unknown entry beyond reading it.
 */
function fileTypeToKind(t) {
    if (t === vscode.FileType.Directory) {
        return 'dir';
    }
    if (t & vscode.FileType.SymbolicLink) {
        return 'symlink';
    }
    return 'file';
}
const executor = async (args, ctx) => {
    const dirpath = String(args['dirpath'] ?? '');
    if (!dirpath) {
        return {
            llmContent: "Error: 'dirpath' argument is required.",
            uiPayload: { kind: 'error', message: "'dirpath' argument is required." }
        };
    }
    // Hotfix (post-2B): reject absolute paths. See _pathGuard rationale.
    const pathError = (0, _pathGuard_1.validateWorkspacePath)(dirpath, 'dirpath');
    if (pathError) {
        return {
            llmContent: `Error: ${pathError}`,
            uiPayload: { kind: 'error', message: pathError }
        };
    }
    const targetUri = vscode.Uri.file(path.join(ctx.workspaceRoot, dirpath));
    try {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type !== vscode.FileType.Directory && stat.type !== (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) {
            const msg = `'${dirpath}' is a file, not a directory. Use 'read_file' instead.`;
            return {
                llmContent: `Error: ${msg}`,
                uiPayload: { kind: 'error', message: msg }
            };
        }
    }
    catch {
        const msg = `Directory '${dirpath}' does not exist yet.`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    const entries = await vscode.workspace.fs.readDirectory(targetUri);
    // V2.2 hotfix #6: filter context-bloat entries from the LLM-bound
    // listing. node_modules, .git, dist, etc. are filtered out. The
    // UI payload still gets the full unfiltered list (so the user
    // can see what's actually there), but the LLM only sees relevant
    // entries. A hidden-count note tells the agent things were
    // filtered, so if the agent genuinely needs to inspect node_modules
    // it knows to ask the user rather than thinking the directory
    // doesn't have those entries.
    const llmEntries = entries.filter(([name]) => !(0, _contextExclusions_1.shouldExcludeFromListing)(name));
    const hiddenCount = entries.length - llmEntries.length;
    // Empty directory: still return a directory payload with no entries.
    // UI renders this as an empty tree (clearer than a generic "empty"
    // string), and the LLM still gets useful context.
    let llmLines;
    if (entries.length === 0) {
        llmLines = `Directory '${dirpath}' is empty.`;
    }
    else if (llmEntries.length === 0) {
        // All entries were filtered (e.g., listing a node_modules root).
        llmLines = `Directory '${dirpath}' contains only build artifacts / dependencies / caches (${hiddenCount} hidden entries). Look for source code in src/ or similar.`;
    }
    else {
        const listing = llmEntries
            .map(([name, type]) => {
            const kind = fileTypeToKind(type);
            return kind === 'dir' ? `[DIR] ${name}` : kind === 'symlink' ? `[LINK] ${name}` : `[FILE] ${name}`;
        })
            .join('\n');
        llmLines = hiddenCount > 0
            ? `${listing}\n\n[... ${hiddenCount} entr${hiddenCount === 1 ? 'y' : 'ies'} hidden: build artifacts / dependencies / caches ...]`
            : listing;
    }
    return {
        llmContent: llmLines,
        uiPayload: {
            kind: 'directory',
            path: dirpath,
            entries: entries.map(([name, type]) => ({ name, kind: fileTypeToKind(type) }))
        }
    };
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=list_directory.js.map