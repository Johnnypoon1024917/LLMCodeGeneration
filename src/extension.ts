import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { ProvenanceTracker } from './provenanceTracker';
import { AILensProvider } from './AILensProvider';
import { TerminalManager } from './terminalManager';

export let globalContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
    globalContext = context;

    // 1. Initialize core services
    const terminalManager = new TerminalManager();
    const lensProvider = new AILensProvider();
    const provenanceTracker = new ProvenanceTracker(lensProvider);
    const sidebarProvider = new SidebarProvider(context.extensionUri);

    // 2. Wire them together
    sidebarProvider.setProvenanceTracker(provenanceTracker);
    sidebarProvider.setTerminalManager(terminalManager);

    const selector: vscode.DocumentSelector = [{ language: '*', scheme: '*' }];

    // 🔥 ENTERPRISE UPGRADE: Group all registrations into a single, clean push block
    context.subscriptions.push(
        
        // --- PROVIDERS ---
        vscode.languages.registerCodeLensProvider(selector, lensProvider),
        vscode.window.registerWebviewViewProvider("qwen-sidebar", sidebarProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),

        // --- EVENT LISTENERS ---
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                lensProvider.refresh();
                provenanceTracker.restoreDecorations(editor);
            }
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            const tasksToClear = lensProvider.pendingEdits
                .filter(e => e.uri.toString() === doc.uri.toString())
                .map(e => e.taskId);
            tasksToClear.forEach(id => lensProvider.clearEdit(id));
        }),

        // --- INLINE CODELENS COMMANDS ---
        vscode.commands.registerCommand('nexuscode.acceptEdit', async (taskId, uri) => {
            provenanceTracker.handleAccept(taskId, uri);
            await sidebarProvider.handlePostApproval(uri);
        }),
        vscode.commands.registerCommand('nexuscode.rejectEdit', async (taskId, uri) => {
            await provenanceTracker.handleReject(taskId, uri);
        }),
        vscode.commands.registerCommand('nexuscode.refreshLens', () => {
            lensProvider.refresh();
            vscode.window.showInformationMessage("NexusCode: CodeLens manually refreshed!");
        }),
        vscode.commands.registerCommand('nexuscode.viewDiff', async (taskId, uri) => {
            const snapshots = provenanceTracker.getPendingCode(taskId);
            if (snapshots) {
                await provenanceTracker.showDiff(snapshots.original, snapshots.proposed, taskId);
            }
        }),

        // --- HIGHLIGHT / REVIEW COMMANDS ---
        vscode.commands.registerCommand('nexuscode.reviewCode', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selectedText = editor.document.getText(editor.selection);
            if (!selectedText) {
                vscode.window.showWarningMessage("Please highlight some code to review.");
                return;
            }
            sidebarProvider._view?.webview.postMessage({ type: 'requestReview', code: selectedText });
            await vscode.commands.executeCommand('qwen-sidebar.focus');
        }),
        vscode.commands.registerCommand('nexuscode.optimizeSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selection = editor.document.getText(editor.selection);
            sidebarProvider._view?.webview.postMessage({ type: 'requestReview', code: selection });
            await vscode.commands.executeCommand('qwen-sidebar.focus');
        }),

        // --- RIGHT-CLICK CONTEXT MENU COMMANDS ---
        vscode.commands.registerCommand('nexuscode.addSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const selection = editor.document.getText(editor.selection);
                const filename = vscode.workspace.asRelativePath(editor.document.uri);
                
                // 🔥 ENTERPRISE UPGRADE: Send structured context instead of raw text
                sidebarProvider.sendMessageToWebview({ 
                    type: 'addContext', 
                    file: filename, 
                    code: selection, 
                    language: editor.document.languageId 
                });
                vscode.commands.executeCommand('qwen-sidebar.focus');
            }
        }),
        vscode.commands.registerCommand('nexuscode.explainSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const selection = editor.document.getText(editor.selection);
                const filename = vscode.workspace.asRelativePath(editor.document.uri);
                
                // 🔥 Attach the context silently, then trigger an explain prompt
                const contextStr = `\n\`\`\`${editor.document.languageId} title="${filename}"\n${selection}\n\`\`\`\n`;
                sidebarProvider.sendMessageToWebview({ 
                    type: 'addUserMessageAndSubmit', 
                    text: `Please explain this selected code from \`${filename}\`.`,
                    context: contextStr
                });
                vscode.commands.executeCommand('qwen-sidebar.focus');
            }
        }),
        vscode.commands.registerCommand('nexuscode.modifySelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                const selection = editor.document.getText(editor.selection);
                const filename = vscode.workspace.asRelativePath(editor.document.uri);
                
                // 🔥 Attach the context silently, then pre-fill a modification request
                sidebarProvider.sendMessageToWebview({ type: 'addContext', file: filename, code: selection, language: editor.document.languageId });
                sidebarProvider.sendMessageToWebview({ type: 'insertText', text: `I want to modify the selected code. Please change it to: ` });
                vscode.commands.executeCommand('qwen-sidebar.focus');
            }
        })
    );
}