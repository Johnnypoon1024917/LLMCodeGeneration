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
exports.ProvenanceTracker = void 0;
// src/provenanceTracker.ts
const vscode = __importStar(require("vscode"));
class ProvenanceTracker {
    lensProvider;
    reviewDecorationType;
    _view;
    // 🔥 FIX: Declare the Map to store original and proposed code snapshots
    pendingSnapshots = new Map();
    constructor(lensProvider) {
        this.lensProvider = lensProvider;
        // Defines the purple highlight block for AI edits
        this.reviewDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(139, 92, 246, 0.15)',
            isWholeLine: true,
            border: '1px solid rgba(139, 92, 246, 0.3)',
            borderRadius: '4px'
        });
    }
    setView(view) {
        this._view = view;
    }
    trackStreamedReview(editor, originalContent, taskId, startLine, endLine) {
        const uri = editor.document.uri;
        // 1. Store the code snapshot for the Diff Viewer & Reject button
        this.pendingSnapshots.set(taskId, {
            original: originalContent,
            proposed: editor.document.getText()
        });
        // 2. Apply the purple AI highlight decoration
        const range = new vscode.Range(startLine, 0, endLine, 0);
        editor.setDecorations(this.reviewDecorationType, [range]);
        // 3. Register the CodeLens exactly at the top of the AI edit
        this.lensProvider.addEdit({
            taskId: taskId,
            uri: uri,
            range: new vscode.Range(startLine, 0, startLine, 0)
        });
        // 4. 🔥 Force VS Code to redraw the buttons AFTER the text buffer syncs
        setTimeout(() => {
            this.lensProvider.refresh();
        }, 500);
        return "reviewing";
    }
    handleAccept(taskId, uri) {
        // Clear tracking data
        this.lensProvider.clearEdit(taskId);
        this.pendingSnapshots.delete(taskId);
        // Remove the purple highlight
        const activeEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        if (activeEditor) {
            activeEditor.setDecorations(this.reviewDecorationType, []);
        }
        // Notify Webview UI
        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: taskId, status: 'approved' });
    }
    async handleReject(taskId, uri) {
        // 1. Fetch the original snapshot
        const snapshot = this.pendingSnapshots.get(taskId);
        if (snapshot) {
            // 2. Revert the file to its original state mathematically
            const workspaceEdit = new vscode.WorkspaceEdit();
            const document = await vscode.workspace.openTextDocument(uri);
            workspaceEdit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), snapshot.original);
            await vscode.workspace.applyEdit(workspaceEdit);
            await document.save();
        }
        // 3. Clear tracking data and UI
        this.lensProvider.clearEdit(taskId);
        this.pendingSnapshots.delete(taskId);
        const activeEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        if (activeEditor) {
            activeEditor.setDecorations(this.reviewDecorationType, []);
        }
        this._view?.webview.postMessage({ type: 'taskStatusUpdate', task: taskId, status: 'rejected' });
    }
    restoreDecorations(editor) {
        // If the user switches tabs, re-apply the purple highlight to any pending edits
        const editsInDoc = this.lensProvider.pendingEdits.filter(e => e.uri.toString() === editor.document.uri.toString());
        if (editsInDoc.length > 0) {
            const ranges = editsInDoc.map(e => new vscode.Range(e.range.start.line, 0, editor.document.lineCount, 0));
            editor.setDecorations(this.reviewDecorationType, ranges);
        }
    }
    getPendingCode(taskId) {
        return this.pendingSnapshots.get(taskId);
    }
    async showDiff(original, proposed, taskId) {
        // Open two virtual text documents and trigger VS Code's native diff viewer
        const originalDoc = await vscode.workspace.openTextDocument({ content: original });
        const proposedDoc = await vscode.workspace.openTextDocument({ content: proposed });
        await vscode.commands.executeCommand('vscode.diff', originalDoc.uri, proposedDoc.uri, `Diff: Task ${taskId}`);
    }
}
exports.ProvenanceTracker = ProvenanceTracker;
//# sourceMappingURL=provenanceTracker.js.map