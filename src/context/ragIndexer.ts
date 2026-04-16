// src/context/ragIndexer.ts
import * as vscode from 'vscode';
import { globalVectorDB } from './vectorDB';

/**
 * Sweeps the entire workspace, chunks the code, and builds the dense vector matrix.
 */
export async function indexWorkspace(onProgress: (msg: string) => void): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    onProgress("🧠 Initializing Dense Vector Embedding Matrix...");
    globalVectorDB.clear();

    const files = await vscode.workspace.findFiles(
        '**/*.{ts,js,py,go,rs,md,txt}', 
        '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 
        100 // Cap at 100 files to prevent API rate limits during dev
    );

    let count = 0;
    for (const file of files) {
        try {
            const data = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(data).toString('utf8');
            const relativePath = vscode.workspace.asRelativePath(file);
            
            await globalVectorDB.addDocument(relativePath, content);
            
            count++;
            if (count % 10 === 0) {
                onProgress(`🧠 Vectorizing workspace... (${count}/${files.length} files)`);
            }
        } catch (e) {
            // Silently skip unreadable files
        }
    }
    
    onProgress(`✅ Vector Indexing Complete. Matrix contains ${count} files.`);
}

/**
 * Converts the user's prompt into a geometric vector and searches the matrix.
 */
export async function retrieveContext(query: string, maxResults: number = 5): Promise<string> {
    const results = await globalVectorDB.search(query, maxResults);
    
    if (results.length === 0) return "No semantic context found.";

    let contextStr = "--- RELEVANT SEMANTIC CODE CHUNKS ---\n";
    
    // Group chunks by file to make it readable for the AI
    const groupedByFile = new Map<string, string[]>();
    
    for (const res of results) {
        if (!groupedByFile.has(res.filepath)) {
            groupedByFile.set(res.filepath, []);
        }
        groupedByFile.get(res.filepath)?.push(res.content);
    }

    for (const [filepath, chunks] of groupedByFile.entries()) {
        contextStr += `\n📍 File: ${filepath}\n`;
        chunks.forEach(c => contextStr += `\`\`\`\n${c}\n\`\`\`\n`);
    }

    return contextStr;
}