import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs'; // Import Node.js File System

const outputChannel = vscode.window.createOutputChannel("NexusCode Path Debug");

/**
 * Resolves paths.
 * @param rootPath (Optional) If provided, searches this specific directory on disk (Meta-Mode). 
 * If null, searches the open VS Code workspace (User Mode).
 */
export async function resolveCanonicalPaths(
    plannedFiles: string[], 
    rootPath?: string 
): Promise<{ finalPaths: string[], renamingMap: Map<string, string> }> {
    
    outputChannel.show(true);
    outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Path Resolution Started`);
    outputChannel.appendLine(`[Mode] ${rootPath ? `META-MODE (Scanning: ${rootPath})` : "USER-MODE (Scanning Workspace)"}`);
    outputChannel.appendLine(`[Input] ${JSON.stringify(plannedFiles)}`);

    const finalPaths: string[] = [];
    const renamingMap = new Map<string, string>(); 

    if (!plannedFiles || plannedFiles.length === 0) {
        return { finalPaths: [], renamingMap };
    }

    for (const plannedPath of plannedFiles) {
        outputChannel.appendLine(`\n--- Resolving: ${plannedPath} ---`);
        let foundPath: string | null = null;

        if (rootPath) {
            // META-MODE: Search on disk directly
            foundPath = await findFileOnDisk(plannedPath, rootPath);
        } else {
            // USER-MODE: Use VS Code API
            foundPath = await findFileInWorkspace(plannedPath);
        }

        if (foundPath) {
            outputChannel.appendLine(`  ✅ FOUND: ${foundPath}`);
            finalPaths.push(foundPath);
            renamingMap.set(plannedPath, foundPath);
        } else {
            outputChannel.appendLine(`  ⚠️ NOT FOUND. Creating new: ${plannedPath}`);
            finalPaths.push(plannedPath);
        }
    }

    const uniquePaths = Array.from(new Set(finalPaths));
    return { finalPaths: uniquePaths, renamingMap };
}

// --- USER MODE: VS CODE WORKSPACE SEARCH ---
async function findFileInWorkspace(targetPath: string): Promise<string | null> {
    const filename = path.basename(targetPath);
    const exclude = '**/{node_modules,dist,out,build,.git,.vscode,coverage}/**';
    
    // Use VS Code's fast internal search
    const foundUris = await vscode.workspace.findFiles(`**/${filename}`, exclude, 10);
    
    if (foundUris.length === 0) return null;

    // Sort by path length (shortest is usually the source file)
    foundUris.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return vscode.workspace.asRelativePath(foundUris[0]);
}

// --- META MODE: NODE.JS RECURSIVE SEARCH ---
async function findFileOnDisk(targetPath: string, rootDir: string): Promise<string | null> {
    const filename = path.basename(targetPath);
    
    // We must manually crawl because vscode.findFiles can't see outside the workspace
    const matches = crawlDirectory(rootDir, filename);

    if (matches.length === 0) return null;

    // Sort by shortest path
    matches.sort((a, b) => a.length - b.length);

    // Return path relative to the root (so the AI understands it)
    return path.relative(rootDir, matches[0]);
}

function crawlDirectory(dir: string, targetFilename: string, depth = 0): string[] {
    // Safety break to prevent infinite loops or huge scans
    if (depth > 8) return []; 

    let results: string[] = [];
    
    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);

            // Ignore junk folders
            if (['node_modules', 'dist', 'out', 'build', '.git', '.vscode'].includes(file)) continue;

            if (stat.isDirectory()) {
                // Recurse
                results = results.concat(crawlDirectory(fullPath, targetFilename, depth + 1));
            } else if (file === targetFilename) {
                // Match!
                results.push(fullPath);
            }
        }
    } catch (e) {
        // Ignore permission errors etc.
    }
    return results;
}