import * as vscode from 'vscode';
import * as path from 'path';

export interface FileNode {
    filepath: string;
    imports: string[];
    exports: string[];
    classes: string[];
    functions: string[];
    interfaces: string[]; // 🔥 NEW
    variables: string[];  // 🔥 NEW
}

let workspaceGraph = new Map<string, FileNode>();

// 🔥 NEW: Correlation Scoring Interface
export interface ScoredNode {
    filepath: string;
    score: number;
    reasons: string[];
    node: FileNode;
}

/**
 * 🧮 THE CORRELATION ENGINE: Mathematically scores how related every file is to the target edit.
 */
export function calculateGraphCorrelation(targetFileQuery: string): ScoredNode[] {
    const results: ScoredNode[] = [];
    const targetKey = Array.from(workspaceGraph.keys()).find(k => k.includes(targetFileQuery));

    if (!targetKey) return [];

    const targetNode = workspaceGraph.get(targetKey)!;
    const cleanTarget = targetKey.replace(/\.[^/.]+$/, ""); // Strip extensions for import matching

    for (const [filepath, node] of workspaceGraph.entries()) {
        if (filepath === targetKey) {
            results.push({ filepath, score: 100, reasons: ['📍 Target File'], node });
            continue;
        }

        let score = 0;
        const reasons: string[] = [];
        const cleanFilepath = filepath.replace(/\.[^/.]+$/, "");

        // 1. Dependency: Does the Target import this file? (What tools does the AI have?)
        if (targetNode.imports.some(imp => cleanFilepath.includes(imp.replace(/['"\.\/]/g, '')))) {
            score += 80;
            reasons.push('🔧 Direct Dependency');
        }

        // 2. Dependent: Does this file import the Target? (The Blast Radius)
        if (node.imports.some(imp => cleanTarget.includes(imp.replace(/['"\.\/]/g, '')))) {
            score += 85;
            reasons.push('⚠️ Dependent (Blast Radius)');
        }

        // 3. Sibling: Are they in the same exact directory? (Domain proximity)
        if (path.dirname(filepath) === path.dirname(targetKey)) {
            score += 30;
            reasons.push('📁 Sibling File');
        }

        // 4. Shared External Libs (e.g., both use React or Mongoose)
        const sharedImports = node.imports.filter(imp => targetNode.imports.includes(imp));
        if (sharedImports.length > 0) {
            score += (sharedImports.length * 5); // +5 points for every shared library
            reasons.push(`🔗 Shared Libs (${sharedImports.length})`);
        }

        if (score > 0) {
            results.push({ filepath, score, reasons, node });
        }
    }

    // Sort by highest correlation score
    return results.sort((a, b) => b.score - a.score);
}

/**
 * 🗺️ THE UPGRADED RAG OUTPUT: Feeds only the highest-scoring files to the LLM.
 */
export async function getSmartASTContext(targetFileQuery: string): Promise<string> {
    if (workspaceGraph.size === 0) return "";

    const scoredNodes = calculateGraphCorrelation(targetFileQuery);
    
    if (scoredNodes.length === 0) return "--- 🗺️ WORKSPACE STRUCTURAL GRAPH ---\nNo relational data found.\n-------------------------------------\n";

    let context = "--- 🗺️ GRAPH-RAG CORRELATION MATRIX ---\n";
    context += `The following files have been mathematically scored for relevance to your target: ${targetFileQuery}\n\n`;

    // Only feed the LLM the Top 5 most correlated files to save tokens and prevent distraction
    const topNodes = scoredNodes.slice(0, 5);

    for (const scored of topNodes) {
        context += `[Score: ${scored.score}] ${scored.filepath} (${scored.reasons.join(', ')})\n`;
        context += `  - Exports: ${scored.node.exports.length > 0 ? scored.node.exports.join(', ') : 'None'}\n`;
        context += `  - Classes: ${scored.node.classes.length > 0 ? scored.node.classes.join(', ') : 'None'}\n`;
        context += `  - Functions: ${scored.node.functions.length > 0 ? scored.node.functions.join(', ') : 'None'}\n`;
        context += `  - Interfaces/Vars: ${[...scored.node.interfaces, ...scored.node.variables].join(', ')}\n\n`;
    }

    if (scoredNodes.length > 5) {
        context += `... and ${scoredNodes.length - 5} other loosely related files omitted for token efficiency.\n`;
    }

    return context + "-------------------------------------\n";
}

/**
 * 🚀 THE LSP PREPROCESSOR: Sweeps the workspace using VS Code's Native AST Brain.
 */
export async function buildWorkspaceGraph(workspaceRoot: vscode.Uri) {
    workspaceGraph.clear();
    console.log("[DEBUG-GRAPH] Booting up LSP-Powered Graph Engine...");

    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceRoot, '**/*.{ts,tsx,js,jsx,py,go}'),
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}'
    );

    for (const file of files) {
        try {
            const relativePath = vscode.workspace.asRelativePath(file);
            const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
            
            const node: FileNode = { filepath: relativePath, imports: [], exports: [], classes: [], functions: [], interfaces: [], variables: [] };

            // 1. Fast Regex for Imports/Exports (Keeps the 3D links lightning fast)
            extractImportsAndExports(content, node);

            // 2. 🧠 VS CODE LSP AST ENGINE (Perfect precision for Functions and Classes)
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', 
                file
            );

            if (symbols && symbols.length > 0) {
                // LSP Success! Recursively crawl the true AST tree.
                traverseSymbols(symbols, node);
            } else {
                // LSP Fallback: Language server might not be booted for this file yet.
                extractStructureRegex(content, node);
            }

            workspaceGraph.set(relativePath, node);
        } catch (e) {
            console.warn(`[DEBUG-GRAPH] Failed to parse ${file.fsPath}`);
        }
    }
    
    console.log(`[DEBUG-GRAPH] LSP Graph built successfully! Mapped ${workspaceGraph.size} files.`);
}

/**
 * 🌲 THE DEEP AST CRAWLER: Navigates VS Code's native symbol tree perfectly.
 */
function traverseSymbols(symbols: vscode.DocumentSymbol[], node: FileNode) {
    for (const sym of symbols) {
        if (sym.kind === vscode.SymbolKind.Class) {
            if (!node.classes.includes(sym.name)) node.classes.push(sym.name);
        } else if (sym.kind === vscode.SymbolKind.Function || sym.kind === vscode.SymbolKind.Method) {
            if (!node.functions.includes(sym.name)) node.functions.push(sym.name);
        } else if (sym.kind === vscode.SymbolKind.Interface || sym.kind === vscode.SymbolKind.Struct) {
            if (!node.interfaces.includes(sym.name)) node.interfaces.push(sym.name);
        } else if (sym.kind === vscode.SymbolKind.Variable || sym.kind === vscode.SymbolKind.Constant) {
            // Ignore messy local variables, only grab top-level or significant ones
            if (!node.variables.includes(sym.name)) node.variables.push(sym.name);
        }
        
        if (sym.children && sym.children.length > 0) {
            traverseSymbols(sym.children, node);
        }
    }
}

/**
 * ⚡ FAST RELATIONSHIP PARSER: Rips out the connection data for the 3D Graph
 */
function extractImportsAndExports(content: string, node: FileNode) {
    const importRegex = /import\s+.*?from\s+['"](.*?)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        node.imports.push(match[1]);
    }
    
    const exportRegex = /export\s+(?:default\s+)?(?:const|let|var|class|interface|type|function)\s+([a-zA-Z0-9_]+)/g;
    while ((match = exportRegex.exec(content)) !== null) {
        node.exports.push(match[1]);
    }
}

/**
 * 🛡️ THE FALLBACK: Just in case the LSP isn't ready.
 */
function extractStructureRegex(content: string, node: FileNode) {
    const classRegex = /class\s+([a-zA-Z0-9_]+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
        if (!node.classes.includes(match[1])) node.classes.push(match[1]);
    }
    const funcRegex = /(?:async\s+)?function\s+([a-zA-Z0-9_]+)|const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;
    while ((match = funcRegex.exec(content)) !== null) {
        const funcName = match[1] || match[2];
        if (funcName && !node.functions.includes(funcName)) node.functions.push(funcName);
    }
}

/**
 * 📊 THE VISUALIZER EXPORT: Feeds the WebGL Engine.
 */
export function getGraphJSON(): Record<string, FileNode> {
    const graphObj: Record<string, FileNode> = {};
    for (const [key, value] of workspaceGraph.entries()) {
        graphObj[key] = value;
    }
    return graphObj;
}