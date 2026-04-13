import * as vscode from 'vscode';
import * as path from 'path';
import { ASTParser } from '../utilities/astParser';

export interface FileNode {
    filepath: string;
    imports: string[];
    exports: string[];
    classes: string[];
    functions: string[];
    interfaces: string[];
    variables: string[];
}

let workspaceGraph = new Map<string, FileNode>();

export interface ScoredNode {
    filepath: string;
    score: number;
    reasons: string[];
    node: FileNode;
}

/**
 * Parses file content and adds it to the workspace graph using AST
 */
export async function addFileToGraph(filepath: string, content: string) {
    // 🚀 NEW: AST Parsing replaces Regex completely
    const symbols = ASTParser.extractSymbols(content);

    const node: FileNode = {
        filepath,
        imports: symbols.imports,
        exports: symbols.exports,
        classes: symbols.classes,
        functions: symbols.functions,
        interfaces: symbols.interfaces,
        variables: symbols.variables
    };

    workspaceGraph.set(filepath, node);
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
        let reasons: string[] = [];

        // 1. Direct Dependency (File imports Target)
        if (node.imports.some(imp => imp.includes(path.basename(cleanTarget)))) {
            score += 40;
            reasons.push('⬇️ Imports Target');
        }

        // 2. Shared Dependencies (Both files import the same module)
        const sharedImports = node.imports.filter(imp => targetNode.imports.includes(imp));
        if (sharedImports.length > 0) {
            score += (sharedImports.length * 5); // 5 points per shared import
            reasons.push(`🔗 Shared imports (${sharedImports.length})`);
        }

        // 3. Shared Terminology/Symbols
        // AST ensures these are exact symbol matches, not just substring overlaps!
        const sharedClasses = node.classes.filter(c => targetNode.classes.includes(c));
        const sharedInterfaces = node.interfaces.filter(i => targetNode.interfaces.includes(i));
        
        if (sharedClasses.length > 0 || sharedInterfaces.length > 0) {
            score += 20;
            reasons.push('🧬 Shares Data Structures');
        }

        if (score > 0) {
            results.push({ filepath, score, reasons, node });
        }
    }

    // Sort by highest correlation score
    return results.sort((a, b) => b.score - a.score);
}

/**
 * Builds the initial workspace graph by scanning the project
 */
export async function buildWorkspaceGraph(rootUri?: vscode.Uri) {
    // If a rootUri is provided, scope the search to that folder. Otherwise, search everywhere.
    const searchPattern = rootUri ? new vscode.RelativePattern(rootUri, '**/*.{ts,tsx,js,jsx}') : '**/*.{ts,tsx,js,jsx}';
    
    const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**');
    
    for (const file of files) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            await addFileToGraph(file.fsPath, doc.getText());
        } catch (e) {
            console.warn(`Failed to parse ${file.fsPath} for GraphRAG`);
        }
    }
}

/**
 * Returns the graph as a JSON string for the Webview UI
 */
export function getGraphJSON(): string {
    const obj: Record<string, FileNode> = {};
    for (const [key, value] of workspaceGraph.entries()) {
        obj[key] = value;
    }
    return JSON.stringify(obj);
}

/**
 * Gets the most relevant context for a target query
 */
export function getSmartASTContext(query: string): string {
    const correlatedNodes = calculateGraphCorrelation(query);
    
    // 🔥 THE FIX: Inject the [Score:] prefix so SidebarProvider.ts can parse it for the UI!
    return correlatedNodes.slice(0, 5).map(c => 
        `[Score: ${c.score}] 📍 ${c.filepath} (${c.reasons.join(', ')})\nExports: ${c.node.exports.join(', ')}\nClasses: ${c.node.classes.join(', ')}\nFunctions: ${c.node.functions.join(', ')}`
    ).join('\n\n');
}