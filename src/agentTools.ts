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
            return entries.map(([name, type]) => {
                return type === vscode.FileType.Directory ? `[DIR] ${name}` : `[FILE] ${name}`;
            }).join('\n');
        }

        return `Error: Tool ${toolName} not found.`;

    } catch (error) {
        return `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
}