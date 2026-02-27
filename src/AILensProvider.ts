// src/AILensProvider.ts
import * as vscode from 'vscode';

export class AILensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public pendingEdits: { uri: vscode.Uri, range: vscode.Range, taskId: string }[] = [];

    constructor() {
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.refresh();
        });
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public addPendingEdit(uri: vscode.Uri, range: vscode.Range, taskId: string) {
        // Remove duplicates
        this.pendingEdits = this.pendingEdits.filter(e => e.taskId !== taskId);
        this.pendingEdits.push({ uri, range, taskId });
        
        console.log(`[Lens] Added edit for: ${uri.toString()}`);
        this.refresh();
    }

    public clearEdit(taskId: string) {
        this.pendingEdits = this.pendingEdits.filter(edit => edit.taskId !== taskId);
        this.refresh();
    }

    public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        // Log that VS Code is actually asking for lenses
        // console.log(`[Lens] Providing for: ${document.uri.toString()}`);
        console.log(`\n--- [Lens Debug] provideCodeLenses called ---`);
        console.log(`Requested File: ${document.uri.fsPath}`);
        console.log(`Total pending edits in memory: ${this.pendingEdits.length}`);

        const lenses: vscode.CodeLens[] = [];
        const docUriString = document.uri.toString().toLowerCase();

        // FUZZY MATCHING: Check if the path ends with the same filename
        // This bypasses 'c:' vs 'C:' and 'file://' vs 'vscode-remote://' issues
        const fileEdits = this.pendingEdits.filter(edit => {
            const editStr = edit.uri.toString().toLowerCase();
            console.log(`  -> Comparing memory edit: ${edit.uri.fsPath}`);

            // 1. Exact Match
            if (editStr === docUriString){
                console.log(`✅ MATCH FOUND (URI exact match)`);
                return true;
            }

            if (edit.uri.fsPath.toLowerCase() === document.uri.fsPath.toLowerCase()) {
                console.log(`✅ MATCH FOUND (fsPath match)`);
                return true;
            }
            
            // 2. Fuzzy Path Match (Robust fallback)
            console.log(`❌ NO MATCH`);
            return false;
        });

        console.log(`Valid edits for this specific file: ${fileEdits.length}\n-----------------------------------\n`);

        for (const edit of fileEdits) {
            // 🔥 THE FIX: Mathematically guarantee the CodeLens range is within the document bounds
            const startLine = edit.range.start.line;
            const safeLine = Math.min(startLine, document.lineCount > 0 ? document.lineCount - 1 : 0);
            const safeRange = new vscode.Range(safeLine, 0, safeLine, 0);

            // Create the buttons
            const acceptCmd = {
                title: "$(check) Accept",
                command: "nexuscode.acceptEdit",
                arguments: [edit.taskId, document.uri]
            };
            
            const rejectCmd = {
                title: "$(x) Reject",
                command: "nexuscode.rejectEdit",
                arguments: [edit.taskId, document.uri]
            };

            const diffCmd = {
                title: "$(diff) View Diff",
                command: "nexuscode.viewDiff",
                arguments: [edit.taskId, document.uri]
            };

            lenses.push(new vscode.CodeLens(safeRange, acceptCmd));
            lenses.push(new vscode.CodeLens(safeRange, rejectCmd));
            lenses.push(new vscode.CodeLens(safeRange, diffCmd));
        }

        return lenses;
    }
}