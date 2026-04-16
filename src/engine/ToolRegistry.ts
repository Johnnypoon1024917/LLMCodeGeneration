// src/engine/ToolRegistry.ts
import { BashTool } from './tools/BashTool';
import { ASTFileReadTool } from './tools/ASTFileReadTool';
import { FileEditTool } from './tools/FileEditTool';
import { ToolResult } from './types';

export class ToolRegistry {
    private bashTool: BashTool;
    private astTool: ASTFileReadTool;
    private fileEditTool: FileEditTool;

    constructor(workspaceRoot: string) {
        this.bashTool = new BashTool(workspaceRoot);
        this.astTool = new ASTFileReadTool(workspaceRoot);
        this.fileEditTool = new FileEditTool(workspaceRoot);
    }

    async execute(toolName: string, params: Record<string, string>): Promise<string> {
        let result: ToolResult;

        switch (toolName) {
            case 'bash':
                result = await this.bashTool.execute(params.command, params.cwd);
                break;
            case 'read_symbol':
                result = await this.astTool.readSymbol(params.file, params.symbol);
                break;
            case 'read_file':
                result = await this.astTool.readFullFile(params.file); 
                break;
            case 'edit_file':
                result = await this.fileEditTool.execute(params.file, params.search, params.replace);
                break;
            default:
                return `SYSTEM ERROR: Tool '${toolName}' does not exist.`;
        }

        return result.success 
            ? `[SUCCESS]\n${result.output}` 
            : `[ERROR]\n${result.output}\nPlease evaluate the error and try again.`;
    }
}