// src/engine/tools/BashTool.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execPromise = promisify(exec);

export interface ToolResult {
    success: boolean;
    output: string;
}

export class BashTool {
    private readonly MAX_OUTPUT_LENGTH = 3000; // Prevent context window flooding
    private readonly TIMEOUT_MS = 15000; // 15 seconds max execution

    constructor(private allowedWorkspaceRoot: string) {}

    /**
     * Executes a bash command safely within the permitted workspace.
     */
    async execute(command: string, cwdRelative: string = '.'): Promise<ToolResult> {
        // 1. Security Gate: Prevent Directory Traversal
        const targetDir = path.resolve(this.allowedWorkspaceRoot, cwdRelative);
        if (!targetDir.startsWith(this.allowedWorkspaceRoot)) {
            return { 
                success: false, 
                output: "SECURITY ERROR: Attempted to execute command outside of allowed workspace." 
            };
        }

        try {
            // 2. Execute with strict constraints
            const { stdout, stderr } = await execPromise(command, { 
                cwd: targetDir, 
                timeout: this.TIMEOUT_MS,
                shell: '/bin/bash' // Standardize shell
            });

            const combinedOutput = `${stdout}\n${stderr}`.trim();
            
            // 3. Token-Optimization: Truncate massive outputs (e.g., npm install)
            return {
                success: true,
                output: this.truncate(combinedOutput) || "Command executed successfully with no output."
            };

        } catch (error: any) {
            // Provide deterministic error output for the self-healing loop
            return {
                success: false,
                output: `COMMAND FAILED (Code: ${error.code || 'UNKNOWN'}).\nError: ${this.truncate(error.message)}`
            };
        }
    }

    private truncate(text: string): string {
        if (text.length <= this.MAX_OUTPUT_LENGTH) return text;
        return `${text.substring(0, this.MAX_OUTPUT_LENGTH)}\n...[OUTPUT TRUNCATED FOR LENGTH]`;
    }
}