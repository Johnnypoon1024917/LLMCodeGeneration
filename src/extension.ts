import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { ProvenanceTracker } from './provenanceTracker';

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    const provenanceTracker = new ProvenanceTracker();

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

    // Listen to all document edits to track Human vs LLM changes
    vscode.workspace.onDidChangeTextDocument(event => {
        provenanceTracker.handleDocumentChange(event);
    });

    // We pass the tracker to the sidebar so it can flag LLM edits when applying code
    sidebarProvider.setProvenanceTracker(provenanceTracker);
}