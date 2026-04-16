// src/extension.ts
import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { OriginalContentProvider } from './providers/DiffProvider'; // Sprint 2 Component
import { AICodeLensProvider } from './providers/AICodeLensProvider'; // Sprint 2 Component

export let globalContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
    globalContext = context;

    // 1. Initialize our new Sprint 2 Providers
    const originalContentProvider = new OriginalContentProvider();
    const aiCodeLensProvider = new AICodeLensProvider();

    // 2. Register the "Virtual Document" for Native Diffing (nexus-original://)
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('nexus-original', originalContentProvider)
    );

    // 3. Register the Inline CodeLens Provider
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, aiCodeLensProvider)
    );

    // 4. Initialize the updated Sidebar Router
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    // Inject the providers so the Sidebar can command them
    sidebarProvider.setDiffProvider(originalContentProvider);
    sidebarProvider.setCodeLensProvider(aiCodeLensProvider);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("nexuscode-sidebar", sidebarProvider)
    );

    // --- 5. THE SYNCHRONIZATION GATE (Patent Focus) ---
    // These commands are triggered when the developer clicks the inline CodeLens
    
    context.subscriptions.push(vscode.commands.registerCommand('nexus.acceptEdit', async (uri: vscode.Uri) => {
        // Remove the inline buttons
        aiCodeLensProvider.clearReview(uri);
        
        // Save the accepted file
        const document = await vscode.workspace.openTextDocument(uri);
        await document.save();

        // Ping the React Sidebar to mark the task as "Approved" automatically
        sidebarProvider.emit('allTasksCompleted', { status: 'approved' });
        vscode.window.showInformationMessage("✅ AI Edit Accepted.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('nexus.rejectEdit', async (uri: vscode.Uri, taskKey: string) => {
        // 1. Remove the inline buttons
        aiCodeLensProvider.clearReview(uri);

        // 2. Revert the file using the original cached content
        const originalContent = originalContentProvider.provideTextDocumentContent(uri.with({ scheme: 'nexus-original' }));
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), originalContent);
        await vscode.workspace.applyEdit(edit);
        await document.save();

        // 3. Ping the React Sidebar to mark it as rejected, allowing the user to provide feedback
        sidebarProvider.emit('taskCompleted', { task: taskKey, status: 'rejected', summary: '❌ Human Rejected Edit.' });
        vscode.window.showWarningMessage("❌ AI Edit Rejected and Reverted.");
    }));
}