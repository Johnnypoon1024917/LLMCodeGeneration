// src/agentTools.ts
import * as vscode from 'vscode';
import * as path from 'path';

export const agentToolDefinitions = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a specific file.",
            parameters: {
                type: "object",
                properties: { filepath: { type: "string" } },
                required: ["filepath"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List all files and folders inside a specific directory.",
            parameters: {
                type: "object",
                properties: { dirpath: { type: "string" } },
                required: ["dirpath"]
            }
        }
    },
    // 🔥 NEW TOOL: Codebase Search
    {
        type: "function",
        function: {
            name: "search_codebase",
            description: "Search the entire codebase for a specific keyword, function name, or variable. Returns matching file paths and the surrounding code.",
            parameters: {
                type: "object",
                properties: { 
                    keyword: { type: "string", description: "The exact variable, function, or text to search for (e.g., 'calculateTax', 'AuthGuard')" }
                },
                required: ["keyword"]
            }
        }
    }
];

export async function executeAgentTool(toolCall: any, workspaceRoot: string): Promise<string> {
    const args = JSON.parse(toolCall.function.arguments);
    const toolName = toolCall.function.name;

    try {
        if (toolName === "read_file") {
            const targetUri = vscode.Uri.file(path.join(workspaceRoot, args.filepath));
            const fileData = await vscode.workspace.fs.readFile(targetUri);
            return new TextDecoder().decode(fileData);
        } 
        else if (toolName === "list_directory") {
            const targetUri = vscode.Uri.file(path.join(workspaceRoot, args.dirpath));
            const entries = await vscode.workspace.fs.readDirectory(targetUri);
            return entries.map(([name, type]) => type === vscode.FileType.Directory ? `[DIR] ${name}` : `[FILE] ${name}`).join('\n');
        }
        // 🔥 NEW TOOL LOGIC: Execute a Workspace-wide search
        else if (toolName === "search_codebase") {
            const query = args.keyword;
            // Use VS Code's ultra-fast internal findFiles
            const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,go,rs,css}', '**/node_modules/**', 20);
            
            let results = [];
            for (const uri of uris) {
                const fileData = await vscode.workspace.fs.readFile(uri);
                const content = new TextDecoder().decode(fileData);
                const lines = content.split('\n');
                
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(query)) {
                        const relativePath = vscode.workspace.asRelativePath(uri);
                        // Grab 2 lines of context above and below the match
                        const snippet = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
                        results.push(`File: ${relativePath} (Line ${i+1})\nSnippet:\n${snippet}\n---`);
                        break; // Only grab the first match per file to save tokens
                    }
                }
            }
            return results.length > 0 ? results.join('\n') : `No results found for '${query}'.`;
        }

        return `Error: Tool ${toolName} not found.`;
    } catch (error) {
        return `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
}