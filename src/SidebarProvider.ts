import * as vscode from "vscode";
import { askQwenForStructure, askQwenForCode } from "./llmService";
import { ProvenanceTracker } from "./provenanceTracker";
import { createWorkspaceStructure } from "./workspaceManager";

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;
    _doc?: vscode.TextDocument;
    _tracker?: ProvenanceTracker;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public setProvenanceTracker(tracker: ProvenanceTracker) {
        this._tracker = tracker;
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        // Point this to where your React app compiles
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Listen for messages from the React UI
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "generateStructure": {
                    // 1. Ask Qwen for tasks and structure based on high-level wording
                    const structure = await askQwenForStructure(data.value);

                    // 2. AUTOMATICALLY create the physical files in the VS Code workspace
                    if (structure.folderStructure && structure.folderStructure.length > 0) {
                        await createWorkspaceStructure(structure.folderStructure);
                    }

                    // 3. Send tasks back to the React UI to display in the Plan Card
                    webviewView.webview.postMessage({
                        type: "structureResponse",
                        value: structure
                    });
                    break;
                }
                case "applyCode": {
                    // Example of applying code and tagging it as LLM
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        await editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, data.code);
                        });
                        // Flag this recent insertion as LLM-generated
                        this._tracker?.markLLMEdit(editor, data.code);
                    }
                    break;
                }
                // Inside your switch (data.type) block in src/SidebarProvider.ts

                // Inside your switch (data.type) cases in src/SidebarProvider.ts

                case "executeTask": { // Apply this exact same logic inside your executeAllTasks loop too!
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) return;

                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Qwen is writing code...",
                        cancellable: false
                    }, async (progress) => {
                        try {
                            // 1. Try to read the file first (if it exists) to get its current content
                            let currentContent = "";
                            let fileUri: vscode.Uri;

                            // We have to ask Qwen to map the task to a file BEFORE we know the content,
                            // so we do a quick dry-run or pass the structure. 
                            // Actually, the best way is to let Qwen pick the file, THEN we read it, 
                            // but our current architecture asks Qwen for the code and file at the same time.

                            // For now, let's keep the architecture simple: we pass the whole structure,
                            // ask Qwen to give us the whole file back.
                            const result = await askQwenForCode(data.task, data.availableFiles || [], "");
                            fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, result.filepath);

                            // 2. Just-In-Time file creation
                            try {
                                await vscode.workspace.fs.stat(fileUri);
                            } catch {
                                console.log(`Creating missing file: ${result.filepath}`);
                                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                            }

                            // 3. Open the specific file
                            const document = await vscode.workspace.openTextDocument(fileUri);
                            const editor = await vscode.window.showTextDocument(document, { preview: false });

                            // ** NEW REPLACEMENT LOGIC **
                            // Read what is currently in the file now that we know which file it is
                            currentContent = document.getText();

                            // If the file already had stuff in it, we need to ask Qwen ONE MORE TIME 
                            // to update it properly with context, otherwise it overwrites blindly.
                            let finalCode = result.code;
                            if (currentContent.trim() !== "") {
                                progress.report({ message: `Updating existing file context for ${result.filepath}...` });
                                const updatedResult = await askQwenForCode(data.task, data.availableFiles || [], currentContent,data.codingStyle);
                                finalCode = updatedResult.code;
                            }

                            // 4. REPLACE the entire file content instead of appending
                            await editor.edit(editBuilder => {
                                // Select the entire document from start to finish
                                const fullRange = new vscode.Range(
                                    document.positionAt(0),
                                    document.positionAt(document.getText().length)
                                );
                                // Replace everything with the new final code
                                editBuilder.replace(fullRange, finalCode);
                            });

                            // 5. Track the provenance (now highlights the whole block)
                            this._tracker?.markLLMEdit(editor, finalCode);
                            webviewView.webview.postMessage({ type: 'taskCompleted', task: data.task });

                        } catch (error) {
                            console.error("Execution error:", error);
                            vscode.window.showErrorMessage("Qwen encountered an error generating the code.");
                        }
                    });
                    break;
                }
                case "executeAllTasks": {
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        vscode.window.showErrorMessage("Qwen: Please open a workspace folder first.");
                        return;
                    }

                    const { tasks, availableFiles } = data;

                    // Use VS Code's progress UI to show overall status
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Qwen is autonomously executing the plan...",
                        cancellable: true
                    }, async (progress, token) => {

                        for (let i = 0; i < tasks.length; i++) {
                            if (token.isCancellationRequested) break; // Allow user to cancel the loop

                            const task = tasks[i];
                            progress.report({
                                message: `Executing task ${i + 1}/${tasks.length}...`,
                                increment: (100 / tasks.length)
                            });

                            try {
                                // 1. Get the code and the target file from Qwen
                                const result = await askQwenForCode(task, availableFiles);

                                // 2. Open the file Qwen decided on
                                const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, result.filepath);

                                // ==========================================
                                // NEW: JUST-IN-TIME FILE CREATION
                                // ==========================================
                                try {
                                    // Check if the file exists
                                    await vscode.workspace.fs.stat(fileUri);
                                } catch {
                                    // If stat throws an error, the file is missing. Let's create it!
                                    console.log(`File missing, creating on the fly: ${result.filepath}`);
                                    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
                                }
                                // ==========================================

                                const document = await vscode.workspace.openTextDocument(fileUri);
                                const editor = await vscode.window.showTextDocument(document, { preview: false });

                                // 3. Insert the code at the bottom of the file
                                await editor.edit(editBuilder => {
                                    const lastLine = document.lineAt(document.lineCount - 1);
                                    editBuilder.insert(lastLine.range.end, "\n" + result.code + "\n");
                                });

                                // 4. Highlight the code as LLM-generated!
                                this._tracker?.markLLMEdit(editor, result.code);

                                // Notify React UI that this specific task is done
                                webviewView.webview.postMessage({ type: 'taskCompleted', task: task });

                            } catch (error) {
                                console.error(`Error executing task: ${task}`, error);
                                vscode.window.showErrorMessage(`Qwen failed on task: ${task}`);
                            }
                        }

                        vscode.window.showInformationMessage("Qwen has finished executing the plan!");
                    });
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js")
        );

        // Get the local path to css file
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "style.css")
        );

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleUri}" rel="stylesheet">
        </head>
        <body>
            <div id="root"></div>
            <script type="module" src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}