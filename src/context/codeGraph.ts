import * as vscode from 'vscode';
import * as path from 'path';

// 🔥 THE BULLETPROOF WASM IMPORT: Bypasses broken TypeScript definitions
const Parser = require('web-tree-sitter');

// 🔥 The Holy Grail: A global map of every Symbol -> Filepath in the workspace
export const astSymbolGraph = new Map<string, Set<string>>();

// Use 'any' to bypass the broken web-tree-sitter typings
let parser: any = null;
let tsLanguage: any = null;
let tsxLanguage: any = null;

/**
 * Boot up the WebAssembly (WASM) Tree-Sitter engine
 */
export async function initTreeSitter(extensionUri: vscode.Uri) {
    try {
        await Parser.init();
        parser = new Parser();

        // Load the WASM binaries from your /parser directory
        const tsWasmPath = vscode.Uri.joinPath(extensionUri, 'parser', 'tree-sitter-typescript.wasm').fsPath;
        const tsxWasmPath = vscode.Uri.joinPath(extensionUri, 'parser', 'tree-sitter-tsx.wasm').fsPath;

        tsLanguage = await Parser.Language.load(tsWasmPath);
        tsxLanguage = await Parser.Language.load(tsxWasmPath);
        
        console.log("[DEBUG-AST] 🌳 Tree-Sitter WASM Engine Online.");
    } catch (error) {
        console.error("[DEBUG-AST] Failed to load Tree-Sitter:", error);
    }
}

/**
 * Scans the workspace and builds the syntax graph
 */
export async function buildWorkspaceASTGraph() {
    if (!parser || !tsLanguage || !tsxLanguage) return;
    
    astSymbolGraph.clear();
    console.log("[DEBUG-AST] 🔍 Indexing workspace AST...");

    // Grab all TS/JS files, ignoring node_modules
    const files = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx}', '{**/node_modules/**,**/dist/**,**/build/**}');

    for (const file of files) {
        try {
            const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
            const ext = path.extname(file.fsPath);

            // Assign the correct language parser
            if (ext === '.ts' || ext === '.js') parser.setLanguage(tsLanguage);
            else if (ext === '.tsx' || ext === '.jsx') parser.setLanguage(tsxLanguage);
            else continue;

            const tree = parser.parse(content);
            const relativePath = vscode.workspace.asRelativePath(file);
            
            // Recursively walk the tree and extract symbols
            extractSymbolsFromNode(tree.rootNode, relativePath);
        } catch (e) {
            // Silently ignore files that fail to parse
        }
    }
    
    console.log(`[DEBUG-AST] ✅ AST Graph Complete. Indexed ${astSymbolGraph.size} unique symbols.`);
}

// 🔥 Changed 'node' type to 'any' to satisfy the compiler
function extractSymbolsFromNode(node: any, filepath: string) {
    const type = node.type;

    // Capture Functions, Classes, and Methods
    if (type === 'function_declaration' || type === 'class_declaration' || type === 'method_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) mapSymbol(nameNode.text, filepath);
    } 
    // Capture Variables & Constants
    else if (type === 'variable_declarator') {
        const nameNode = node.childForFieldName('name');
        if (nameNode) mapSymbol(nameNode.text, filepath);
    }

    // Recurse down the tree
    if (node.children) {
        for (const child of node.children) {
            extractSymbolsFromNode(child, filepath);
        }
    }
}

function mapSymbol(name: string, filepath: string) {
    if (name.length < 3) return; // Ignore tiny variables like 'i' or 'x'
    if (!astSymbolGraph.has(name)) astSymbolGraph.set(name, new Set());
    astSymbolGraph.get(name)!.add(filepath);
}

/**
 * 🎯 PILLAR 1: The Smart Router
 * Takes a casual user prompt, finds the nouns, and returns the exact files that define them!
 */
export async function getSmartASTContext(prompt: string): Promise<string> {
    const words = prompt.split(/[\s,;.?!()\[\]{}"']+/);
    const matchedFiles = new Set<string>();

    // Check if any word in the user's prompt matches a defined symbol in our AST Graph
    for (const word of words) {
        if (word.length > 3 && astSymbolGraph.has(word)) {
            const files = astSymbolGraph.get(word)!;
            files.forEach(f => matchedFiles.add(f));
        }
    }

    if (matchedFiles.size === 0) return "";

    let astContext = "--- 🌳 EXACT AST SYMBOL MATCHES ---\n";
    for (const filepath of matchedFiles) {
        try {
            const fileUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, filepath);
            const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
            astContext += `📍 ${filepath} (Contains symbols mentioned in prompt):\n\`\`\`\n${content}\n\`\`\`\n`;
        } catch (e) {}
    }

    console.log(`[DEBUG-AST] 🎯 Smart Router intercepted ${matchedFiles.size} files for prompt.`);
    return astContext;
}