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
exports.invalidateProjectContext = invalidateProjectContext;
exports.getProjectContext = getProjectContext;
exports.getRepoContent = getRepoContent;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const logger_1 = require("./logger");
const contextCache = new Map();
function invalidateProjectContext() {
    contextCache.clear();
    logger_1.log.debug("[DEBUG] 🗑️ Project context cache cleared.");
}
/**
 * Normalizes a file path to handle Windows drive letter inconsistencies.
 * Ensures that 'C:\' and 'c:\' are treated as the same root.
 */
function normalizePath(p) {
    return p.replace(/^[a-zA-Z]:/, (match) => match.toLowerCase());
}
/**
 * Generates a visual ASCII tree of the project.
 * Supports both VS Code Workspace (User Mode) and Disk Path (Meta Mode).
 */
async function getProjectContext(rootPath) {
    // Determine the root directory: Use the argument if provided (Meta-Mode), otherwise use workspace (User-Mode)
    const rawRootDir = rootPath || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : "");
    if (!rawRootDir) {
        return "No workspace open.";
    }
    const rootDir = normalizePath(rawRootDir);
    //  FIX 1: Check the cache! If we already scanned this folder, return it instantly.
    // This drops your TTFT (Time-To-First-Token) from ~3 seconds down to ~20 milliseconds!
    if (contextCache.has(rootDir)) {
        return contextCache.get(rootDir);
    }
    let filePaths = [];
    if (rootPath) {
        // META-MODE: Scan folder on disk using Node.js fs
        filePaths = crawlDirectory(rootDir);
    }
    else {
        // USER-MODE: Scan via VS Code API (Respects .gitignore)
        const excludePattern = '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/.vscode/**,**/coverage/**,**/.next/**}';
        const files = await vscode.workspace.findFiles('**/*', excludePattern, 2000);
        filePaths = files.map(f => path.relative(rootDir, normalizePath(f.fsPath)));
    }
    // Sort for determinism and logical grouping
    filePaths.sort();
    const treeString = generateAsciiTree(filePaths);
    const finalContext = `CURRENT REPOSITORY STRUCTURE (${rootPath ? 'Meta-Mode' : 'User-Mode'}):\n${treeString}`;
    //  FIX 2: Save the generated tree to the cache before returning it
    contextCache.set(rootDir, finalContext);
    return finalContext;
}
/**
 * Gathers file contents to provide codebase context to the AI model.
 * Handles token budgeting by prioritizing entry points and core source files.
 */
async function getRepoContent(tokenBudgetChars = 200000, rootPath) {
    let fullContent = "REPOSITORY CODEBASE CONTEXT:\n\n";
    let currentChars = 0;
    const rawRootDir = rootPath || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : "");
    if (!rawRootDir) {
        return "";
    }
    const rootDir = normalizePath(rawRootDir);
    // Helper to read file safely using VS Code FS API
    const readFile = async (filePath) => {
        try {
            const uri = vscode.Uri.file(filePath);
            const fileData = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(fileData);
        }
        catch {
            return "";
        }
    };
    // In Meta-Mode, scan disk. In User-Mode, use VS Code API.
    let filesToRead = rootPath ? crawlDirectory(rootDir) : (await getAllWorkspaceFiles());
    // Filter for only important code files and exclude build artifacts
    filesToRead = filesToRead.filter(f => isImportantFile(f) &&
        !f.includes('build/') &&
        !f.includes('assets/') &&
        !f.includes('dist/') &&
        !f.includes('node_modules/'));
    // Prioritization Sort: Entry points (App, main, index) and src files first
    filesToRead.sort((a, b) => {
        const getPriority = (p) => {
            const lower = p.toLowerCase();
            if (lower.includes('app.')) {
                return -3;
            }
            if (lower.includes('main.')) {
                return -2;
            }
            if (lower.includes('index.')) {
                return -2;
            }
            if (p.startsWith('src/')) {
                return -1;
            }
            return 0;
        };
        return getPriority(a) - getPriority(b);
    });
    for (const relativePath of filesToRead) {
        if (currentChars >= tokenBudgetChars) {
            break;
        }
        const fullPath = path.join(rootDir, relativePath);
        const content = await readFile(fullPath);
        // Skip files that are likely minified or irrelevant boilerplate
        if (content.length > 35000 || content.length < 5) {
            continue;
        }
        const fileBlock = `\n--- START OF FILE: ${relativePath} ---\n${content}\n--- END OF FILE: ${relativePath} ---\n`;
        if (currentChars + fileBlock.length < tokenBudgetChars) {
            fullContent += fileBlock;
            currentChars += fileBlock.length;
        }
    }
    return fullContent;
}
// --- HELPER: Recursive Disk Crawler (Node.js) ---
function crawlDirectory(dir, baseDir = dir) {
    let results = [];
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            // Ignore common junk and binary folders
            if (['node_modules', 'dist', 'out', 'build', '.git', '.vscode', 'assets'].includes(file)) {
                continue;
            }
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                results = results.concat(crawlDirectory(fullPath, baseDir));
            }
            else {
                results.push(path.relative(baseDir, normalizePath(fullPath)));
            }
        }
    }
    catch (e) { /* ignore permissions or read errors */ }
    return results;
}
// --- HELPER: VS Code API Crawler ---
async function getAllWorkspaceFiles() {
    const exclude = '{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/out/**}';
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,css,json,py,rs,go,html}', exclude, 250);
    return files.map(f => vscode.workspace.asRelativePath(f));
}
function isImportantFile(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const importantExtensions = ['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.py', '.rs', '.go'];
    return importantExtensions.includes(ext);
}
// --- TREE GENERATOR ---
function generateAsciiTree(paths) {
    const tree = {};
    paths.forEach(p => {
        const parts = p.split(/[\\\/]/); // Support both slash types
        let currentLevel = tree;
        parts.forEach(part => {
            if (!currentLevel[part]) {
                currentLevel[part] = {};
            }
            currentLevel = currentLevel[part];
        });
    });
    function drawTree(node, prefix = '', _isLast = true) {
        const keys = Object.keys(node);
        let result = '';
        keys.forEach((key, index) => {
            const isLastChild = index === keys.length - 1;
            const connector = isLastChild ? '└── ' : '├── ';
            const childPrefix = isLastChild ? '    ' : '│   ';
            result += `${prefix}${connector}${key}\n`;
            if (Object.keys(node[key]).length > 0) {
                result += drawTree(node[key], prefix + childPrefix, isLastChild);
            }
        });
        return result;
    }
    return drawTree(tree);
}
//# sourceMappingURL=projectContext.js.map