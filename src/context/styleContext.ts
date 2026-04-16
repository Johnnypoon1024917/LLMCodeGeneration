// src/context/styleContext.ts
import * as vscode from 'vscode';

export async function getProjectStyleGuides(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return "";

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
        } catch (e) {
            // File doesn't exist, which is totally normal. Silently continue.
        }
    }

    // If we found rules, we wrap them in a highly aggressive, undeniable prompt wrapper
    if (styleContext) {
        return `\n\n CRITICAL ARCHITECTURE & STYLE RULES \nYou MUST strictly follow these project-specific rules when writing or modifying code. Disobeying these rules is a critical failure:\n${styleContext}`;
    }

    return "";
}