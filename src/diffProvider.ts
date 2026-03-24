// src/diffProvider.ts
import * as vscode from 'vscode';

export class NexusOriginalContentProvider implements vscode.TextDocumentContentProvider {
    private _documents = new Map<string, string>();
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();

    get onDidChange() {
        return this._onDidChange.event;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._documents.get(uri.toString()) || "";
    }

    setContent(uri: vscode.Uri, content: string) {
        this._documents.set(uri.toString(), content);
        this._onDidChange.fire(uri); // Tells VS Code the virtual doc updated
    }
}

// Export a singleton instance
export const originalContentProvider = new NexusOriginalContentProvider();