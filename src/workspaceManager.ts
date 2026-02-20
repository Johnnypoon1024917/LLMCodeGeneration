import * as vscode from 'vscode';

export async function createWorkspaceStructure(folderStructure: string[]) {
    // 1. Check if the user actually has a folder open in VS Code
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("Qwen: Please open a workspace folder first so I have a place to create these files.");
        return;
    }

    // 2. Get the root path of the currently open project
    const rootUri = workspaceFolders[0].uri;

    // 3. Loop through the JSON array and create each file
    for (const filePath of folderStructure) {
        try {
            // Join the root path with the LLM's suggested file path
            const fileUri = vscode.Uri.joinPath(rootUri, filePath);
            
            // Create an empty file (Uint8Array represents binary data)
            // Note: VS Code's fs.writeFile automatically creates any missing parent directories!
            const emptyContent = new Uint8Array(0);
            await vscode.workspace.fs.writeFile(fileUri, emptyContent);
            
        } catch (error) {
            console.error(`Failed to create ${filePath}:`, error);
            vscode.window.showErrorMessage(`Qwen failed to create file: ${filePath}`);
        }
    }

    vscode.window.showInformationMessage("Qwen successfully scaffolded your workspace!");
}