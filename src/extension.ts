import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { ProvenanceTracker } from './provenanceTracker';
import { AILensProvider } from './AILensProvider';
import { TerminalManager } from './terminalManager';
import { invalidateProjectContext } from './projectContext';
import { originalContentProvider } from './diffProvider';
import { activateTerminalInterceptor } from './terminalInterceptor';
import { ASTParser } from './utilities/astParser';

export let globalContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
    console.log('LLMCodeGeneration is now active!');
    // Initialize the AST Parser on startup
    await ASTParser.init(context);
    
    globalContext = context;

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
        watcher.onDidCreate(() => invalidateProjectContext()),
        watcher.onDidDelete(() => invalidateProjectContext()),
        // Note: We don't track onDidChange because changing a file's contents doesn't change the Directory Tree structure.
        watcher
    );

    // 1. Initialize core services
    const terminalManager = new TerminalManager();
    const lensProvider = new AILensProvider();
    const provenanceTracker = new ProvenanceTracker(lensProvider);
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    
    //  Boot the Terminal Auto-Debugger
    activateTerminalInterceptor(sidebarProvider, context);

    // 2. Wire them together
    sidebarProvider.setProvenanceTracker(provenanceTracker);
    sidebarProvider.setTerminalManager(terminalManager);

    const selector: vscode.DocumentSelector = [{ language: '*', scheme: '*' }];

    //  ENTERPRISE UPGRADE: Group all registrations into a single, clean push block
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('nexus-original', originalContentProvider),
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
        vscode.commands.registerCommand('nexuscode.inlineEdit', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const selection = editor.document.getText(editor.selection);
            const filename = vscode.workspace.asRelativePath(editor.document.uri);
            
            const userInput = await vscode.window.showInputBox({
                prompt: "NexusCode: What do you want to generate or modify?",
                placeHolder: "e.g., Extract this logic into a separate React component..."
            });

            if (!userInput) return;

            const contextStr = selection ? `\n\`\`\`${editor.document.languageId} title="${filename}"\n${selection}\n\`\`\`\n` : "";

            sidebarProvider.sendMessageToWebview({ 
                type: 'addUserMessageAndSubmit', 
                text: userInput,
                context: contextStr
            });
            
            vscode.commands.executeCommand('qwen-sidebar.focus');
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
                
                //  ENTERPRISE UPGRADE: Send structured context instead of raw text
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
                
                //  Attach the context silently, then trigger an explain prompt
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
                
                //  Attach the context silently, then pre-fill a modification request
                sidebarProvider.sendMessageToWebview({ type: 'addContext', file: filename, code: selection, language: editor.document.languageId });
                sidebarProvider.sendMessageToWebview({ type: 'insertText', text: `I want to modify the selected code. Please change it to: ` });
                vscode.commands.executeCommand('qwen-sidebar.focus');
            }
        })
    );
}