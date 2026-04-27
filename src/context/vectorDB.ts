// src/context/vectorDB.ts
import * as vscode from 'vscode';
import { getLLMConfig, authHeaders} from '../llmService';

export interface DocumentChunk {
    filepath: string;
    content: string;
    embedding: number[];
}

// 🚀 ADD THIS: Create a type specifically for search results
export interface ScoredChunk extends DocumentChunk {
    score: number;
}

export class VectorDatabase {
    private chunks: DocumentChunk[] = [];

    /**
     * Calls the standard v1/embeddings endpoint (OpenAI, LM Studio, Ollama)
     */
    private async getEmbedding(text: string): Promise<number[]> {
        const { endpoint, apiKey } = await getLLMConfig();
        
        // Convert chat endpoint to embeddings endpoint
        const embedEndpoint = endpoint.replace('/chat/completions', '/embeddings');

        try {
            const response = await fetch(embedEndpoint, {
                method: 'POST',
                headers: authHeaders(apiKey),
                body: JSON.stringify({
                    model: "text-embedding-nomic-embed-text", // Standard local fallback, or text-embedding-3-small
                    input: text.replace(/\n/g, ' ') // Embeddings work better without hard linebreaks
                })
            });

            if (!response.ok) throw new Error(`Embedding API failed: ${response.statusText}`);
            
            const data = await response.json() as any;
            return data.data[0].embedding;
        } catch (e) {
            console.warn("⚠️ Vector DB Failed to fetch embedding. Ensure your LLM provider supports the /v1/embeddings endpoint.", e);
            return [];
        }
    }

    /**
     * Computes the mathematical Cosine Similarity between two vectors.
     * 1.0 means identical, 0.0 means completely unrelated.
     */
    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Ingests a file, chunks it, and stores the mathematical representation.
     */
    public async addDocument(filepath: string, content: string) {
        // Simple chunking: Split by double newlines to keep functions/classes mostly intact
        const rawChunks = content.split(/\n\s*\n/);
        
        for (const chunk of rawChunks) {
            if (chunk.trim().length < 50) continue; // Skip tiny fragments
            
            const embedding = await this.getEmbedding(chunk);
            if (embedding.length > 0) {
                this.chunks.push({ filepath, content: chunk, embedding });
            }
        }
    }

    /**
     * Performs a K-Nearest Neighbors (KNN) search across the high-dimensional space.
     */
    public async search(query: string, topK: number = 5): Promise<ScoredChunk[]> {
        if (this.chunks.length === 0) return [];

        const queryEmbedding = await this.getEmbedding(query);
        if (queryEmbedding.length === 0) return [];

        // Score every chunk in the DB against the query
        const scoredChunks = this.chunks.map(chunk => ({
            ...chunk,
            score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
        }));

        // Sort by highest similarity and return the top K results
        scoredChunks.sort((a, b) => b.score - a.score);
        return scoredChunks.slice(0, topK);
    }

    public clear() {
        this.chunks = [];
    }
}

// Export a global singleton instance
export const globalVectorDB = new VectorDatabase();