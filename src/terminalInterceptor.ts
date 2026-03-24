import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';

export function activateTerminalInterceptor(sidebarProvider: SidebarProvider, context: vscode.ExtensionContext) {
    console.log("[DEBUG-TERM] 🛡️ Terminal Interceptor Online.");

    // 🔥 A memory buffer to hold the output of commands while they are running
    const executionOutputs = new Map<vscode.TerminalShellExecution, string>();

    // =========================================================================
    // 1. HOOK THE START: Start recording the stream the moment a command runs
    // =========================================================================
    context.subscriptions.push(
        vscode.window.onDidStartTerminalShellExecution(async (event) => {
            let output = "";
            executionOutputs.set(event.execution, output);

            try {
                // Continuously read the native async stream while the command executes
                for await (const data of event.execution.read()) {
                    output += data;
                    executionOutputs.set(event.execution, output);
                }
            } catch (e) {
                // Ignore stream read errors
            }
        })
    );

    // =========================================================================
    // 2. HOOK THE END: Check if it crashed, read the buffer, and Auto-Fix!
    // =========================================================================
    context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution(async (event) => {
            // Grab the recorded output and immediately free the memory
            const output = executionOutputs.get(event.execution) || "";
            executionOutputs.delete(event.execution); 

            // If the command succeeded (exit code 0) or was cancelled, ignore it completely.
            if (event.exitCode === 0 || event.exitCode === undefined) return;

            // Clean the output (Strip ANSI color escape codes so the LLM can read it cleanly)
            const cleanError = output.replace(/\x1b\[[0-9;]*m/g, '').trim();

            // Heuristic: Ignore tiny OS typos (like 'sl' instead of 'ls'). 
            // Only trigger if it looks like a real code crash. Added 'MODULE_NOT_FOUND' to catch your exact error!
            if (cleanError.length < 20 || (!cleanError.includes('Error') && !cleanError.includes('Exception') && !cleanError.includes('ERR!') && !cleanError.includes('Traceback') && !cleanError.includes('MODULE_NOT_FOUND'))) {
                return;
            }

            const commandString = event.execution.commandLine?.value || "The command";

            // Pop the Kiro-style notification!
            const action = await vscode.window.showErrorMessage(
                `NexusCode: "${commandString}" crashed. Want me to analyze and auto-fix the error?`,
                "🛠️ Auto-Fix", "Ignore"
            );

            if (action === "🛠️ Auto-Fix") {
                // Extract the last 1500 characters so we capture the stack trace without blowing up LLM token limits
                const truncatedError = cleanError.slice(-1500);

                const autoFixPrompt = `I ran the command \`${commandString}\` in my terminal and it crashed with this error:\n\n\`\`\`\n${truncatedError}\n\`\`\`\n\nPlease find the bug in my workspace and fix it.`;

                // Force the sidebar open if it's closed
                await vscode.commands.executeCommand('nexuscode-sidebar.focus');

                // Send the prompt to our React UI to kick off the full 3-Pillar Context & Execution Pipeline!
                sidebarProvider.injectTerminalTask(autoFixPrompt);
            }
        })
    );
}