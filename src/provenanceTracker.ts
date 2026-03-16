// src/provenanceTracker.ts
import * as vscode from 'vscode';
import { AILensProvider } from './AILensProvider';

export class ProvenanceTracker {
    private reviewDecorationType: vscode.TextEditorDecorationType;
    private _view?: vscode.WebviewView;

    // 🔥 FIX: Declare the Map to store original and proposed code snapshots
    public pendingSnapshots = new Map<string, { original: string, proposed: string }>();

    constructor(private lensProvider: AILensProvider) {
        // Defines the purple highlight block for AI edits
        this.reviewDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(139, 92, 246, 0.15)',
            isWholeLine: true,
            border: '1px solid rgba(139, 92, 246, 0.3)',
            borderRadius: '4px'
        });
    }

    public setView(view: vscode.WebviewView) {
        this._view = view;
    }

    public trackStreamedReview(editor: vscode.TextEditor, originalContent: string, taskId: string, startLine: number, endLine: number): string {
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

    public handleAccept(taskId: string, uri: vscode.Uri) {
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

    public async handleReject(taskId: string, uri: vscode.Uri) {
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

    public restoreDecorations(editor: vscode.TextEditor) {
        // If the user switches tabs, re-apply the purple highlight to any pending edits
        const editsInDoc = this.lensProvider.pendingEdits.filter(e => e.uri.toString() === editor.document.uri.toString());
        if (editsInDoc.length > 0) {
            const ranges = editsInDoc.map(e => new vscode.Range(e.range.start.line, 0, editor.document.lineCount, 0));
            editor.setDecorations(this.reviewDecorationType, ranges);
        }
    }

    public getPendingCode(taskId: string) {
        return this.pendingSnapshots.get(taskId);
    }

    public async showDiff(original: string, proposed: string, taskId: string) {
        // Open two virtual text documents and trigger VS Code's native diff viewer
        const originalDoc = await vscode.workspace.openTextDocument({ content: original });
        const proposedDoc = await vscode.workspace.openTextDocument({ content: proposed });
        
        await vscode.commands.executeCommand(
            'vscode.diff', 
            originalDoc.uri, 
            proposedDoc.uri, 
            `Diff: Task ${taskId}`
        );
    }
}