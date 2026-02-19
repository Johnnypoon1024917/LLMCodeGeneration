import * as vscode from 'vscode';

export class EditorManager {
    private editQueue: Promise<void> = Promise.resolve();
    private decorationType: vscode.TextEditorDecorationType;
    private startPos: vscode.Position | null = null;

    constructor() {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.15)', // Light green highlight
            isWholeLine: false,
        });
    }

    public async insertStreamedText(text: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        // Queue edits to prevent overlapping edit collisions
        this.editQueue = this.editQueue.then(async () => {
            const position = editor.selection.active;
            if (!this.startPos) this.startPos = position;

            await editor.edit(editBuilder => {
                editBuilder.insert(position, text);
            });

            // Update highlighting range
            const endPos = editor.selection.active;
            const range = new vscode.Range(this.startPos, endPos);
            editor.setDecorations(this.decorationType, [range]);
        });
    }

    public clearHighlighting() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(this.decorationType, []);
        }
        this.startPos = null;
    }
}