// src/agentTools.ts
import * as vscode from 'vscode';
import * as path from 'path';

export const agentToolDefinitions = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a specific file in the codebase. Use this to understand existing code, interfaces, or logic.",
            parameters: {
                type: "object",
                properties: {
                    filepath: { type: "string", description: "The relative path to the file (e.g., 'src/utils/api.ts')" }
                },
                required: ["filepath"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_directory",
            description: "List all files and folders inside a specific directory. Use this to find out what files exist in a folder.",
            parameters: {
                type: "object",
                properties: {
                    dirpath: { type: "string", description: "The relative path to the directory (e.g., 'src/components')" }
                },
                required: ["dirpath"]
            }
        }
    },
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
            
            // 🛡️ Guardrail: Check if path exists and is actually a file
            try {
                const stat = await vscode.workspace.fs.stat(targetUri);
                if (stat.type === vscode.FileType.Directory) {
                    return `Error: '${args.filepath}' is a directory, not a file. Use 'list_directory' instead.`;
                }
            } catch (err) {
                return `Error: File '${args.filepath}' does not exist yet.`;
            }

            const fileData = await vscode.workspace.fs.readFile(targetUri);
            return new TextDecoder().decode(fileData);
        } 
        
        else if (toolName === "list_directory") {
            const targetUri = vscode.Uri.file(path.join(workspaceRoot, args.dirpath));
            
            // 🛡️ Guardrail: Check if path exists and is actually a directory
            try {
                const stat = await vscode.workspace.fs.stat(targetUri);
                if (stat.type !== vscode.FileType.Directory && stat.type !== (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) {
                    return `Error: '${args.dirpath}' is a file, not a directory. Use 'read_file' instead.`;
                }
            } catch (err) {
                return `Error: Directory '${args.dirpath}' does not exist yet.`;
            }

            const entries = await vscode.workspace.fs.readDirectory(targetUri);
            if (entries.length === 0) return `Directory '${args.dirpath}' is empty.`;
            
            return entries.map(([name, type]) => {
                return type === vscode.FileType.Directory ? `[DIR] ${name}` : `[FILE] ${name}`;
            }).join('\n');
        }

        else if (toolName === "search_codebase") {
            const query = args.keyword;
            // 🚀 POLYGLOT SEARCH: Search ALL text files, aggressively ignoring binary/compiled directories
            const uris = await vscode.workspace.findFiles(
                '**/*.*', 
                '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/bin/**,**/.idea/**,**/__pycache__/**,**/*.class,**/*.o,**/*.pyc,**/*.exe,**/*.dll}'
            );
            
            let results = [];
            for (const uri of uris) {
                try {
                    const fileData = await vscode.workspace.fs.readFile(uri);
                    const content = new TextDecoder().decode(fileData);
                    
                    // Fast check before splitting lines
                    if (content.includes(query)) {
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].includes(query)) {
                                const relativePath = vscode.workspace.asRelativePath(uri);
                                const snippet = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
                                results.push(`File: ${relativePath} (Line ${i+1})\nSnippet:\n${snippet}\n---`);
                                
                                // 🚀 FIX: Cap results to prevent token window overflow
                                if (results.length >= 15) break; 
                            }
                        }
                    }
                } catch (e) {
                    continue; // Skip unreadable or binary files safely
                }
                
                if (results.length >= 15) break; // Break outer loop if limit reached
            }
            
            return results.length > 0 ? results.join('\n') : `No results found for '${query}'.`;
        }

        return `Error: Tool ${toolName} not found.`;

    } catch (error) {
        return `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
}