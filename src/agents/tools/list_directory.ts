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
    if (t === vscode.FileType.Directory) return 'dir';
    if (t & vscode.FileType.SymbolicLink) return 'symlink';
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

    // Empty directory: still return a directory payload with no entries.
    // UI renders this as an empty tree (clearer than a generic "empty"
    // string), and the LLM still gets useful context.
    const llmLines = entries.length === 0
        ? `Directory '${dirpath}' is empty.`
        : entries
            .map(([name, type]) => {
                const kind = fileTypeToKind(type);
                return kind === 'dir' ? `[DIR] ${name}` : kind === 'symlink' ? `[LINK] ${name}` : `[FILE] ${name}`;
            })
            .join('\n');

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