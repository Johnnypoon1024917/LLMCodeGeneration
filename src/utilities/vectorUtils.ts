// src/utilities/vectorUtils.ts
import * as vscode from 'vscode';

// Standard OpenAI-compatible embeddings payload
export async function getEmbedding(text: string): Promise<number[]> {
    const config = vscode.workspace.getConfiguration('nexuscode');
    const baseEndpoint = config.get<string>('apiEndpoint') || 'http://127.0.0.1:1234/v1/chat/completions';
    
    // Convert /chat/completions to /embeddings
    const embeddingEndpoint = baseEndpoint.replace('/chat/completions', '/embeddings');
    const apiKey = config.get<string>('apiKey') || 'lm-studio';

    const response = await fetch(embeddingEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            input: text,
            model: "nomic-embed-text" // Standard local embedding model, or use "text-embedding-3-small" for OpenAI
        })
    });

    const data = await response.json() as any;
    if (data.error) throw new Error(data.error.message);
    
    return data.data[0].embedding;
}

// Calculate Cosine Similarity between two vectors
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}