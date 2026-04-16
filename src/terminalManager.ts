import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class TerminalManager {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("NexusCode Agent");
    }

    /**
     * Executes a shell command using cp.spawn for live streaming to the UI.
     * Strips ANSI codes for safe LLM ingestion.
     */
    public async runCommandWithCapture(
        command: string, 
        workspacePath: string, 
        onStream?: (chunk: string) => void
    ): Promise<{ success: boolean; output: string; code: number | null }> {
        
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n[NexusCode] Executing: ${command}`);
        this.outputChannel.appendLine(`[NexusCode] CWD: ${workspacePath}`);

        return new Promise((resolve) => {
            const envVars = { 
                ...process.env, 
                PYTHONPATH: workspacePath, 
                NODE_PATH: workspacePath 
            };

            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const args = isWin ? ['/c', command] : ['-c', command];

            // Spawn allows us to stream data live!
            const child = cp.spawn(shell, args, { cwd: workspacePath, env: envVars, shell: false });

            let fullOutput = '';

            const handleChunk = (data: Buffer) => {
                const rawText = data.toString();
                this.outputChannel.append(rawText); // Send to VS Code Output tab

                // Strip ANSI Color Codes so the LLM doesn't choke on formatting garbage
                const cleanText = rawText.replace(/\x1b\[[0-9;]*m/g, '');
                fullOutput += cleanText;
                
                // Stream to the React UI!
                if (onStream) { onStream(cleanText); }
            };

            child.stdout.on('data', handleChunk);
            child.stderr.on('data', handleChunk);

            child.on('error', (error) => {
                this.outputChannel.appendLine(`[NexusCode] ⚠️ Process Error: ${error.message}`);
                resolve({ success: false, output: fullOutput + `\nPROCESS ERROR: ${error.message}`, code: -1 });
            });

            child.on('close', (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine(`\n[NexusCode] ✅ Command succeeded.`);
                } else {
                    this.outputChannel.appendLine(`\n[NexusCode] ⚠️ Command failed with code: ${code}`);
                }
                resolve({ success: code === 0, output: fullOutput, code });
            });
        });
    }

    /**
     * NEW: Self-Evolution Trigger
     * Recompiles the extension source code and reloads the VS Code window.
     */
    public async rebuildAndReload(extensionRoot: string): Promise<void> {
        this.outputChannel.appendLine(`\n[NexusCode] 🔄 STARTING SELF-EVOLUTION SEQUENCE...`);
        
        this.outputChannel.appendLine(`[NexusCode] Step 1: Recompiling Extension...`);
        const compileResult = await this.runCommandWithCapture("npm run compile", extensionRoot);

        if (!compileResult.success) {
            vscode.window.showErrorMessage("Self-Evolution Failed: Compilation Error. Check Output for details.");
            this.outputChannel.appendLine(`[NexusCode] ❌ CRITICAL: Compilation failed. Aborting reload.`);
            return;
        }

        this.outputChannel.appendLine(`[NexusCode] Step 2: Reloading Window...`);
        vscode.window.showInformationMessage("Extension updated successfully. Reloading...");
        
        setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
        }, 1500);
    }

    public dispose() {
        this.outputChannel.dispose();
    }
}