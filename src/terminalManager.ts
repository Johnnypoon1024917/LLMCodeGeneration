import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export class TerminalManager {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel("NexusCode Agent");
    }

    /**
     * Executes a shell command in the specified directory and captures the output.
     * @param command The shell command to run (e.g., 'npm install').
     * @param workspacePath The working directory for the command.
     */
    public async runCommandWithCapture(command: string, workspacePath: string): Promise<{ success: boolean, output: string }> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\n[NexusCode] Executing: ${command}`);
        this.outputChannel.appendLine(`[NexusCode] CWD: ${workspacePath}`);

        return new Promise((resolve) => {
            // FIX: Inject the workspace path into the execution environment
            // This ensures tools like 'python' or 'node' can find local modules
            const envVars = { 
                ...process.env, 
                PYTHONPATH: workspacePath, 
                NODE_PATH: workspacePath 
            };

            cp.exec(command, { cwd: workspacePath, env: envVars }, (error, stdout, stderr) => {
                const fullOutput = `${stdout}\n${stderr}`.trim();
                
                if (fullOutput) {
                    this.outputChannel.appendLine(fullOutput);
                }

                if (error) {
                    this.outputChannel.appendLine(`[NexusCode] ⚠️ Command failed with error code: ${error.code}`);
                    resolve({ success: false, output: fullOutput || error.message });
                } else {
                    this.outputChannel.appendLine(`[NexusCode] ✅ Command succeeded.`);
                    resolve({ success: true, output: fullOutput });
                }
            });
        });
    }

    /**
     * NEW: Self-Evolution Trigger
     * Recompiles the extension source code and reloads the VS Code window.
     * Use this when the Agent edits its own source code.
     * @param extensionRoot The root directory of the extension (usually context.extensionUri.fsPath)
     */
    public async rebuildAndReload(extensionRoot: string): Promise<void> {
        this.outputChannel.appendLine(`\n[NexusCode] 🔄 STARTING SELF-EVOLUTION SEQUENCE...`);
        
        // 1. Install dependencies (just in case new packages were added)
        // this.outputChannel.appendLine(`[NexusCode] Step 1: Installing dependencies...`);
        // await this.runCommandWithCapture("npm install", extensionRoot);

        // 2. Compile the TypeScript source
        this.outputChannel.appendLine(`[NexusCode] Step 1: Recompiling Extension...`);
        const compileResult = await this.runCommandWithCapture("npm run compile", extensionRoot);

        if (!compileResult.success) {
            vscode.window.showErrorMessage("Self-Evolution Failed: Compilation Error. Check Output for details.");
            this.outputChannel.appendLine(`[NexusCode] ❌ CRITICAL: Compilation failed. Aborting reload.`);
            return;
        }

        // 3. Reload the Window
        this.outputChannel.appendLine(`[NexusCode] Step 2: Reloading Window...`);
        vscode.window.showInformationMessage("Extension updated successfully. Reloading...");
        
        // Give the user a moment to see the message
        setTimeout(() => {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
        }, 1500);
    }

    public dispose() {
        this.outputChannel.dispose();
    }
}