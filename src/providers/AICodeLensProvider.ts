// src/providers/AICodeLensProvider.ts
import * as vscode from 'vscode';

export class AICodeLensProvider implements vscode.CodeLensProvider {
    // Map URI to both the Range and the specific Task ID
    private pendingReviews = new Map<string, { range: vscode.Range, taskKey: string }>();
    
    private onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

    // Updated Signature: Now accepts the taskKey
    public addPendingReview(uri: vscode.Uri, range: vscode.Range, taskKey: string) {
        this.pendingReviews.set(uri.toString(), { range, taskKey });
        this.onDidChangeCodeLensesEmitter.fire();
    }

    public clearReview(uri: vscode.Uri) {
        this.pendingReviews.delete(uri.toString());
        this.onDidChangeCodeLensesEmitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const review = this.pendingReviews.get(document.uri.toString());
        if (!review) return [];

        const acceptCommand: vscode.Command = {
            title: "✅ Accept AI Edit",
            command: "nexus.acceptEdit",
            arguments: [document.uri, review.taskKey] // Pass the taskKey back to the command
        };

        const rejectCommand: vscode.Command = {
            title: "❌ Reject AI Edit",
            command: "nexus.rejectEdit",
            arguments: [document.uri, review.taskKey] // Pass the taskKey back to the command
        };

        return [
            new vscode.CodeLens(review.range, acceptCommand),
            new vscode.CodeLens(review.range, rejectCommand)
        ];
    }
}