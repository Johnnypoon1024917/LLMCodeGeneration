"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalVectorDB = exports.VectorDatabase = void 0;
// src/context/vectorDB.ts
const llmService_1 = require("../llmService");
const logger_1 = require("../logger");
class VectorDatabase {
    chunks = [];
    /**
     * Calls the standard v1/embeddings endpoint (OpenAI, LM Studio, Ollama)
     */
    async getEmbedding(text) {
        const { endpoint, apiKey } = await (0, llmService_1.getLLMConfig)();
        // Convert chat endpoint to embeddings endpoint
        const embedEndpoint = endpoint.replace('/chat/completions', '/embeddings');
        try {
            const response = await fetch(embedEndpoint, {
                method: 'POST',
                headers: (0, llmService_1.authHeaders)(apiKey),
                body: JSON.stringify({
                    model: "text-embedding-nomic-embed-text", // Standard local fallback, or text-embedding-3-small
                    input: text.replace(/\n/g, ' ') // Embeddings work better without hard linebreaks
                })
            });
            if (!response.ok)
                throw new Error(`Embedding API failed: ${response.statusText}`);
            const data = await response.json();
            return data.data[0].embedding;
        }
        catch (e) {
            logger_1.log.warn("⚠️ Vector DB Failed to fetch embedding. Ensure your LLM provider supports the /v1/embeddings endpoint.", e);
            return [];
        }
    }
    /**
     * Computes the mathematical Cosine Similarity between two vectors.
     * 1.0 means identical, 0.0 means completely unrelated.
     */
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(vecA.length, vecB.length);
        for (let i = 0; i < len; i++) {
            const a = vecA[i];
            const b = vecB[i];
            dotProduct += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0)
            return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    /**
     * Ingests a file, chunks it, and stores the mathematical representation.
     */
    async addDocument(filepath, content) {
        // Simple chunking: Split by double newlines to keep functions/classes mostly intact
        const rawChunks = content.split(/\n\s*\n/);
        for (const chunk of rawChunks) {
            if (chunk.trim().length < 50)
                continue; // Skip tiny fragments
            const embedding = await this.getEmbedding(chunk);
            if (embedding.length > 0) {
                this.chunks.push({ filepath, content: chunk, embedding });
            }
        }
    }
    /**
     * Performs a K-Nearest Neighbors (KNN) search across the high-dimensional space.
     */
    async search(query, topK = 5) {
        if (this.chunks.length === 0)
            return [];
        const queryEmbedding = await this.getEmbedding(query);
        if (queryEmbedding.length === 0)
            return [];
        // Score every chunk in the DB against the query
        const scoredChunks = this.chunks.map(chunk => ({
            ...chunk,
            score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
        }));
        // Sort by highest similarity and return the top K results
        scoredChunks.sort((a, b) => b.score - a.score);
        return scoredChunks.slice(0, topK);
    }
    clear() {
        this.chunks = [];
    }
}
exports.VectorDatabase = VectorDatabase;
// Export a global singleton instance
exports.globalVectorDB = new VectorDatabase();
//# sourceMappingURL=vectorDB.js.map