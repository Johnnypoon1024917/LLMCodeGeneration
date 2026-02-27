// src/workspaceManager.ts
import * as vscode from 'vscode';

export async function createWorkspaceStructure(folderStructure: string[]) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("Please open a workspace folder first.");
        return;
    }

    const rootUri = workspaceFolders[0].uri;

    for (const filePath of folderStructure) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, filePath);

            // =========================================================
            // FIX: CHECK EXISTENCE BEFORE WRITING
            // =========================================================
            try {
                // If this succeeds, the file exists -> DO NOT TOUCH IT
                await vscode.workspace.fs.stat(fileUri);
                // console.log(`Skipping existing file: ${filePath}`);
                continue; 
            } catch {
                // If stat throws, the file does NOT exist -> Safe to create
                await vscode.workspace.fs.writeFile(fileUri, new Uint8Array(0));
            }
            
        } catch (error) {
            console.error(`Failed to scaffold ${filePath}:`, error);
        }
    }
}