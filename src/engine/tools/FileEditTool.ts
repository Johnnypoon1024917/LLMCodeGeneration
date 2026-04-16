// src/engine/tools/FileEditTool.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolResult } from '../types';

export class FileEditTool {
    constructor(private workspaceRoot: string) {}

    /**
     * Executes a precise search-and-replace modification.
     * The LLM must output the exact existing string block, and the new string block.
     */
    async execute(filePath: string, searchBlock: string, replaceBlock: string): Promise<ToolResult> {
        const fullPath = path.resolve(this.workspaceRoot, filePath);
        
        try {
            const fileContent = await fs.readFile(fullPath, 'utf8');
            
            // Strict QA check: Prevent hallucinated replacements
            if (!fileContent.includes(searchBlock)) {
                return {
                    success: false,
                    output: `ERROR: The exact search block was not found in ${filePath}. Ensure you have exact matching indentation and characters without omitting anything.`
                };
            }

            const updatedContent = fileContent.replace(searchBlock, replaceBlock);
            await fs.writeFile(fullPath, updatedContent, 'utf8');

            return {
                success: true,
                output: `Successfully modified ${filePath}.`
            };
        } catch (error: any) {
            return {
                success: false,
                output: `ERROR: Failed to edit ${filePath}. ${error.message}`
            };
        }
    }
}