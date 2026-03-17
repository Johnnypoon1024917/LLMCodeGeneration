"use strict";
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
exports.agentToolDefinitions = void 0;
exports.executeAgentTool = executeAgentTool;
// src/agentTools.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
exports.agentToolDefinitions = [
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
async function executeAgentTool(toolCall, workspaceRoot) {
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
            }
            catch (err) {
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
            }
            catch (err) {
                return `Error: Directory '${args.dirpath}' does not exist yet.`;
            }
            const entries = await vscode.workspace.fs.readDirectory(targetUri);
            if (entries.length === 0)
                return `Directory '${args.dirpath}' is empty.`;
            return entries.map(([name, type]) => {
                return type === vscode.FileType.Directory ? `[DIR] ${name}` : `[FILE] ${name}`;
            }).join('\n');
        }
        else if (toolName === "search_codebase") {
            const query = args.keyword;
            const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,go,rs,css,html}', '**/node_modules/**', 20);
            let results = [];
            for (const uri of uris) {
                const fileData = await vscode.workspace.fs.readFile(uri);
                const content = new TextDecoder().decode(fileData);
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(query)) {
                        const relativePath = vscode.workspace.asRelativePath(uri);
                        const snippet = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
                        results.push(`File: ${relativePath} (Line ${i + 1})\nSnippet:\n${snippet}\n---`);
                        break;
                    }
                }
            }
            return results.length > 0 ? results.join('\n') : `No results found for '${query}'.`;
        }
        return `Error: Tool ${toolName} not found.`;
    }
    catch (error) {
        return `Error executing ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
}
//# sourceMappingURL=agentTools.js.map