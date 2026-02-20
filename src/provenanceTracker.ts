import * as vscode from 'vscode';

export class ProvenanceTracker {
    // 1. Decoration for code currently under review
    private pendingDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(139, 92, 246, 0.2)', // Noticeable purple background
        isWholeLine: true,
        border: '1px dashed rgba(139, 92, 246, 0.8)'
    });

    // 2. Decoration for approved AI code
    private approvedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(139, 92, 246, 0.04)', // Very faint purple
        isWholeLine: true,
        gutterIconPath: vscode.Uri.parse('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="%238B5CF6" d="M8 1l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>'),
        gutterIconSize: 'contain'
    });

    public async applyAndRequestApproval(editor: vscode.TextEditor, newCode: string, taskName: string): Promise<string> {
        const document = editor.document;
        
        // 1. Apply the code replacement
        await editor.edit(editBuilder => {
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            editBuilder.replace(fullRange, newCode);
        });

        // 2. Highlight the document as "Pending Review"
        const reviewRange = new vscode.Range(0, 0, document.lineCount, 0);
        editor.setDecorations(this.pendingDecoration, [reviewRange]);

        // 3. Pause and ask the human for approval
        const choice = await vscode.window.showInformationMessage(
            `Qwen completed: "${taskName}". Do you approve these changes?`,
            { modal: false },
            "Accept", "Reject"
        );

        // 4. Handle the human's decision
        editor.setDecorations(this.pendingDecoration, []); // Remove pending highlight

        if (choice === "Accept") {
            // Keep a faint marker that this was AI-generated
            editor.setDecorations(this.approvedDecoration, [reviewRange]);
            vscode.window.showInformationMessage("Changes accepted.");
            return "approved";
        } else {
            // Undo the code insertion natively
            await vscode.commands.executeCommand('undo');
            vscode.window.showWarningMessage("Changes rejected and reverted.");
            return "rejected";
        }
    }
}