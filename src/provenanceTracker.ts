import * as vscode from 'vscode';

export class ProvenanceTracker {
    // Faint green highlight with a left border for LLM code
    private llmDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(0, 255, 0, 0.08)',
        isWholeLine: true,
        borderWidth: '0 0 0 3px',
        borderColor: 'rgba(0, 255, 0, 0.5)',
        borderStyle: 'solid'
    });

    private fileState: Map<string, vscode.Range[]> = new Map();

    public markLLMEdit(editor: vscode.TextEditor, code: string) {
        const docUri = editor.document.uri.toString();
        const ranges = this.fileState.get(docUri) || [];
        
        // Calculate the range of the newly inserted code
        const startLine = editor.selection.active.line;
        const lineCount = code.split('\n').length;
        const newRange = new vscode.Range(startLine, 0, startLine + lineCount - 1, 0);
        
        ranges.push(newRange);
        this.fileState.set(docUri, ranges);
        
        editor.setDecorations(this.llmDecorationType, ranges);
    }

    public handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
        // If a human types, we need to intercept.
        // NOTE: In a full production app, you need complex logic here to shift 
        // the tracked LLM ranges up or down if the user presses "Enter" or deletes lines.
        // This is the foundation to hook into.
        
        const isHuman = event.reason === undefined; // Usually undefined means manual typing
        if (isHuman) {
            // Logic to update `this.fileState` and remove/shift LLM ranges goes here.
        }
    }
}