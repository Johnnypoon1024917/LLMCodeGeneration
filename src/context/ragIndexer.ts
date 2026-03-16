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

    try {
        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query: query })
        });

        if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
        }

        const data = await response.json() as any;
        
        // Defensive parsing: adjust based on your server's exact JSON response structure
        const resultsArray = data.results || data.data || data.hits || (Array.isArray(data) ? data : []);
        
        if (!resultsArray || resultsArray.length === 0) {
            return "No relevant context found in external Vector DB.";
        }

        let contextStr = "--- RETRIEVED VECTOR CONTEXT (HYBRID SEARCH) ---\n\n";
        
        // Map over the top 4 results
        for (const chunk of resultsArray.slice(0, 4)) {
            // Adjust 'filepath' and 'content' below to match your server's exact JSON keys
            const filepath = chunk.filepath || chunk.file || chunk.metadata?.filepath || "Unknown File";
            const content = chunk.content || chunk.text || chunk.snippet || JSON.stringify(chunk);
            
            contextStr += `📍 File: ${filepath}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }

        return contextStr;
    } catch (error) {
        console.error("[Hybrid Search] Failed to retrieve context:", error);
        return "Failed to retrieve RAG context from external server.";
    }
}