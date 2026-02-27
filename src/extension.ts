import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { ProvenanceTracker } from './provenanceTracker';
import { AILensProvider } from './AILensProvider'; // Import new provider
import { TerminalManager } from './terminalManager';

export function activate(context: vscode.ExtensionContext) {
    const terminalManager = new TerminalManager();
    const lensProvider = new AILensProvider();

    // Register the floating toolbar provider

    const selector: vscode.DocumentSelector = [
        { language: '*', scheme: '*' }
    ];

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(selector, lensProvider)
    );


    const provenanceTracker = new ProvenanceTracker(lensProvider);
    const sidebarProvider = new SidebarProvider(context.extensionUri);

    // We pass the tracker to the sidebar so it can flag LLM edits when applying code
    sidebarProvider.setProvenanceTracker(provenanceTracker);
    sidebarProvider.setTerminalManager(terminalManager);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                // 1. Force the CodeLens provider to wake up and redraw the buttons
                lensProvider.refresh();

                // 2. Re-apply the purple highlight to the new editor instance
                provenanceTracker.restoreDecorations(editor);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            // Optional: clear edits for this specific URI to keep the memory clean
            const tasksToClear = lensProvider.pendingEdits
                .filter(e => e.uri.toString() === doc.uri.toString())
                .map(e => e.taskId);

            tasksToClear.forEach(id => lensProvider.clearEdit(id));
        })
    );

    // Register the Webview UI
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "qwen-sidebar",
            sidebarProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true // <--- THIS IS THE MAGIC LINE
                }
            }
        )
    );

    // Register the Accept/Reject commands triggered by the floating toolbar
    context.subscriptions.push(vscode.commands.registerCommand('nexuscode.acceptEdit', async (taskId, uri) => {
        // 1. Tell the tracker to clear the UI and mark as approved
        provenanceTracker.handleAccept(taskId, uri);

        // 2. 🔥 NEW: Save the file and run the correct build command
        await sidebarProvider.handlePostApproval(uri);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('nexuscode.rejectEdit', async (taskId, uri) => {
        await provenanceTracker.handleReject(taskId, uri);
    }));
    // src/extension.ts (inside your viewDiff command)
    context.subscriptions.push(vscode.commands.registerCommand('nexuscode.viewDiff', async (taskId, uri) => {
        const snapshots = provenanceTracker.getPendingCode(taskId);
        if (snapshots) {
            await provenanceTracker.showDiff(snapshots.original, snapshots.proposed, taskId);
        }
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('nexuscode.reviewCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selectedText = editor.document.getText(editor.selection);
            if (!selectedText) {
                vscode.window.showWarningMessage("Please highlight some code to review.");
                return;
            }

            // Send the code to the Webview
            sidebarProvider._view?.webview.postMessage({
                type: 'requestReview',
                code: selectedText
            });

            // Focus the sidebar so the user sees the result
            await vscode.commands.executeCommand('qwen-sidebar.focus');
        })
    );

    vscode.commands.registerCommand('nexuscode.optimizeSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.document.getText(editor.selection);

        // Notify the Webview
        sidebarProvider._view?.webview.postMessage({
            type: 'requestReview',
            code: selection
        });

        // Focus the sidebar automatically
        await vscode.commands.executeCommand('qwen-sidebar.focus');
    });
}