// src/agents/exploreAgent.ts
import * as vscode from 'vscode';

export async function runExplorerAgent(task: string, workspaceRoot: string, log: (msg: string) => void): Promise<string> {
    log("🕵️‍♂️ Explorer Agent: Hunting for context...");
    
    let gatheredContext = "";
    
    try {
        // Extract key terms from the task to grep for (words > 4 chars)
        const keywords = task.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').filter(w => w.length > 4);
        const searchPattern = keywords.length > 0 ? keywords[0] : "export";

        log(`🕵️‍♂️ Explorer Agent: Running dynamic grep for '${searchPattern}'...`);
        
        const files = await vscode.workspace.findFiles(
            '**/*.{ts,tsx,js,jsx,py,go,rs,java,md}', 
            '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**}', 
            15 // Strict cap to prevent LLM token bloat
        );

        const regex = new RegExp(searchPattern, 'i');
        let matchCount = 0;

        for (const file of files) {
            if (matchCount >= 15) break;
            try {
                const fileData = await vscode.workspace.fs.readFile(file);
                const content = Buffer.from(fileData).toString('utf8');
                
                // Only include the file if it actually contains the keyword
                if (regex.test(content)) {
                    const relativePath = vscode.workspace.asRelativePath(file);
                    gatheredContext += `\n--- 📄 ${relativePath} ---\n\`\`\`\n${content.substring(0, 3000)}\n\`\`\`\n`;
                    matchCount++;
                }
            } catch (err) {
                // Silently skip unreadable files
            }
        }
        
        if (!gatheredContext) {
            gatheredContext = "No specific files found matching the keywords. Proceeding with general knowledge.";
        }
        
        log(`🕵️‍♂️ Explorer Agent: Context gathered from ${matchCount} files.`);
        return gatheredContext;
    } catch (e) {
        log("🕵️‍♂️ Explorer Agent: Search failed.");
        return "Search failed.";
    }
}