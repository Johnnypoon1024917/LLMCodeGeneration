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
exports.globalContext = void 0;
exports.activate = activate;
// src/extension.ts
const vscode = __importStar(require("vscode"));
const SidebarProvider_1 = require("./SidebarProvider");
const DiffProvider_1 = require("./providers/DiffProvider"); // Sprint 2 Component
const AICodeLensProvider_1 = require("./providers/AICodeLensProvider"); // Sprint 2 Component
async function activate(context) {
    exports.globalContext = context;
    // 1. Initialize our new Sprint 2 Providers
    const originalContentProvider = new DiffProvider_1.OriginalContentProvider();
    const aiCodeLensProvider = new AICodeLensProvider_1.AICodeLensProvider();
    // 2. Register the "Virtual Document" for Native Diffing (nexus-original://)
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('nexus-original', originalContentProvider));
    // 3. Register the Inline CodeLens Provider
    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, aiCodeLensProvider));
    // 4. Initialize the updated Sidebar Router
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri);
    // Inject the providers so the Sidebar can command them
    sidebarProvider.setDiffProvider(originalContentProvider);
    sidebarProvider.setCodeLensProvider(aiCodeLensProvider);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("nexuscode-sidebar", sidebarProvider));
    // --- 5. THE SYNCHRONIZATION GATE (Patent Focus) ---
    // These commands are triggered when the developer clicks the inline CodeLens
    context.subscriptions.push(vscode.commands.registerCommand('nexus.acceptEdit', async (uri) => {
        // Remove the inline buttons
        aiCodeLensProvider.clearReview(uri);
        // Save the accepted file
        const document = await vscode.workspace.openTextDocument(uri);
        await document.save();
        // Ping the React Sidebar to mark the task as "Approved" automatically
        sidebarProvider.emit('allTasksCompleted', { status: 'approved' });
        vscode.window.showInformationMessage("✅ AI Edit Accepted.");
    }));
    context.subscriptions.push(vscode.commands.registerCommand('nexus.rejectEdit', async (uri, taskKey) => {
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
//# sourceMappingURL=extension.js.map