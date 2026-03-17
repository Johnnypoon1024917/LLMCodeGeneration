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
exports.getLspContext = getLspContext;
// src/context/lspContext.ts
const vscode = __importStar(require("vscode"));
async function getLspContext(taskDescription) {
    // 1. Extract potential symbol names (CamelCase, PascalCase, snake_case)
    const potentialSymbols = taskDescription.match(/\b[A-Za-z][A-Za-z0-9_]+\b/g) || [];
    // Filter out common stopwords (e.g., "Update", "Create", "Context") to save performance
    const uniqueSymbols = [...new Set(potentialSymbols)].filter(w => w.length > 4);
    let contextParts = [];
    for (const symbol of uniqueSymbols.slice(0, 5)) { // Limit to top 5 to avoid token overflow
        // 2. Ask VS Code: "Where is this symbol defined?"
        const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', symbol);
        if (symbols && symbols.length > 0) {
            // Take the best match (usually the first one)
            const bestMatch = symbols[0];
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
            }
            catch (e) {
                console.warn(`Failed to read symbol ${symbol}`, e);
            }
        }
    }
    if (contextParts.length === 0)
        return "";
    return `\n\n[LSP CONTEXT - AUTO DETECTED DEFINITIONS]\nThe user mentioned these symbols. Use their exact signatures:\n${contextParts.join('\n')}\n`;
}
//# sourceMappingURL=lspContext.js.map