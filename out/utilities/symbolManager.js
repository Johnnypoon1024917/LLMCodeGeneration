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
exports.getInjectionPosition = getInjectionPosition;
// src/utilities/symbolManager.ts (REPLACEMENT)
const vscode = __importStar(require("vscode"));
async function getInjectionPosition(_extensionUri, document, symbolName) {
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    if (!symbols)
        return null;
    const target = findSymbol(symbols, symbolName);
    if (!target)
        return null;
    // Insert just before the closing brace of the symbol body
    const endLine = target.range.end.line;
    const lineText = document.lineAt(endLine).text;
    const closingBraceCol = lineText.indexOf('}');
    if (closingBraceCol === -1)
        return new vscode.Position(endLine, 0);
    return new vscode.Position(endLine, closingBraceCol);
}
function findSymbol(symbols, name) {
    for (const s of symbols) {
        if (s.name === name)
            return s;
        const child = findSymbol(s.children, name);
        if (child)
            return child;
    }
    return null;
}
//# sourceMappingURL=symbolManager.js.map