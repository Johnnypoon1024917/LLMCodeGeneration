// src/utilities/importResolver.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { log } from '../logger';

/**
 * Scans the active document for relative imports and automatically fixes:
 * 1. Missing file extensions (e.g., './App' -> './App.tsx')
 * 2. Directory imports missing index files (e.g., './components' -> './components/index.tsx')
 */
export async function resolveMissingImports(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const text = document.getText();
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) return;

    // Regex to find relative import paths (e.g., import { X } from '../types')
    const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    const workspaceEdit = new vscode.WorkspaceEdit();
    let hasFixes = false;

    while ((match = importRegex.exec(text)) !== null) {
        const importPath = match[1];
        if (importPath === undefined || match[0] === undefined) continue;

        // Skip third-party node_modules (like 'react' or 'lodash')
        if (!importPath.startsWith('.')) continue;

        const currentDir = path.dirname(document.uri.fsPath);
        let absoluteTargetPath = path.resolve(currentDir, importPath);
        let targetUri = vscode.Uri.file(absoluteTargetPath);

        // Calculate the range of the path string within the document for replacement
        const startOffset = match.index + match[0].indexOf(importPath);
        const endOffset = startOffset + importPath.length;
        const pathRange = new vscode.Range(
            document.positionAt(startOffset),
            document.positionAt(endOffset)
        );

        try {
            // 1. Check if the path exists exactly as written
            const stat = await vscode.workspace.fs.stat(targetUri);

            // 2. If it's a directory, check for an index file
            if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
                const indexExtensions = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
                
                for (const ext of indexExtensions) {
                    const indexUri = vscode.Uri.file(path.join(absoluteTargetPath, ext));
                    try {
                        await vscode.workspace.fs.stat(indexUri);
                        // Found a valid index file inside the directory
                        const newPath = `${importPath}/${ext.replace(/\.tsx?$/, '')}`; // Standardize path
                        workspaceEdit.replace(document.uri, pathRange, newPath);
                        hasFixes = true;
                        break; 
                    } catch {
                        // Extension not found, try next
                    }
                }
            }
        } catch (err) {
            // 3. If stat failed, the path is likely missing an extension (e.g., './App')
            const extensions = ['.ts', '.tsx', '.js', '.jsx'];
            
            for (const ext of extensions) {
                const extUri = vscode.Uri.file(absoluteTargetPath + ext);
                try {
                    const extStat = await vscode.workspace.fs.stat(extUri);
                    if ((extStat.type & vscode.FileType.File) === vscode.FileType.File) {
                        // Found the file with the missing extension
                        const newPath = importPath + ext;
                        workspaceEdit.replace(document.uri, pathRange, newPath);
                        hasFixes = true;
                        log.info(`[Import Resolver] Auto-fixed: ${importPath} -> ${newPath}`);
                        break;
                    }
                } catch {
                    // Try next extension
                }
            }
        }
    }

    // 4. Apply all identified fixes in a single atomic transaction
    if (hasFixes) {
        const success = await vscode.workspace.applyEdit(workspaceEdit);
        if (success) {
            vscode.window.setStatusBarMessage("✨ NexusCode: Imports resolved.", 3000);
        }
    }
}