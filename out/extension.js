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
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const provenanceTracker_1 = require("./provenanceTracker");
const AILensProvider_1 = require("./AILensProvider"); // Import new provider
const terminalManager_1 = require("./terminalManager");
function activate(context) {
    const terminalManager = new terminalManager_1.TerminalManager();
    const lensProvider = new AILensProvider_1.AILensProvider();
    // Register the floating toolbar provider
    const selector = [
        { language: '*', scheme: '*' }
    ];
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, lensProvider));
    const provenanceTracker = new provenanceTracker_1.ProvenanceTracker(lensProvider);
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri);
    // We pass the tracker to the sidebar so it can flag LLM edits when applying code
    sidebarProvider.setProvenanceTracker(provenanceTracker);
    sidebarProvider.setTerminalManager(terminalManager);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
            // 1. Force the CodeLens provider to wake up and redraw the buttons
            lensProvider.refresh();
            // 2. Re-apply the purple highlight to the new editor instance
            provenanceTracker.restoreDecorations(editor);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        // Optional: clear edits for this specific URI to keep the memory clean
        const tasksToClear = lensProvider.pendingEdits
            .filter(e => e.uri.toString() === doc.uri.toString())
            .map(e => e.taskId);
        tasksToClear.forEach(id => lensProvider.clearEdit(id));
    }));
    // Register the Webview UI
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("qwen-sidebar", sidebarProvider, {
        webviewOptions: {
            retainContextWhenHidden: true // <--- THIS IS THE MAGIC LINE
        }
    }));
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
    context.subscriptions.push(vscode.commands.registerCommand('nexuscode.reviewCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
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
    }));
    vscode.commands.registerCommand('nexuscode.optimizeSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
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
//# sourceMappingURL=extension.js.map