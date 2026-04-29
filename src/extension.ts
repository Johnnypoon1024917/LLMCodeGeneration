import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';
import { ProvenanceTracker } from './provenanceTracker';
import { AILensProvider } from './AILensProvider';
import { TerminalManager } from './terminalManager';
import { invalidateProjectContext } from './projectContext';
import { originalContentProvider } from './diffProvider';
import { activateTerminalInterceptor } from './terminalInterceptor';
import { ASTParser } from './utilities/astParser';
import { HookManager } from './hooks/HookManager';
import { log } from './logger';
import { setDeps } from './container';
import { VSCodeConfigSource } from './adapters/VSCodeConfigSource';
import { initI18n, t } from './i18n';
import { AuditLog } from './audit/AuditLog';

export async function activate(context: vscode.ExtensionContext) {
    log.info('LLMCodeGeneration is now active!');
    // Initialize the AST Parser on startup
    await ASTParser.init(context);

    // Initialize i18n. Default to English; future versions may read this
    // from `nexuscode.locale` config and switch on activation.
    await initI18n('en');

    // Initialize the audit logger for the active workspace, or a fallback
    // location (extension dir) if no workspace is open. Audit init reads
    // existing chain hash; failures here log a warning and start fresh.
    const auditRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? context.extensionUri.fsPath;
    const audit = new AuditLog(auditRoot);
    await audit.init();

    // Install runtime deps for the typed container. This must run BEFORE
    // any consumer code that calls getDeps() — at the start of activate().
    setDeps({
        state: context.workspaceState,
        secrets: context.secrets,
        extensionUri: context.extensionUri,
        subscriptions: context.subscriptions,
        config: new VSCodeConfigSource('nexuscode'),
        audit
    });

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
        vscode.window.registerWebviewViewProvider("nexuscode.sidebar", sidebarProvider, {
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

        vscode.commands.registerCommand('nexuscode.setApiKey', async () => {
            const current = await context.secrets.get('nexuscode_apikey');
            const placeholder = current
                ? `Currently set (${current.length} chars). Type a new value to replace, or leave empty to clear.`
                : "sk-... or leave empty for local LLMs (LM Studio / Ollama)";

            const key = await vscode.window.showInputBox({
                prompt: "NexusCode: API Key",
                password: true,
                ignoreFocusOut: true,
                placeHolder: placeholder
            });

            // showInputBox returns undefined when the user presses Esc
            if (key === undefined) return;

            if (key === '') {
                await context.secrets.delete('nexuscode_apikey');
                vscode.window.showInformationMessage(t("api_key.cleared"));
            } else {
                await context.secrets.store('nexuscode_apikey', key);
                vscode.window.showInformationMessage(t("api_key.saved_to_secret_storage"));
            }
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
            
            vscode.commands.executeCommand('nexuscode.sidebar.focus');
        }),
        vscode.commands.registerCommand('nexuscode.refreshLens', () => {
            lensProvider.refresh();
            vscode.window.showInformationMessage(t("codelens.manually_refreshed"));
        }),
        vscode.commands.registerCommand('nexuscode.viewDiff', async (taskId, _uri) => {
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
                vscode.window.showWarningMessage(t("commands.highlight_code_to_review"));
                return;
            }
            sidebarProvider._view?.webview.postMessage({ type: 'requestReview', code: selectedText });
            await vscode.commands.executeCommand('nexuscode.sidebar.focus');
        }),
        vscode.commands.registerCommand('nexuscode.optimizeSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const selection = editor.document.getText(editor.selection);
            sidebarProvider._view?.webview.postMessage({ type: 'requestReview', code: selection });
            await vscode.commands.executeCommand('nexuscode.sidebar.focus');
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
                vscode.commands.executeCommand('nexuscode.sidebar.focus');
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
                vscode.commands.executeCommand('nexuscode.sidebar.focus');
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
                vscode.commands.executeCommand('nexuscode.sidebar.focus');
            }
        })
    );

    // Start the HookManager once workspace is available.
    // We don't fail activation if no workspace is open — hooks just won't run.
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        HookManager.getInstance().start(context, folders[0]!.uri).catch(e => {
            log.error('HookManager failed to start:', e);
        });
    }
}

export function deactivate(): void {
    HookManager.getInstance().stop();
}