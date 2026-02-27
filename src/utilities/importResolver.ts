// src/utilities/importResolver.ts
import * as vscode from 'vscode';
import * as path from 'path';

export async function resolveMissingImports(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const text = document.getText();
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) return;

    // Find all relative import paths (e.g., import { X } from '../types')
    const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importRegex.exec(text)) !== null) {
        const importPath = match[1];

        // Skip third-party node_modules (like 'react' or 'lodash')
        if (!importPath.startsWith('.')) continue;

        const currentDir = path.dirname(document.uri.fsPath);
        let targetPath = path.resolve(currentDir, importPath);
        let targetUri = vscode.Uri.file(targetPath);

        try {
            // 1. Check if the path exists on disk
            let stat = await vscode.workspace.fs.stat(targetUri);

            // 2. 🔥 THE FIX: If it's a directory (e.g., '../types'), find the index file!
            if ((stat.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
                console.log(`[Import Resolver] Directory detected at '${importPath}'. Searching for index file...`);
                
                const indexExtensions = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
                let foundIndex = false;

                for (const ext of indexExtensions) {
                    const indexUri = vscode.Uri.file(path.join(targetPath, ext));
                    try {
                        await vscode.workspace.fs.stat(indexUri);
                        targetUri = indexUri; // We found the real file!
                        foundIndex = true;
                        break; // Stop looking once we find it
                    } catch {
                        // Index file with this extension doesn't exist, try the next one
                    }
                }

                if (!foundIndex) {
                    console.warn(`[Import Resolver] No index file found inside directory: ${targetPath}`);
                    continue; // Skip safely
                }
            }

            // 3. Safe to read the file! (If you need to parse its exports in the future)
            // const fileData = await vscode.workspace.fs.readFile(targetUri);
            // const fileContent = new TextDecoder().decode(fileData);
            
            console.log(`[Import Resolver] Successfully verified import: ${targetUri.fsPath}`);

        } catch (err) {
            // 4. If fs.stat failed, it usually means the import omitted the file extension (e.g., './App')
            // Let's test standard React/TS extensions before giving up.
            const extensions = ['.ts', '.tsx', '.js', '.jsx'];
            let foundExtension = false;
            
            for (const ext of extensions) {
                const extUri = vscode.Uri.file(targetPath + ext);
                try {
                    const extStat = await vscode.workspace.fs.stat(extUri);
                    if ((extStat.type & vscode.FileType.File) === vscode.FileType.File) {
                        foundExtension = true;
                        targetUri = extUri;
                        break;
                    }
                } catch {
                    // Extension didn't match
                }
            }

            if (!foundExtension) {
                console.warn(`[Import Resolver] Broken or missing import path: ${importPath}`);
            } else {
                console.log(`[Import Resolver] Successfully resolved extension for: ${targetUri.fsPath}`);
            }
        }
    }
    
    // NOTE: This function currently just verifies the paths exist without crashing.
    // If you want it to actively rewrite broken imports in the editor, you would build a vscode.WorkspaceEdit here!
}