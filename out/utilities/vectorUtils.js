"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEmbedding = getEmbedding;
exports.cosineSimilarity = cosineSimilarity;
// src/utilities/vectorUtils.ts
const llmService_1 = require("../llmService");
// Standard OpenAI-compatible embeddings payload
async function getEmbedding(text) {
    // Delegate to the central config — never read apiKey from plain settings
    const { endpoint: baseEndpoint, apiKey } = await (0, llmService_1.getLLMConfig)();
    // Convert /chat/completions to /embeddings
    const embeddingEndpoint = baseEndpoint.replace('/chat/completions', '/embeddings');
    const response = await fetch(embeddingEndpoint, {
        method: 'POST',
        headers: (0, llmService_1.authHeaders)(apiKey),
        body: JSON.stringify({
            input: text,
            model: "nomic-embed-text"
        })
    });
    const data = await response.json();
    if (data.error)
        throw new Error(data.error.message);
    return data.data[0].embedding;
}
// Calculate Cosine Similarity between two vectors
function cosineSimilarity(vecA, vecB) {
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
//# sourceMappingURL=vectorUtils.js.map