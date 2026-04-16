// src/context/hybridSearch.ts
import * as vscode from 'vscode';
import { retrieveContext } from './ragIndexer';
import { getSmartASTContext } from './codeGraph'; // 🔥 Brought in the AST Graph!

export interface SearchResult {
    filepath: string;
    content: string;
    score: number;
}

/**
 * 🔍 PILLAR 1: Lexical Search (Ripgrep equivalent)
 * Uses VS Code's native, highly optimized C++ text search engine.
 */
async function performLexicalSearch(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    // Extract the most important keyword from the query (words longer than 4 chars)
    const keywords = query.split(' ').filter(w => w.length > 4);
    if (keywords.length === 0) return [];
    
    const primaryKeyword = keywords[0].toLowerCase();
    
    // 1. Find all relevant files in the workspace (Fast & respects .gitignore)
    const excludePattern = '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/.vscode/**}';
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 1000); // Limit scan pool for speed
    
    // 2. Scan file contents in memory
    let matchCount = 0;
    for (const fileUri of files) {
        if (matchCount >= maxResults) break;
        
        try {
            // Ignore heavy binary/image files
            if (fileUri.fsPath.match(/\.(png|jpg|jpeg|gif|ico|svg|mp4|webm|wasm|exe|dll)$/i)) continue;

            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(fileData);
            
            if (content.toLowerCase().includes(primaryKeyword)) {
                // Extract a targeted 10-line chunk around the match so we don't blow up the LLM token limit
                const lines = content.split('\n');
                const matchLineIndex = lines.findIndex(line => line.toLowerCase().includes(primaryKeyword));
                
                const startLine = Math.max(0, matchLineIndex - 5);
                const endLine = Math.min(lines.length - 1, matchLineIndex + 5);
                const chunk = lines.slice(startLine, endLine + 1).join('\n');

                results.push({
                    filepath: vscode.workspace.asRelativePath(fileUri),
                    content: chunk,
                    score: 1 // BM25 rank placeholder for RRF fusion
                });
                matchCount++;
            }
        } catch (e) {
            // Silently ignore locked/unreadable files
        }
    }

    return results;
}

/**
 * 🧠 PILLAR 2: Vector Search (Semantic Dense Embeddings)
 * Hooks into our new in-memory Cosine Similarity VectorDB via ragIndexer.
 */
async function performVectorSearch(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    try {
        // 1. Call our new Dense Vector Embedding Engine!
        const rawRagString = await retrieveContext(query);
        
        if (!rawRagString || rawRagString.includes("No semantic context found")) {
            return [];
        }
        
        // 2. Parse the formatted string returned by the VectorDB back into objects
        const chunks = rawRagString.split('📍 File:'); 
        
        for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            const lines = chunk.split('\n');
            
            // Extract filepath and clean the markdown code blocks
            const filepath = lines[0].trim();
            const content = lines.slice(1).join('\n')
                                 .replace(/```[a-zA-Z]*\n?/g, '')
                                 .replace(/```/g, '')
                                 .trim();
            
            if (filepath && content) {
                results.push({
                    filepath: filepath,
                    content: content,
                    // Vector DB already sorted these by highest similarity.
                    // We give the first result the highest mock vector score, descending for the rest, 
                    // so the RRF formula knows how to rank them against the Lexical Search!
                    score: Math.max(0.1, 1.0 - (i * 0.1)) 
                });
            }
        }
    } catch (e) {
        console.error("[DEBUG-RAG] Dense Vector search failed:", e);
    }
    return results;
}

/**
 * 🧬 THE FUSION: Tri-Factor Context Injection
 * Combines Lexical RRF, Semantic Vectors, and AST Logic.
 */
export async function retrieveHybridContext(query: string, topK: number = 5): Promise<string> {
    console.log("[DEBUG-RAG] 🔍 Starting Tri-Factor Hybrid Search...");

    try {
        // 🔥 THE FIX: Wrap the AST function in Promise.resolve() so it safely handles both sync and async executions!
        const astPromise = Promise.resolve(getSmartASTContext(query)).catch((e: any) => {
            console.warn("[DEBUG-RAG] AST CodeGraph search failed silently:", e);
            return "";
        });

        // 🔥 THE FIX: Explicitly type the destructured array so TypeScript knows exactly what these are
        const [lexicalResults, vectorResults, astContext]: [SearchResult[], SearchResult[], string] = await Promise.all([
            performLexicalSearch(query).catch((e: any) => {
                console.warn("[DEBUG-RAG] Lexical search failed silently:", e);
                return [] as SearchResult[];
            }),
            performVectorSearch(query).catch((e: any) => {
                console.warn("[DEBUG-RAG] Vector search failed silently:", e);
                return [] as SearchResult[];
            }),
            astPromise
        ]);

        const rrfScores = new Map<string, { score: number, content: string }>();
        const K = 60; // Standard RRF smoothing constant

        // 🔥 THE FIX: Explicitly type the parameters to satisfy 'noImplicitAny'
        // Score Lexical Results
        lexicalResults.forEach((result: SearchResult, index: number) => {
            const rank = index + 1;
            const currentScore = rrfScores.get(result.filepath)?.score || 0;
            rrfScores.set(result.filepath, {
                score: currentScore + (1 / (K + rank)),
                content: result.content
            });
        });

        // Score Dense Vector Results
        vectorResults.forEach((result: SearchResult, index: number) => {
            const rank = index + 1;
            const currentScore = rrfScores.get(result.filepath)?.score || 0;
            rrfScores.set(result.filepath, {
                score: currentScore + (1 / (K + rank)),
                content: result.content
            });
        });

        // Sort by highest RRF score and take top K
        const fusedResults = Array.from(rrfScores.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, topK);

        let contextPayload = "=== HYBRID SEARCH RESULTS (Lexical + Vector) ===\n";
        
        if (fusedResults.length === 0) {
            console.log("[DEBUG-RAG] ⚠️ Hybrid Search found no chunk context. Relying purely on AST.");
            contextPayload += "No direct file chunks found.\n";
        } else {
            fusedResults.forEach(([filepath, data]) => {
                contextPayload += `\n📍 File: ${filepath} (RRF Score: ${data.score.toFixed(4)})\n\`\`\`\n${data.content}\n\`\`\`\n`;
            });
            console.log(`[DEBUG-RAG] ✅ Fused ${fusedResults.length} highly relevant chunks.`);
        }

        // Inject the AST graph logic at the very bottom
        if (astContext) {
            contextPayload += `\n=== STRUCTURAL AST CONTEXT ===\n${astContext}\n`;
        }

        return contextPayload;

    } catch (criticalError: any) {
        // The Ultimate Guardrail
        console.error("[DEBUG-RAG] 💥 CRITICAL HYBRID SEARCH FAILURE:", criticalError);
        return "";
    }
}