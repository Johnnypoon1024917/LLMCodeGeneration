// src/providers/DiffProvider.ts
import * as vscode from 'vscode';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
    // Map of URI string to original file content
    private originalContents = new Map<string, string>();
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this.onDidChangeEmitter.event;

    // The agent calls this before writing new code
    public registerOriginalContent(uri: vscode.Uri, content: string) {
        this.originalContents.set(uri.toString(), content);
        this.onDidChangeEmitter.fire(uri);
    }

    // VS Code calls this when it opens `nexus-original://...`
    provideTextDocumentContent(uri: vscode.Uri): string {
        // We strip the custom scheme to find the original content
        const targetUri = uri.with({ scheme: 'file' }).toString();
        return this.originalContents.get(targetUri) || 'Content not found.';
    }
}