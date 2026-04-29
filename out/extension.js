"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const provenanceTracker_1 = require("./provenanceTracker");
const AILensProvider_1 = require("./AILensProvider");
const terminalManager_1 = require("./terminalManager");
const projectContext_1 = require("./projectContext");
const diffProvider_1 = require("./diffProvider");
const terminalInterceptor_1 = require("./terminalInterceptor");
const astParser_1 = require("./utilities/astParser");
const HookManager_1 = require("./hooks/HookManager");
const logger_1 = require("./logger");
const container_1 = require("./container");
const VSCodeConfigSource_1 = require("./adapters/VSCodeConfigSource");
const i18n_1 = require("./i18n");
const AuditLog_1 = require("./audit/AuditLog");
async function activate(context) {
    logger_1.log.info('LLMCodeGeneration is now active!');
    // Initialize the AST Parser on startup
    await astParser_1.ASTParser.init(context);
    // Initialize i18n. Default to English; future versions may read this
    // from `nexuscode.locale` config and switch on activation.
    await (0, i18n_1.initI18n)('en');
    // Initialize the audit logger for the active workspace, or a fallback
    // location (extension dir) if no workspace is open. Audit init reads
    // existing chain hash; failures here log a warning and start fresh.
    const auditRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? context.extensionUri.fsPath;
    const audit = new AuditLog_1.AuditLog(auditRoot);
    await audit.init();
    // Install runtime deps for the typed container. This must run BEFORE
    // any consumer code that calls getDeps() — at the start of activate().
    (0, container_1.setDeps)({
        state: context.workspaceState,
        secrets: context.secrets,
        extensionUri: context.extensionUri,
        subscriptions: context.subscriptions,
        config: new VSCodeConfigSource_1.VSCodeConfigSource('nexuscode'),
        audit
    });
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(watcher.onDidCreate(() => (0, projectContext_1.invalidateProjectContext)()), watcher.onDidDelete(() => (0, projectContext_1.invalidateProjectContext)()), 
    // Note: We don't track onDidChange because changing a file's contents doesn't change the Directory Tree structure.
    watcher);
    // 1. Initialize core services
    const terminalManager = new terminalManager_1.TerminalManager();
    const lensProvider = new AILensProvider_1.AILensProvider();
    const provenanceTracker = new provenanceTracker_1.ProvenanceTracker(lensProvider);
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri);
    //  Boot the Terminal Auto-Debugger
    (0, terminalInterceptor_1.activateTerminalInterceptor)(sidebarProvider, context);
    // 2. Wire them together
    sidebarProvider.setProvenanceTracker(provenanceTracker);
    sidebarProvider.setTerminalManager(terminalManager);
    const selector = [{ language: '*', scheme: '*' }];
    //  ENTERPRISE UPGRADE: Group all registrations into a single, clean push block
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('nexus-original', diffProvider_1.originalContentProvider), 
    // --- PROVIDERS ---
    vscode.languages.registerCodeLensProvider(selector, lensProvider), vscode.window.registerWebviewViewProvider("nexuscode.sidebar", sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true }
    }), 
    // --- EVENT LISTENERS ---
    vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            lensProvider.refresh();
            provenanceTracker.restoreDecorations(editor);
        }
    }), vscode.workspace.onDidCloseTextDocument((doc) => {
        const tasksToClear = lensProvider.pendingEdits
            .filter(e => e.uri.toString() === doc.uri.toString())
            .map(e => e.taskId);
        tasksToClear.forEach(id => lensProvider.clearEdit(id));
    }), vscode.commands.registerCommand('nexuscode.setApiKey', async () => {
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
        if (key === undefined)
            return;
        if (key === '') {
            await context.secrets.delete('nexuscode_apikey');
            vscode.window.showInformationMessage((0, i18n_1.t)("api_key.cleared"));
        }
        else {
            await context.secrets.store('nexuscode_apikey', key);
            vscode.window.showInformationMessage((0, i18n_1.t)("api_key.saved_to_secret_storage"));
        }
    }), 
    // --- INLINE CODELENS COMMANDS ---
    vscode.commands.registerCommand('nexuscode.acceptEdit', async (taskId, uri) => {
        provenanceTracker.handleAccept(taskId, uri);
        await sidebarProvider.handlePostApproval(uri);
    }), vscode.commands.registerCommand('nexuscode.rejectEdit', async (taskId, uri) => {
        await provenanceTracker.handleReject(taskId, uri);
    }), vscode.commands.registerCommand('nexuscode.inlineEdit', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const selection = editor.document.getText(editor.selection);
        const filename = vscode.workspace.asRelativePath(editor.document.uri);
        const userInput = await vscode.window.showInputBox({
            prompt: "NexusCode: What do you want to generate or modify?",
            placeHolder: "e.g., Extract this logic into a separate React component..."
        });
        if (!userInput)
            return;
        const contextStr = selection ? `\n\`\`\`${editor.document.languageId} title="${filename}"\n${selection}\n\`\`\`\n` : "";
        sidebarProvider.sendMessageToWebview({
            type: 'addUserMessageAndSubmit',
            text: userInput,
            context: contextStr
        });
        vscode.commands.executeCommand('nexuscode.sidebar.focus');
    }), vscode.commands.registerCommand('nexuscode.refreshLens', () => {
        lensProvider.refresh();
        vscode.window.showInformationMessage((0, i18n_1.t)("codelens.manually_refreshed"));
    }), vscode.commands.registerCommand('nexuscode.viewDiff', async (taskId, _uri) => {
        const snapshots = provenanceTracker.getPendingCode(taskId);
        if (snapshots) {
            await provenanceTracker.showDiff(snapshots.original, snapshots.proposed, taskId);
        }
    }), 
    // --- HIGHLIGHT / REVIEW COMMANDS ---
    vscode.commands.registerCommand('nexuscode.reviewCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText) {
            vscode.window.showWarningMessage((0, i18n_1.t)("commands.highlight_code_to_review"));
            return;
        }
        sidebarProvider._view?.webview.postMessage({ type: 'requestReview', code: selectedText });
        await vscode.commands.executeCommand('nexuscode.sidebar.focus');
    }), vscode.commands.registerCommand('nexuscode.optimizeSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
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
    }), vscode.commands.registerCommand('nexuscode.explainSelection', () => {
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
    }), vscode.commands.registerCommand('nexuscode.modifySelection', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && !editor.selection.isEmpty) {
            const selection = editor.document.getText(editor.selection);
            const filename = vscode.workspace.asRelativePath(editor.document.uri);
            //  Attach the context silently, then pre-fill a modification request
            sidebarProvider.sendMessageToWebview({ type: 'addContext', file: filename, code: selection, language: editor.document.languageId });
            sidebarProvider.sendMessageToWebview({ type: 'insertText', text: `I want to modify the selected code. Please change it to: ` });
            vscode.commands.executeCommand('nexuscode.sidebar.focus');
        }
    }));
    // Start the HookManager once workspace is available.
    // We don't fail activation if no workspace is open — hooks just won't run.
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        HookManager_1.HookManager.getInstance().start(context, folders[0].uri).catch(e => {
            logger_1.log.error('HookManager failed to start:', e);
        });
    }
}
function deactivate() {
    HookManager_1.HookManager.getInstance().stop();
}
//# sourceMappingURL=extension.js.map