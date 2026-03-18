// src/context/ragIndexer.ts
import * as vscode from 'vscode';

/**
 * Since we are using an external Enterprise Hybrid Search Server,
 * local workspace indexing inside VS Code is no longer required!
 */
export async function indexWorkspace(statusCallback: (msg: string) => void) {
    statusCallback("Nexus: Connected to external Hybrid Search server.");
}

/**
 * Queries the external Hybrid Search server for relevant codebase context.
 */
export async function retrieveContext(query: string): Promise<string> {
    const searchEndpoint = 'http://192.168.192.125:7001/search/hybrid';

    // 1. Get the name of the current open project to use as a potential filter
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentRepoName = workspaceFolders ? workspaceFolders[0].name : "unknown";

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                query: query,
                // If your python backend supports it, you can pass the repo name to filter!
                filters: { repo: currentRepoName } 
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const data = await response.json() as any;
        const resultsArray = data.results || [];
        
        if (!resultsArray || resultsArray.length === 0) return "";

        let contextStr = "--- RETRIEVED VECTOR CONTEXT (HYBRID SEARCH) ---\n\n";
        let validChunks = 0;

        for (const chunk of resultsArray) {
            // 🔥 ENTERPRISE FIX 1: The Confidence Cutoff
            // Your JSON shows bad results have scores around 0.2 - 0.5. 
            // We strictly drop anything below 0.65.
            const score = chunk.score || 0; 
            if (score < 0.65) {
                console.log(`[RAG] Dropped irrelevant file (${chunk.repo}) due to low score: ${score}`);
                continue; 
            }

            // 🔥 ENTERPRISE FIX 2: Safely map your exact JSON schema
            // We use file_path first, fallback to repo, fallback to file_url
            const filepath = chunk.file_path || chunk.repo || chunk.file_url || "Unknown File";
            const content = chunk.content || "";
            
            contextStr += `📍 File: ${filepath} (Confidence: ${score.toFixed(2)})\n\`\`\`\n${content}\n\`\`\`\n\n`;
            validChunks++;
        }

        // If all 4 results were garbage (like the JSON you showed), we return an EMPTY string 
        // so the LLM relies entirely on the local Workspace Tree instead!
        return validChunks > 0 ? contextStr : ""; 

    } catch (error) {
        console.warn("[Hybrid Search] External RAG Server offline or timeout. Proceeding with local context only.");
        return ""; 
    }
}