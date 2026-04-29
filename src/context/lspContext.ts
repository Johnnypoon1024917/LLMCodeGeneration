// src/context/lspContext.ts
import * as vscode from 'vscode';
import { log } from '../logger';

export async function getLspContext(taskDescription: string): Promise<string> {
    // 1. Extract potential symbol names (CamelCase, PascalCase, snake_case)
    const potentialSymbols = taskDescription.match(/\b[A-Za-z][A-Za-z0-9_]+\b/g) || [];
    
    // Filter out common stopwords (e.g., "Update", "Create", "Context") to save performance
    const uniqueSymbols = [...new Set(potentialSymbols)].filter(w => w.length > 4);

    let contextParts: string[] = [];

    for (const symbol of uniqueSymbols.slice(0, 5)) { // Limit to top 5 to avoid token overflow
        // 2. Ask VS Code: "Where is this symbol defined?"
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', 
            symbol
        );

        if (symbols && symbols.length > 0) {
            // Take the best match (usually the first one)
            const bestMatch = symbols[0]!; // length > 0 guarded above
            
            // 3. Read the file content at the definition location
            try {
                const doc = await vscode.workspace.openTextDocument(bestMatch.location.uri);
                const range = bestMatch.location.range;
                
                // Expand range slightly to capture JSDocs/Decorators above the definition
                const startLine = Math.max(0, range.start.line - 3);
                const endLine = Math.min(doc.lineCount - 1, range.end.line + 10); // Capture first 10 lines of body
                const expandedRange = new vscode.Range(startLine, 0, endLine, 0);
                
                const codeSnippet = doc.getText(expandedRange);
                contextParts.push(`Symbol '${symbol}' defined in ${vscode.workspace.asRelativePath(bestMatch.location.uri)}:\n\`\`\`typescript\n${codeSnippet}\n...\n\`\`\``);
            } catch (e) {
                log.warn(`Failed to read symbol ${symbol}`, e);
            }
        }
    }

    if (contextParts.length === 0) return "";

    return `\n\n[LSP CONTEXT - AUTO DETECTED DEFINITIONS]\nThe user mentioned these symbols. Use their exact signatures:\n${contextParts.join('\n')}\n`;
}