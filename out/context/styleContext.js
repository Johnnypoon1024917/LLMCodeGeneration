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
exports.getProjectStyleGuides = getProjectStyleGuides;
// src/context/styleContext.ts
const vscode = __importStar(require("vscode"));
async function getProjectStyleGuides() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders)
        return "";
    const rootUri = workspaceFolders[0].uri;
    // We look for any of these standard architecture rule files
    const targetFiles = ['.nexusrules', 'architecture.md', '.cursorrules'];
    let styleContext = "";
    for (const filename of targetFiles) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, filename);
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(fileData).trim();
            if (content) {
                // 🛡️ Enterprise Guardrail: Truncate massive files to save LLM tokens and prevent context-window crashes
                const safeContent = content.length > 8000 ? content.substring(0, 8000) + "\n...[TRUNCATED]" : content;
                styleContext += `\n--- 🏛️ PROJECT DIRECTIVE: ${filename} ---\n${safeContent}\n`;
            }
        }
        catch (e) {
            // File doesn't exist, which is totally normal. Silently continue.
        }
    }
    // If we found rules, we wrap them in a highly aggressive, undeniable prompt wrapper
    if (styleContext) {
        return `\n\n CRITICAL ARCHITECTURE & STYLE RULES \nYou MUST strictly follow these project-specific rules when writing or modifying code. Disobeying these rules is a critical failure:\n${styleContext}`;
    }
    return "";
}
//# sourceMappingURL=styleContext.js.map