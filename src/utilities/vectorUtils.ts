// src/utilities/vectorUtils.ts
import { getLLMConfig, authHeaders } from '../llmService';

// Standard OpenAI-compatible embeddings payload
export async function getEmbedding(text: string): Promise<number[]> {
    // Delegate to the central config — never read apiKey from plain settings
    const { endpoint: baseEndpoint, apiKey } = await getLLMConfig();

    // Convert /chat/completions to /embeddings
    const embeddingEndpoint = baseEndpoint.replace('/chat/completions', '/embeddings');

    const response = await fetch(embeddingEndpoint, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
            input: text,
            model: "nomic-embed-text"
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
    const len = Math.min(vecA.length, vecB.length); // bounds-check once for the hot loop
    for (let i = 0; i < len; i++) {
        const a = vecA[i]!; // bounded by len above
        const b = vecB[i]!; // bounded by len above
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}