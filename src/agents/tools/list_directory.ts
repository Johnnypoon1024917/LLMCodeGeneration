// src/agents/tools/list_directory.ts
//
// List files and folders inside a directory.
//
// Migrated from agentTools.ts. UI payload is `kind: 'directory'`,
// letting the UI render a tree-style display rather than a flat
// "[DIR] foo / [FILE] bar.ts" string.

import * as vscode from 'vscode';
import * as path from 'path';
import { registerTool, type ToolExecutor } from '../toolRegistry';
import { validateWorkspacePath } from './_pathGuard';
import { shouldExcludeFromListing } from './_contextExclusions';

const definition = {
    type: 'function' as const,
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
function fileTypeToKind(t: vscode.FileType): 'file' | 'dir' | 'symlink' {
    if (t === vscode.FileType.Directory) { return 'dir'; }
    if (t & vscode.FileType.SymbolicLink) { return 'symlink'; }
    return 'file';
}

const executor: ToolExecutor = async (args, ctx) => {
    const dirpath = String(args['dirpath'] ?? '');
    if (!dirpath) {
        return {
            llmContent: "Error: 'dirpath' argument is required.",
            uiPayload: { kind: 'error', message: "'dirpath' argument is required." }
        };
    }

    // Hotfix (post-2B): reject absolute paths. See _pathGuard rationale.
    const pathError = validateWorkspacePath(dirpath, 'dirpath');
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
    } catch {
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
    const llmEntries = entries.filter(([name]) => !shouldExcludeFromListing(name));
    const hiddenCount = entries.length - llmEntries.length;

    // Empty directory: still return a directory payload with no entries.
    // UI renders this as an empty tree (clearer than a generic "empty"
    // string), and the LLM still gets useful context.
    let llmLines: string;
    if (entries.length === 0) {
        llmLines = `Directory '${dirpath}' is empty.`;
    } else if (llmEntries.length === 0) {
        // All entries were filtered (e.g., listing a node_modules root).
        llmLines = `Directory '${dirpath}' contains only build artifacts / dependencies / caches (${hiddenCount} hidden entries). Look for source code in src/ or similar.`;
    } else {
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

registerTool(definition, executor);