"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCanonicalPaths = resolveCanonicalPaths;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs")); // Import Node.js File System
const outputChannel = vscode.window.createOutputChannel("NexusCode Path Debug");
/**
 * Resolves paths.
 * @param rootPath (Optional) If provided, searches this specific directory on disk (Meta-Mode).
 * If null, searches the open VS Code workspace (User Mode).
 */
async function resolveCanonicalPaths(plannedFiles, rootPath) {
    outputChannel.show(true);
    outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Path Resolution Started`);
    outputChannel.appendLine(`[Mode] ${rootPath ? `META-MODE (Scanning: ${rootPath})` : "USER-MODE (Scanning Workspace)"}`);
    outputChannel.appendLine(`[Input] ${JSON.stringify(plannedFiles)}`);
    const finalPaths = [];
    const renamingMap = new Map();
    if (!plannedFiles || plannedFiles.length === 0) {
        return { finalPaths: [], renamingMap };
    }
    for (const plannedPath of plannedFiles) {
        outputChannel.appendLine(`\n--- Resolving: ${plannedPath} ---`);
        let foundPath = null;
        if (rootPath) {
            // META-MODE: Search on disk directly
            foundPath = await findFileOnDisk(plannedPath, rootPath);
        }
        else {
            // USER-MODE: Use VS Code API
            foundPath = await findFileInWorkspace(plannedPath);
        }
        if (foundPath) {
            outputChannel.appendLine(`  ✅ FOUND: ${foundPath}`);
            finalPaths.push(foundPath);
            renamingMap.set(plannedPath, foundPath);
        }
        else {
            outputChannel.appendLine(`  ⚠️ NOT FOUND. Creating new: ${plannedPath}`);
            finalPaths.push(plannedPath);
        }
    }
    const uniquePaths = Array.from(new Set(finalPaths));
    return { finalPaths: uniquePaths, renamingMap };
}
// --- USER MODE: VS CODE WORKSPACE SEARCH ---
async function findFileInWorkspace(targetPath) {
    const filename = path.basename(targetPath);
    const exclude = '**/{node_modules,dist,out,build,.git,.vscode,coverage}/**';
    // Use VS Code's fast internal search
    const foundUris = await vscode.workspace.findFiles(`**/${filename}`, exclude, 10);
    if (foundUris.length === 0)
        return null;
    // Sort by path length (shortest is usually the source file)
    foundUris.sort((a, b) => a.fsPath.length - b.fsPath.length);
    return vscode.workspace.asRelativePath(foundUris[0]); // length > 0 guarded
}
// --- META MODE: NODE.JS RECURSIVE SEARCH ---
async function findFileOnDisk(targetPath, rootDir) {
    const filename = path.basename(targetPath);
    // We must manually crawl because vscode.findFiles can't see outside the workspace
    const matches = crawlDirectory(rootDir, filename);
    if (matches.length === 0)
        return null;
    // Sort by shortest path
    matches.sort((a, b) => a.length - b.length);
    // Return path relative to the root (so the AI understands it)
    return path.relative(rootDir, matches[0]); // length > 0 guarded above
}
function crawlDirectory(dir, targetFilename, depth = 0) {
    // Safety break to prevent infinite loops or huge scans
    if (depth > 8)
        return [];
    let results = [];
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            // Ignore junk folders
            if (['node_modules', 'dist', 'out', 'build', '.git', '.vscode'].includes(file))
                continue;
            if (stat.isDirectory()) {
                // Recurse
                results = results.concat(crawlDirectory(fullPath, targetFilename, depth + 1));
            }
            else if (file === targetFilename) {
                // Match!
                results.push(fullPath);
            }
        }
    }
    catch (e) {
        // Ignore permission errors etc.
    }
    return results;
}
//# sourceMappingURL=pathUtils.js.map