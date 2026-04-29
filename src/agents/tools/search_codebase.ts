// src/agents/tools/search_codebase.ts
//
// Plain-text search across the workspace. Q1=1C catalog item.
//
// Migrated from the previous agentTools.ts implementation. Behavior
// changes:
//   - UI payload is now `kind: 'search_matches'` so the UI can render
//     each match as a clickable row (open file at line) rather than
//     a string blob.
//   - LLM-bound content is the same human-readable format the model
//     was already trained on.
//
// Performance is unchanged: same 15-result cap, same exclude
// patterns, same fast `content.includes(query)` pre-filter before
// line-level splitting.

import * as vscode from 'vscode';
import { registerTool, type ToolExecutor } from '../toolRegistry';

const definition = {
    type: 'function' as const,
    function: {
        name: 'search_codebase',
        description: "Search the entire codebase for a specific keyword, function name, or variable. Returns matching file paths and the surrounding code.",
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: "The exact variable, function, or text to search for (e.g., 'calculateTax', 'AuthGuard')" }
            },
            required: ['keyword']
        }
    }
};

const MAX_RESULTS = 15;
const EXCLUDE_PATTERN = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/bin/**,**/.idea/**,**/__pycache__/**,**/*.class,**/*.o,**/*.pyc,**/*.exe,**/*.dll}';

const executor: ToolExecutor = async (args, _ctx) => {
    const keyword = String(args['keyword'] ?? '');
    if (!keyword) {
        return {
            llmContent: "Error: 'keyword' argument is required.",
            uiPayload: { kind: 'error', message: "'keyword' argument is required." }
        };
    }

    const uris = await vscode.workspace.findFiles('**/*.*', EXCLUDE_PATTERN);

    const matches: Array<{ filepath: string; line: number; text: string }> = [];
    const llmSnippets: string[] = [];

    for (const uri of uris) {
        if (matches.length >= MAX_RESULTS) break;
        try {
            const fileData = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(fileData);

            // Fast pre-filter: skip files that don't contain the keyword
            // anywhere. Avoids splitting lines for irrelevant files.
            if (!content.includes(keyword)) continue;

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (matches.length >= MAX_RESULTS) break;
                const line = lines[i];
                if (line === undefined || !line.includes(keyword)) continue;

                const relativePath = vscode.workspace.asRelativePath(uri);
                const snippet = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');

                matches.push({
                    filepath: relativePath,
                    line: i + 1,
                    text: line.trim()
                });
                llmSnippets.push(`File: ${relativePath} (Line ${i + 1})\nSnippet:\n${snippet}\n---`);
            }
        } catch {
            // Unreadable / binary files: skip. findFiles already filters
            // most of these via EXCLUDE_PATTERN, but some slip through
            // (e.g. unexpected binary in a *.txt file). Don't crash.
            continue;
        }
    }

    const llmContent = matches.length > 0
        ? llmSnippets.join('\n')
        : `No results found for '${keyword}'.`;

    return {
        llmContent,
        uiPayload: {
            kind: 'search_matches',
            matches
        }
    };
};

registerTool(definition, executor);