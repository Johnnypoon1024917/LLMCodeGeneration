// src/metaContextManager.ts
import * as vscode from 'vscode';
import * as path from 'path';

export class MetaContextManager {
    private extensionUri: vscode.Uri;
    private backupUri: vscode.Uri | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.extensionUri = context.extensionUri;
    }

    /**
     * Creates a safety snapshot of the 'src' directory.
     * Call this BEFORE letting the AI edit the extension's own code.
     */
    public async createBackup(): Promise<boolean> {
        try {
            const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.backupUri = vscode.Uri.joinPath(this.extensionUri, `src_backup_${timestamp}`);

            // Copy src -> src_backup_...
            await vscode.workspace.fs.copy(srcUri, this.backupUri, { overwrite: true });
            
            console.log(`[MetaManager] Backup created at: ${this.backupUri.fsPath}`);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`CRITICAL: Failed to create backup. Self-evolution aborted.`);
            console.error(error);
            return false;
        }
    }

    /**
     * Restores the 'src' directory from the last backup.
     * Call this if 'npm run compile' fails.
     */
    public async restoreBackup(): Promise<void> {
        if (!this.backupUri) {
            vscode.window.showErrorMessage("No backup found to restore!");
            return;
        }

        try {
            const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
            
            // 1. Delete the broken 'src'
            await vscode.workspace.fs.delete(srcUri, { recursive: true, useTrash: false });

            // 2. Copy backup -> src
            await vscode.workspace.fs.copy(this.backupUri, srcUri, { overwrite: true });

            vscode.window.showInformationMessage("Safety Guardrail: Source code restored from backup.");
        } catch (error) {
            vscode.window.showErrorMessage("CRITICAL: Restore failed. You may need to manually fix the source.");
            console.error(error);
        }
    }

    /**
     * Switches the "Project Context" to point to the Extension itself.
     */
    public async getSelfContext(): Promise<string> {
        const srcUri = vscode.Uri.joinPath(this.extensionUri, 'src');
        // Read directory structure of the extension itself
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(srcUri, '**/*.ts'),
            '**/node_modules/**'
        );

        const fileList = files.map(f => path.relative(this.extensionUri.fsPath, f.fsPath)).join('\n');
        return `EXTENSION SOURCE STRUCTURE:\n${fileList}`;
    }
}