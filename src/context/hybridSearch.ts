// src/context/hybridSearch.ts
import * as vscode from 'vscode';
import { globalVectorDB } from './vectorDB'; // 🔥 Bypass the markdown formatter and hit the DB directly
import { getSmartASTContext } from './codeGraph';
import { log } from '../logger';

export interface SearchResult {
    filepath: string;
    content: string;
    score: number;
}

/**
 * 🔍 PILLAR 1: Lexical Search (Keyword Matching)
 * Uses VS Code's native text search engine for exact symbol matches.
 */
async function performLexicalSearch(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    const keywords = query.split(' ').filter(w => w.length > 4);
    if (keywords.length === 0) { return []; }

    const primaryKeyword = keywords[0]!.toLowerCase(); // length > 0 just checked above
    
    const excludePattern = '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/.vscode/**}';
    const files = await vscode.workspace.findFiles('**/*', excludePattern, 1000); 
    
    let matchCount = 0;
    for (const fileUri of files) {
        if (matchCount >= maxResults) { break; }
        
        try {
            if (fileUri.fsPath.match(/\.(png|jpg|jpeg|gif|ico|svg|mp4|webm|wasm|exe|dll)$/i)) continue;

            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(fileData);
            
            if (content.toLowerCase().includes(primaryKeyword)) {
                const lines = content.split('\n');
                const matchLineIndex = lines.findIndex(line => line.toLowerCase().includes(primaryKeyword));
                
                const startLine = Math.max(0, matchLineIndex - 5);
                const endLine = Math.min(lines.length - 1, matchLineIndex + 5);
                const chunk = lines.slice(startLine, endLine + 1).join('\n');

                results.push({
                    filepath: vscode.workspace.asRelativePath(fileUri),
                    content: chunk.trim(),
                    score: 1 
                });
                matchCount++;
            }
        } catch (e) {
            // Silently ignore locked files
        }
    }

    return results;
}

/**
 * 🧠 PILLAR 2: Vector Search (Semantic Dense Embeddings)
 * Hits the in-memory Cosine Similarity Database.
 */
async function performVectorSearch(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    try {
        // 🔥 THE FIX: Query the raw chunk data directly from the Vector DB
        const vectorHits = await globalVectorDB.search(query, maxResults);
        
        vectorHits.forEach((hit) => {
            results.push({
                filepath: hit.filepath,
                content: hit.content.trim(),
                score: hit.score // Raw cosine similarity score
            });
        });
    } catch (e) {
        log.error("[DEBUG-RAG] Dense Vector search failed:", e);
    }
    return results;
}

/**
 * 🧬 THE FUSION: Tri-Factor Context Injection via RRF
 * Combines Lexical RRF, Semantic Vectors, and AST Logic.
 */
export async function retrieveHybridContext(
    query: string,
    topK: number = 5,
    /** P1.3: forwarded to the inner getSmartASTContext call. Steering
     *  authors who want to suppress legacy/generated paths configure
     *  these in `## Exclude paths` sections of their steering files;
     *  SidebarProvider loads them via SteeringManager.getExcludePatterns()
     *  and passes them here. Empty = no filter (legacy behavior). */
    excludePatterns: ReadonlyArray<string> = []
): Promise<string> {
    log.debug("[DEBUG-RAG] 🔍 Starting Tri-Factor Hybrid Search...");

    try {
        const astPromise = Promise.resolve(getSmartASTContext(query, { excludePatterns })).catch((e: any) => {
            log.warn("[DEBUG-RAG] AST CodeGraph search failed silently:", e);
            return "";
        });

        const [lexicalResults, vectorResults, astContext]: [SearchResult[], SearchResult[], string] = await Promise.all([
            performLexicalSearch(query).catch(() => [] as SearchResult[]),
            performVectorSearch(query).catch(() => [] as SearchResult[]),
            astPromise
        ]);

        // 🔥 THE RRF MATHEMATICS ENGINE
        // We use a Set for content to deduplicate overlapping chunks found by both algorithms!
        interface RRFNode {
            score: number;
            chunks: Set<string>;
        }
        
        const rrfScores = new Map<string, RRFNode>();
        const K = 60; // Industry standard smoothing constant

        // 1. Process Lexical Ranks
        lexicalResults.forEach((result: SearchResult, index: number) => {
            const rank = index + 1;
            const node = rrfScores.get(result.filepath) || { score: 0, chunks: new Set<string>() };
            node.score += (1 / (K + rank));
            node.chunks.add(result.content);
            rrfScores.set(result.filepath, node);
        });

        // 2. Process Vector Ranks
        vectorResults.forEach((result: SearchResult, index: number) => {
            const rank = index + 1;
            const node = rrfScores.get(result.filepath) || { score: 0, chunks: new Set<string>() };
            node.score += (1 / (K + rank));
            node.chunks.add(result.content);
            rrfScores.set(result.filepath, node);
        });

        // 3. Sort by highest combined RRF score and take top K
        const fusedResults = Array.from(rrfScores.entries())
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, topK);

        let contextPayload = "=== HYBRID SEARCH RESULTS (Lexical + Vector) ===\n";
        
        if (fusedResults.length === 0) {
            log.debug("[DEBUG-RAG] ⚠️ Hybrid Search found no chunks. Relying purely on AST.");
            contextPayload += "No direct file chunks found.\n";
        } else {
            fusedResults.forEach(([filepath, data]) => {
                const combinedChunks = Array.from(data.chunks).join('\n...\n');
                contextPayload += `\n📍 File: ${filepath} (RRF Score: ${data.score.toFixed(4)})\n\`\`\`\n${combinedChunks}\n\`\`\`\n`;
            });
            log.info(`[DEBUG-RAG] ✅ Fused ${fusedResults.length} highly relevant documents.`);
        }

        if (astContext) {
            contextPayload += `\n=== STRUCTURAL AST CONTEXT ===\n${astContext}\n`;
        }

        return contextPayload;

    } catch (criticalError: unknown) {
        log.error("[DEBUG-RAG] 💥 CRITICAL HYBRID SEARCH FAILURE:", criticalError);
        return "";
    }
}