// src/context/LightweightVectorStore.ts
import * as fs from 'fs/promises';
import * as path from 'path';

export interface VectorRecord {
    id: string;
    filePath: string;
    text: string;
    embedding: number[];
}

export class VectorStore {
    private records: VectorRecord[] = [];

    constructor(private dbPath: string) {}

    async init() {
        try {
            // Attempt to load existing vectors from disk
            const data = await fs.readFile(this.dbPath, 'utf8');
            this.records = JSON.parse(data);
        } catch {
            // DB doesn't exist yet, start fresh
            this.records = [];
        }
    }

    async insert(record: VectorRecord) {
        // Remove existing chunks for this file to prevent duplicates on re-index
        this.records = this.records.filter(r => r.filePath !== record.filePath);
        this.records.push(record);
        await this.persist();
    }

    private async persist() {
        try {
            await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
            await fs.writeFile(this.dbPath, JSON.stringify(this.records), 'utf8');
        } catch (error) {
            console.error("Failed to persist vector DB:", error);
        }
    }

    async search(queryEmbedding: number[], limit: number = 5): Promise<VectorRecord[]> {
        if (this.records.length === 0) return [];

        // Calculate Cosine Similarity for all records
        const scored = this.records.map(record => ({
            ...record,
            score: this.cosineSimilarity(queryEmbedding, record.embedding)
        }));

        // Sort by highest match and take the top results
        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Mathematical Cosine Similarity Engine
     * Inventive Step: Pure JS matrix calculation, avoiding native bindings.
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
}