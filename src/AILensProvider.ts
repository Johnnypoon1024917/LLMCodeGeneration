// src/AILensProvider.ts
import * as vscode from 'vscode';

export interface PendingEdit {
    taskId: string;
    uri: vscode.Uri;
    range: vscode.Range;
}

export class AILensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public pendingEdits: PendingEdit[] = [];
    private _refreshTimeout: NodeJS.Timeout | undefined;

    constructor() {
        //  FIX 1: Listen for text changes to fix shifted or disappearing lenses
        vscode.workspace.onDidChangeTextDocument((e) => {
            const hasEditsInDoc = this.pendingEdits.some(edit => edit.uri.toString() === e.document.uri.toString());
            if (hasEditsInDoc) {
                // Debounce the refresh to prevent UI flickering during rapid typing
                if (this._refreshTimeout) clearTimeout(this._refreshTimeout);
                this._refreshTimeout = setTimeout(() => {
                    this.refresh();
                }, 300);
            }
        });
    }

    public refresh() {
        this._onDidChangeCodeLenses.fire();
    }

    public addEdit(edit: PendingEdit) {
        // Remove existing edit for this task to prevent duplicate buttons
        this.pendingEdits = this.pendingEdits.filter(e => e.taskId !== edit.taskId);
        this.pendingEdits.push(edit);
        this.refresh();
    }

    public clearEdit(taskId: string) {
        this.pendingEdits = this.pendingEdits.filter(e => e.taskId !== taskId);
        this.refresh();
    }

    public provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        const docEdits = this.pendingEdits.filter(e => e.uri.toString() === document.uri.toString());

        for (const edit of docEdits) {
            // Check if the tracked range is still mathematically valid in the document
            if (edit.range.start.line < document.lineCount) {
                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "✅ Accept Changes",
                    tooltip: "Approve and finalize these AI edits",
                    command: "nexuscode.acceptEdit",
                    arguments: [edit.taskId, document.uri]
                }));

                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "❌ Reject",
                    tooltip: "Revert this file to its original state",
                    command: "nexuscode.rejectEdit",
                    arguments: [edit.taskId, document.uri]
                }));

                lenses.push(new vscode.CodeLens(edit.range, {
                    title: "🔍 View Diff",
                    tooltip: "See exactly what the AI changed",
                    command: "nexuscode.viewDiff",
                    arguments: [edit.taskId, document.uri]
                }));
            }
        }
        return lenses;
    }
}