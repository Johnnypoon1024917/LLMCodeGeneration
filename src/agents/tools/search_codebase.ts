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

// Hotfix (post-2B): block low-value generic keywords. When a model
// degenerates (often under heavy quantization or after running out of
// real exploration ideas), it starts emitting searches for language
// keywords like `if`, `for`, `function`, `import`. These match every
// file in the project — the model gets a flood of irrelevant results,
// can't distill anything useful, and falls into a runaway loop of
// more bad searches.
//
// The honest fix at the tool boundary: reject these queries up front
// with a corrective message that points the model at productive
// alternatives (concrete identifiers like component names, function
// names, route paths). This is cheaper than burning 50+ failed tool
// calls before MAX_STEPS aborts.
//
// We're deliberately narrow: this list is JS/TS-keyword-heavy (the
// dominant language in this codebase). It does NOT include domain
// terms like `App`, `User`, `Component`, `Header` — those are weak
// but legitimate searches in some scenarios. The deny-list is the
// minimum to break the runaway-search pattern observed in the wild.
//
// If a user has a legitimate need to search for one of these tokens,
// they can search for a more specific phrase (`if (user`, `import {`).
const LOW_VALUE_KEYWORDS = new Set([
    // JS/TS control flow
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'return', 'throw', 'try', 'catch', 'finally',
    // JS/TS declarations
    'const', 'let', 'var', 'function', 'class', 'interface', 'type',
    'enum', 'module', 'namespace',
    // JS/TS modifiers / operators / literals
    'import', 'export', 'default', 'from', 'as', 'new', 'this',
    'super', 'static', 'async', 'await', 'yield', 'void', 'typeof',
    'instanceof', 'in', 'of', 'true', 'false', 'null', 'undefined',
    // Common one-letter / generic noise
    'a', 'b', 'c', 'd', 'e', 'i', 'j', 'k', 'n', 'x', 'y'
]);

const executor: ToolExecutor = async (args, _ctx) => {
    const keyword = String(args['keyword'] ?? '');
    if (!keyword) {
        return {
            llmContent: "Error: 'keyword' argument is required.",
            uiPayload: { kind: 'error', message: "'keyword' argument is required." }
        };
    }

    // Hotfix (post-2B): check for low-value keywords before doing the
    // expensive workspace.findFiles + content.includes loop.
    const trimmed = keyword.trim();
    if (trimmed.length < 3) {
        const msg =
            `Keyword '${keyword}' is too short (minimum 3 characters). ` +
            `Search for distinctive identifiers like function names, component names, ` +
            `or specific phrases (e.g., 'calculateTax', 'AuthGuard', 'useEffect(').`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    if (LOW_VALUE_KEYWORDS.has(trimmed.toLowerCase())) {
        const msg =
            `Keyword '${keyword}' is a generic language token that appears in nearly every file. ` +
            `Searching for it will return too much noise to be useful. ` +
            `Search for distinctive identifiers like function names, component names, route paths, ` +
            `or multi-word phrases instead (e.g., 'NavigationBar', 'useState(', 'BrowserRouter').`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }

    const uris = await vscode.workspace.findFiles('**/*.*', EXCLUDE_PATTERN);

    const matches: Array<{ filepath: string; line: number; text: string }> = [];
    const llmSnippets: string[] = [];

    for (const uri of uris) {
        if (matches.length >= MAX_RESULTS) { break; }
        try {
            const fileData = await vscode.workspace.fs.readFile(uri);
            const content = new TextDecoder().decode(fileData);

            // Fast pre-filter: skip files that don't contain the keyword
            // anywhere. Avoids splitting lines for irrelevant files.
            if (!content.includes(keyword)) { continue; }

            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (matches.length >= MAX_RESULTS) { break; }
                const line = lines[i];
                if (line === undefined || !line.includes(keyword)) { continue; }

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