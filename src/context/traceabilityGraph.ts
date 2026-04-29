// src/context/traceabilityGraph.ts
import { getProvider } from '../llm';
import { safeParseJSON } from '../llmService';
import { errorMessage } from '../utilities/errors';
import { log } from '../logger';

export interface GraphNode { id: string; label: string; group: string; val?: number; }
export interface GraphEdge { source: string; target: string; color?: string; isSemantic?: boolean; weight?: number; }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

// In-memory caches
let cachedPrdHash = "";
let cachedReqGraph: GraphData | null = null;
let cachedDesignHash = "";
let cachedDesignGraph: GraphData | null = null;

function hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
    return hash.toString();
}

// ============================================================================
// 🧮 VECTOR SPACE MATH ENGINE (Cosine Similarity)
// ============================================================================

/**
 * Tokenizes text and converts it into a high-dimensional mathematical vector
 */
function vectorizeText(text: string): Map<string, number> {
    // 1. 🔥 FIX: Split CamelCase/PascalCase (e.g., "UserAuth" -> "User Auth")
    const spacedText = text.replace(/([a-z])([A-Z])/g, '$1 $2');
    
    // 2. 🔥 FIX: Extract alphanumeric words (2 chars or longer to catch 'ui', 'db', 'ts')
    const words = spacedText.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    const vector = new Map<string, number>();
    
    // 3. 🔥 FIX: Removed "user" from stopwords. Added generic code/PRD terms.
    const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'src', 'epic', 'story', 'task']);

    for (const w of words) {
        if (stopWords.has(w)) continue;
        vector.set(w, (vector.get(w) || 0) + 1);
    }
    return vector;
}

/**
 * Calculates the exact Cosine Similarity between two vectors (0.0 to 1.0)
 */
function calculateCosineSimilarity(textA: string, textB: string): number {
    const vecA = vectorizeText(textA);
    const vecB = vectorizeText(textB);

    let dotProduct = 0;
    for (const [word, countA] of vecA.entries()) {
        if (vecB.has(word)) {
            dotProduct += countA * vecB.get(word)!;
        }
    }

    let magnitudeA = 0;
    for (const count of vecA.values()) magnitudeA += count * count;

    let magnitudeB = 0;
    for (const count of vecB.values()) magnitudeB += count * count;

    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    
    // The Cosine Similarity Equation: (A • B) / (||A|| * ||B||)
    return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

// ============================================================================
// 🧠 GRAPH PARSERS
// ============================================================================

export async function parseRequirementGraph(prdContent: string): Promise<GraphData> {
    if (!prdContent) return { nodes: [], edges: [] };
    const currentHash = hashString(prdContent);
    if (cachedReqGraph && cachedPrdHash === currentHash) return cachedReqGraph;

    const systemPrompt = `You are a System Architecture Graphing Agent.
    Extract a strict Bipartite Graph of the Epics, Stories, and Acceptance Criteria.
    CRITICAL SCHEMA RULES:
    1. Use EXACTLY the keys "id", "label", and "group" for nodes. DO NOT use the word "type".
    2. The "group" MUST be exactly one of: "root", "epic", "story", "criteria".
    3. The "id" MUST be highly descriptive (e.g., "Epic: Authentication", "Story: User Login"). DO NOT use generic IDs like "E1" or "S1".
    Return ONLY valid JSON matching this schema:
    { "nodes": [ { "id": "PRD", "label": "Product Requirements", "group": "root" }, { "id": "Epic: Auth", "label": "Authentication", "group": "epic" } ], "edges": [ { "source": "PRD", "target": "Epic: Auth" } ] }`;

    try {
        // Migrated to Provider abstraction (Component 1, Session 2).
        // The hand-rolled SSE accumulator + safeParseJSON shape is
        // preserved — this function depends on legacy JSON healing for
        // tolerance to malformed model output. A future cleanup will
        // route this through `provider.jsonCompletion(messages, schema)`
        // once the graph schema is added to jsonSchemas.ts.
        const provider = await getProvider();
        const fullText = await provider.completion(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: prdContent }
            ],
            { temperature: 0.1 }
        );

        const jsonStr = fullText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const graphData = safeParseJSON<GraphData>(jsonStr);

        if (!graphData.nodes) graphData.nodes = [];
        if (!graphData.edges) graphData.edges = [];

        cachedPrdHash = currentHash;
        cachedReqGraph = graphData;
        return graphData;
    } catch (e: unknown) {
        log.error(`[DEBUG-MAP] 🔴 PRD Graph Error:`, errorMessage(e));
        return { nodes: [], edges: [] };
    }
}

export async function parseDesignGraph(designContent: string): Promise<GraphData> {
    if (!designContent) return { nodes: [], edges: [] };
    const currentHash = hashString(designContent);
    if (cachedDesignGraph && cachedDesignHash === currentHash) return cachedDesignGraph;

    const systemPrompt = `You are a System Architecture Graphing Agent.
    Read the System Design Document and extract a graph of the Architecture Components, Data Models, and API Routes.
    CRITICAL SCHEMA RULES:
    1. Use EXACTLY the keys "id", "label", and "group".
    2. The "group" MUST be exactly one of: "root", "model", "api", "component".
    Return ONLY valid JSON matching this schema:
    { "nodes": [ { "id": "Model: User", "label": "User Model", "group": "model" } ], "edges": [] }`;

    try {
        // Migrated to Provider abstraction (Component 1, Session 2).
        // Same shape as parseRequirementsGraph above.
        const provider = await getProvider();
        const fullText = await provider.completion(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: designContent }
            ],
            { temperature: 0.1 }
        );

        const jsonStr = fullText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const graphData = safeParseJSON<GraphData>(jsonStr);

        if (!graphData.nodes) graphData.nodes = [];
        if (!graphData.edges) graphData.edges = [];

        cachedDesignHash = currentHash;
        cachedDesignGraph = graphData;
        return graphData;
    } catch (e: unknown) {
        return { nodes: [], edges: [] };
    }
}

// ============================================================================
// 🌌 THE GRAND UNIFIED MATRIX (Hybrid Merger)
// ============================================================================

export function buildCombinedGraph(codeGraph: GraphData, reqGraph: GraphData, designGraph: GraphData, tasksJson: any): GraphData {
    const combinedNodes = [...codeGraph.nodes, ...reqGraph.nodes, ...designGraph.nodes];
    const combinedEdges = [...codeGraph.edges, ...reqGraph.edges, ...designGraph.edges];

    // 1. DETERMINISTIC BRIDGING (Hard links via tasks.json)
    if (tasksJson && Array.isArray(tasksJson.implementationTasks)) {
        for (const task of tasksJson.implementationTasks) {
            if (task.step) {
                const taskId = `Task: ${task.step.substring(0, 20)}...`;
                combinedNodes.push({ id: taskId, label: task.step, group: 'task', val: 7 });

                if (task.file) {
                    const fileNode = combinedNodes.find(n => n.id.includes(task.file));
                    if (fileNode) combinedEdges.push({ source: taskId, target: fileNode.id, color: 'rgba(51, 154, 240, 0.9)' });
                }
                
                if (task.relatedRequirement) {
                    const reqName = task.relatedRequirement.replace('Epic: ', '').trim();
                    const epicNode = combinedNodes.find(n => n.group === 'epic' && (n.label.includes(reqName) || n.id.includes(reqName)));
                    if (epicNode) combinedEdges.push({ source: epicNode.id, target: taskId, color: 'rgba(245, 66, 141, 0.8)' });
                }
            }
        }
    }

    // 2. PROBABILISTIC SEMANTIC BRIDGING (Vector Mathematics)
    const reqNodes = reqGraph.nodes.filter(n => n.group === 'epic' || n.group === 'story');
    const codeNodes = codeGraph.nodes.filter(n => n.group === 'file');

    // Because this is a localized Term Frequency vector space rather than a deep LLM embedding, 
    // a score of > 0.15 indicates highly significant semantic overlap.
    const SEMANTIC_THRESHOLD = 0.05; 

    for (const req of reqNodes) {
        for (const code of codeNodes) {
            // Calculate similarity between the Requirement ID/Label and the File Name
            const similarity = calculateCosineSimilarity(
                `${req.id} ${req.label}`, 
                code.id.replace(/\//g, ' ').replace(/\./g, ' ')
            );

            // If mathematically similar, draw a Probabilistic Edge!
            if (similarity >= SEMANTIC_THRESHOLD) {
                // Ensure we don't draw an edge if a deterministic Task already links them directly
                const alreadyLinked = combinedEdges.some(e => e.source === req.id && e.target === code.id);
                
                if (!alreadyLinked) {
                    combinedEdges.push({ 
                        source: req.id, 
                        target: code.id, 
                        isSemantic: true, // Flag it so the UI can render it dashed/orange
                        weight: similarity,
                        color: 'rgba(255, 165, 0, 0.7)' // 🟠 Orange color for probabilistic links
                    });
                }
            }
        }
    }

    return { nodes: combinedNodes, edges: combinedEdges };
}