// src/provenanceTracker.ts
import * as vscode from 'vscode';
import { AILensProvider } from './AILensProvider';

export class ProvenanceTracker {
    private _view?: vscode.WebviewView;

    // FIX 1: Store BOTH states for a perfect diff
    private pendingCodeMap: Map<string, { original: string, proposed: string }> = new Map();
    private taskIdToNameMap: Map<string, string> = new Map();
    constructor(private lensProvider: AILensProvider) { }
    public setView(view: vscode.WebviewView) { this._view = view; }

    public trackStreamedReview(
        editor: vscode.TextEditor,
        originalContent: string,
        taskName: string,
        startLine: number,
        endLine: number
    ): string {
        const document = editor.document;
        const proposedContent = document.getText(); 

        // 1. Create a full, valid range that covers the actual code block
        const reviewRange = new vscode.Range(startLine, 0, endLine, 0);
        
        // Draw the purple background
        editor.setDecorations(this.pendingDecoration, [reviewRange]);

        const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        
        this.pendingCodeMap.set(taskId, { original: originalContent, proposed: proposedContent });
        this.taskIdToNameMap.set(taskId, taskName);

        // 2. 🔥 THE FIX: Pass the FULL reviewRange to the LensProvider, not a 0-length anchor!
        this.lensProvider.addPendingEdit(document.uri, reviewRange, taskId);
        
        // 3. Give VS Code a fraction of a second to finish rendering the text stream
        setTimeout(() => {
            this.lensProvider.refresh();
        }, 250);

        return "reviewing";
    }
    
    private pendingDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(139, 92, 246, 0.2)',
        isWholeLine: true,
        border: '1px dashed rgba(139, 92, 246, 0.8)'
    });

    public getPendingCode(taskId: string): { original: string, proposed: string } | undefined {
        return this.pendingCodeMap.get(taskId);
    }

    public async applySectionalApproval(
        editor: vscode.TextEditor,
        newSnippet: string,
        taskName: string,
        action: 'replace' | 'append'
    ): Promise<string> {
        const document = editor.document;
        const originalContent = document.getText();

        // FIX 1: Track the exact line where the new content starts
        let startLine = 0;
        const lineCountBefore = document.lineCount;

        await editor.edit(editBuilder => {
            if (action === 'replace') {
                startLine = 0;
                const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
                editBuilder.replace(fullRange, newSnippet);
            } else {
                // For append, we start AFTER the last line of the existing content
                startLine = lineCountBefore;
                // Ensure there is a newline before the snippet
                const insertionPoint = new vscode.Position(startLine, 0);
                editBuilder.insert(insertionPoint, (startLine > 0 ? "\n" : "") + newSnippet);
            }
        }, { undoStopBefore: true, undoStopAfter: true });

        // FIX 2: Calculate the exact end line based on the snippet's actual line count
        const snippetLineCount = newSnippet.split('\n').length;
        const endLine = startLine + snippetLineCount;

        // FIX 3: Create a precise range for the decoration
        // We subtract 1 from startLine for append to account for the \n we added
        const highlightStart = action === 'append' && startLine > 0 ? startLine : startLine;
        const reviewRange = new vscode.Range(highlightStart, 0, endLine, 0);

        // Apply visual highlight only to the NEW code
        editor.setDecorations(this.pendingDecoration, [reviewRange]);

        editor.revealRange(reviewRange, vscode.TextEditorRevealType.InCenter);

        const taskId = `task-${Date.now()}`;
        this.pendingCodeMap.set(taskId, { original: originalContent, proposed: editor.document.getText() });
        this.taskIdToNameMap.set(taskId, taskName);

        // Position the AI Lens (Approve/Reject buttons) exactly at the start of the change
        this.lensProvider.addPendingEdit(document.uri, reviewRange, taskId);
        this.lensProvider.refresh();

        return "reviewing";
    }

    public handleAccept(taskId: string, uri: vscode.Uri) {
        this.lensProvider.clearEdit(taskId);
        vscode.window.activeTextEditor?.setDecorations(this.pendingDecoration, []);
        const originalTaskName = this.taskIdToNameMap.get(taskId) || taskId;

        this._view?.webview.postMessage({ type: 'taskCompleted', task: originalTaskName, status: 'approved' });

        this.pendingCodeMap.delete(taskId);
        this.taskIdToNameMap.delete(taskId);
    }

    public async handleReject(taskId: string, uri: vscode.Uri) {
        this.lensProvider.clearEdit(taskId);
        vscode.window.activeTextEditor?.setDecorations(this.pendingDecoration, []); // Clear highlight
        await vscode.commands.executeCommand('undo'); // Revert changes natively

        const originalTaskName = this.taskIdToNameMap.get(taskId) || taskId;
        this._view?.webview.postMessage({ type: 'taskCompleted', task: originalTaskName, status: 'rejected' });

        this.pendingCodeMap.delete(taskId);
        this.taskIdToNameMap.delete(taskId);
    }

    // FIX 3: Open two virtual documents to force a perfect Git-style Diff
    public async showDiff(originalContent: string, proposedContent: string, taskName: string) {
        const safeTaskName = taskName.replace(/[^a-z0-9]/gi, '_').substring(0, 30);

        const originalUri = vscode.Uri.parse(`untitled:Original_${safeTaskName}.ts`);
        const proposedUri = vscode.Uri.parse(`untitled:Proposed_${safeTaskName}.ts`);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(originalUri, new vscode.Position(0, 0), originalContent);
        edit.insert(proposedUri, new vscode.Position(0, 0), proposedContent);
        await vscode.workspace.applyEdit(edit);

        await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, `Diff: ${taskName}`);
    }

    public restoreDecorations(editor: vscode.TextEditor) {
        const docUriString = editor.document.uri.toString().toLowerCase();

        // Find all pending edits that belong to the file we just switched to
        const activeEdits = this.lensProvider.pendingEdits.filter(edit => {
            return edit.uri.toString().toLowerCase() === docUriString ||
                edit.uri.fsPath.toLowerCase() === editor.document.uri.fsPath.toLowerCase();
        });

        // Re-apply the purple highlight to this new editor instance
        if (activeEdits.length > 0) {
            const allRanges = activeEdits.map(e => e.range);
            editor.setDecorations(this.pendingDecoration, allRanges);
        } else {
            editor.setDecorations(this.pendingDecoration, []);
        }
    }
}