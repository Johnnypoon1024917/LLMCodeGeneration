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
// 🧮 VECTOR SPACE MATH ENGINE (TF-IDF + Stemming)
// ============================================================================
//
// V2.1.2 spec-fix-4 upgrade. The old engine was term-frequency cosine —
// "bag of words" with no document-rarity weighting. That's the simplest
// thing that "works" but has known failure modes:
//
//   - Common words ("user", "data", "service") dominate every comparison
//   - Inflectional variants ("authenticate" vs "authentication") miss
//   - Threshold 0.05 catches noise; 0.15 (the comment's stated bar) was
//     never actually achievable because TF cosine of two short strings
//     rarely passes 0.10 even when the strings are clearly related
//
// TF-IDF weights tokens by inverse document frequency: words that appear
// in every doc get near-zero weight (they discriminate nothing); words
// that appear in 1-2 docs get high weight (strong signal). Combined with
// a light suffix-stripping stemmer, this collapses "authenticate" /
// "authentication" / "authenticated" to the same stem so requirements
// phrased in noun form match files written in verb form.
//
// This is still bag-of-words — it doesn't understand semantic meaning
// (e.g. "passport" being related to "auth"). For that we'd need real
// embeddings; the v2.8 code intelligence rebuild is the place for that.
// TF-IDF is the appropriate quick win for v1: ~1 day of work, modest
// quality bump, zero new dependencies.

/**
 * Light suffix-stripping stemmer. Not full Porter — Porter is ~150
 * lines and produces aggressive stems that aren't always intuitive
 * ("relativity" → "rel"). This handles the common English inflections
 * that matter for code/PRD matching: plural nouns, gerunds, past
 * tense, and the noun→verb shift for "-ation"/"-ize" pairs.
 *
 * Order matters — longer suffixes first, otherwise "authentication"
 * would strip "ion" before "ation" gets a chance.
 */
function stem(word: string): string {
    if (word.length < 4) { return word; }
    const suffixes = [
        'ization', 'ational', 'tional', 'ation', 'iness', 'ingly',
        'edly', 'ements', 'ement', 'ously', 'ably', 'ibly',
        'ate',                             // V2.1.2 spec-fix-4: collapse "authenticate" + "authentication" → "authentic"
        'ions', 'ing', 'ies', 'ied', 'ed', 'es', 'ly', 's'
    ];
    for (const suf of suffixes) {
        if (word.endsWith(suf) && word.length - suf.length >= 3) {
            return word.slice(0, -suf.length);
        }
    }
    return word;
}

/**
 * Tokenize text into stemmed terms. Splits CamelCase, lowercases, drops
 * stopwords, applies stemmer. Returns an array (not a Map) because the
 * caller may need the raw counts for TF computation.
 */
function tokenize(text: string): string[] {
    if (typeof text !== 'string' || text.length === 0) { return []; }
    const spacedText = text.replace(/([a-z])([A-Z])/g, '$1 $2');
    const words = spacedText.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    const stopWords = new Set([
        'the', 'and', 'for', 'with', 'this', 'that', 'from', 'src',
        'epic', 'story', 'task', 'criteria', 'has', 'have', 'can',
        'will', 'must', 'should', 'shall', 'may', 'are', 'was', 'were',
    ]);

    const out: string[] = [];
    for (const w of words) {
        if (stopWords.has(w)) { continue; }
        out.push(stem(w));
    }
    return out;
}

/**
 * Build a term-frequency map (term → count) from a tokenized array.
 */
function termFreq(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    return tf;
}

/**
 * TF-IDF similarity engine. Construct with the full corpus of texts
 * being compared; the IDF is computed once at construction and reused
 * for every similarity() call. This matches the standard IR pattern
 * (Lucene, scikit-learn, etc.) and is significantly faster than the
 * old per-comparison vectorize-and-cosine when N is large.
 */
export class TfIdfSimilarity {
    private idf: Map<string, number> = new Map();
    private docVectors: Map<string, Map<string, number>> = new Map();

    /**
     * Build IDF from a corpus. `docs` is a map from doc-id to raw text.
     * IDF for term t = ln((N + 1) / (df(t) + 1)) + 1 — the smoothed
     * variant used by scikit-learn, avoids zero IDF for terms appearing
     * in every document and avoids division by zero for terms missing
     * from all documents.
     */
    constructor(docs: Map<string, string>) {
        const docCount = docs.size;
        if (docCount === 0) { return; }

        // Pass 1: tokenize each doc and count document frequencies
        const docTokens = new Map<string, string[]>();
        const df = new Map<string, number>();
        for (const [id, text] of docs.entries()) {
            const tokens = tokenize(text);
            docTokens.set(id, tokens);
            // Each unique term in this doc contributes 1 to its document frequency
            const seen = new Set<string>();
            for (const t of tokens) {
                if (!seen.has(t)) {
                    seen.add(t);
                    df.set(t, (df.get(t) ?? 0) + 1);
                }
            }
        }

        // Pass 2: compute IDF per term (smoothed)
        for (const [term, freq] of df.entries()) {
            this.idf.set(term, Math.log((docCount + 1) / (freq + 1)) + 1);
        }

        // Pass 3: build per-doc TF-IDF vectors
        for (const [id, tokens] of docTokens.entries()) {
            const tf = termFreq(tokens);
            const vec = new Map<string, number>();
            for (const [term, count] of tf.entries()) {
                const idfWeight = this.idf.get(term) ?? 0;
                vec.set(term, count * idfWeight);
            }
            this.docVectors.set(id, vec);
        }
    }

    /**
     * Cosine similarity between two doc-ids in the corpus. Returns 0 if
     * either id wasn't in the corpus.
     */
    similarity(idA: string, idB: string): number {
        const a = this.docVectors.get(idA);
        const b = this.docVectors.get(idB);
        if (!a || !b) { return 0; }

        let dot = 0;
        for (const [term, weightA] of a.entries()) {
            const weightB = b.get(term);
            if (weightB !== undefined) { dot += weightA * weightB; }
        }

        let magA = 0;
        for (const w of a.values()) { magA += w * w; }
        let magB = 0;
        for (const w of b.values()) { magB += w * w; }

        if (magA === 0 || magB === 0) { return 0; }
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }

    /**
     * Compute similarity between an arbitrary text (not in corpus) and
     * a corpus doc. The query text is tokenized and weighted using the
     * pre-computed IDF. Returns 0 if the query has no overlapping terms
     * or if the target id isn't in the corpus.
     */
    queryAgainst(queryText: string, targetId: string): number {
        const target = this.docVectors.get(targetId);
        if (!target) { return 0; }
        const tokens = tokenize(queryText);
        if (tokens.length === 0) { return 0; }

        const tf = termFreq(tokens);
        const queryVec = new Map<string, number>();
        for (const [term, count] of tf.entries()) {
            const idfWeight = this.idf.get(term) ?? 0;
            queryVec.set(term, count * idfWeight);
        }

        let dot = 0;
        for (const [term, weightQ] of queryVec.entries()) {
            const weightT = target.get(term);
            if (weightT !== undefined) { dot += weightQ * weightT; }
        }

        let magQ = 0;
        for (const w of queryVec.values()) { magQ += w * w; }
        let magT = 0;
        for (const w of target.values()) { magT += w * w; }

        if (magQ === 0 || magT === 0) { return 0; }
        return dot / (Math.sqrt(magQ) * Math.sqrt(magT));
    }
}

// ============================================================================
// 🧠 GRAPH PARSERS
// ============================================================================

export async function parseRequirementGraph(prdContent: string): Promise<GraphData> {
    if (!prdContent) { return { nodes: [], edges: [] }; }
    const currentHash = hashString(prdContent);
    if (cachedReqGraph && cachedPrdHash === currentHash) { return cachedReqGraph; }

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
            // V2.2 hotfix-3: excludeReasoning strips Qwen's <think>
            // reasoning trace from the response before we parse JSON.
            // Without this, "Here's a thinking process: ... \n\n
            // {\"nodes\":...}" arrives — the leading prose breaks the
            // JSON parser, even after ```json fence stripping. Same
            // root cause as spec-fix-15 (chat completion path) but for
            // this graph-generation code path that wasn't migrated.
            { temperature: 0.1, excludeReasoning: true }
        );

        // V2.2 hotfix-3: defensive JSON extraction. Belt-and-braces
        // beyond the excludeReasoning flag — if reasoning slips through
        // (e.g., the model prefixes prose before the JSON without using
        // the <think> tag), strip everything before the first '{' so
        // the parser doesn't trip. The trailing slice mirrors this for
        // post-JSON commentary.
        let jsonStr = fullText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace > 0 && lastBrace > firstBrace) {
            jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
        }
        const graphData = safeParseJSON<GraphData>(jsonStr);

        if (!graphData.nodes) { graphData.nodes = []; }
        if (!graphData.edges) { graphData.edges = []; }

        cachedPrdHash = currentHash;
        cachedReqGraph = graphData;
        return graphData;
    } catch (e: unknown) {
        log.error(`[DEBUG-MAP] 🔴 PRD Graph Error:`, errorMessage(e));
        return { nodes: [], edges: [] };
    }
}

export async function parseDesignGraph(designContent: string): Promise<GraphData> {
    if (!designContent) { return { nodes: [], edges: [] }; }
    const currentHash = hashString(designContent);
    if (cachedDesignGraph && cachedDesignHash === currentHash) { return cachedDesignGraph; }

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
            // V2.2 hotfix-3: see parseRequirementGraph above for rationale.
            { temperature: 0.1, excludeReasoning: true }
        );

        // V2.2 hotfix-3: defensive JSON extraction (same pattern as
        // parseRequirementGraph above).
        let jsonStr = fullText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace > 0 && lastBrace > firstBrace) {
            jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
        }
        const graphData = safeParseJSON<GraphData>(jsonStr);

        if (!graphData.nodes) { graphData.nodes = []; }
        if (!graphData.edges) { graphData.edges = []; }

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
    //
    // V2.1.2 spec-fix-5: handle multi-feature task IDs correctly.
    // Previously tasks were keyed on `Task: <first 20 chars>...` which
    // collided across features with similar task names (e.g. two features
    // both starting with "Implement API Fetch Wrapper..."). Add a counter
    // suffix so each task gets a unique node id even when names collide.
    //
    // Also fix the task→epic edge: relatedRequirement now contains the
    // slug prefix (e.g. 'checkout-flow::EPIC-04'), and the substring
    // search against epic labels was matching '[checkout-flow] EPIC-04'
    // which contains the prefix differently. Switch to exact-id match
    // first, fall back to substring only if exact fails.
    if (tasksJson && Array.isArray(tasksJson.implementationTasks)) {
        let taskCounter = 0;
        for (const task of tasksJson.implementationTasks) {
            if (task.step) {
                taskCounter++;
                const slug = task._featureSlug ? `${task._featureSlug}::` : '';
                const taskId = `Task ${taskCounter}: ${slug}${task.step.substring(0, 40)}...`;
                const taskLabel = task._featureSlug
                    ? `[${task._featureSlug}] ${task.step}`
                    : task.step;
                combinedNodes.push({ id: taskId, label: taskLabel, group: 'task', val: 7 });

                if (task.file) {
                    const fileNode = combinedNodes.find(n => n.id.includes(task.file));
                    if (fileNode) { combinedEdges.push({ source: taskId, target: fileNode.id, color: 'rgba(51, 154, 240, 0.9)' }); }
                }

                if (task.relatedRequirement) {
                    // First: exact match on the prefixed ID. Most robust.
                    let epicNode = combinedNodes.find(n =>
                        (n.group === 'epic' || n.group === 'story') &&
                        n.id === task.relatedRequirement
                    );
                    // Fallback: relaxed substring match. Strips the 'Epic: '
                    // prefix that older task formats added, and ignores the
                    // feature-slug prefix from the new format.
                    if (!epicNode) {
                        const reqName = String(task.relatedRequirement)
                            .replace(/^.+::/, '')   // strip slug prefix
                            .replace(/^Epic:\s*/, '')   // strip 'Epic:' prefix
                            .trim();
                        epicNode = combinedNodes.find(n =>
                            n.group === 'epic' &&
                            (n.label.includes(reqName) || n.id.includes(reqName))
                        );
                    }
                    if (epicNode) {
                        combinedEdges.push({ source: epicNode.id, target: taskId, color: 'rgba(245, 66, 141, 0.8)' });
                    }
                }
            }
        }
    }

    // 2. PROBABILISTIC SEMANTIC BRIDGING (TF-IDF Vector Mathematics)
    //
    // V2.1.2 spec-fix-4: upgraded from TF-cosine to TF-IDF + stemming.
    // The corpus we feed the engine is "every req node text + every
    // code file path text" so the IDF reflects this specific project's
    // vocabulary. Words that show up in many files (e.g. 'service',
    // 'util') get down-weighted; words that show up in 1-2 files
    // (e.g. 'checkout', 'banner') become strong discriminators.
    //
    // Threshold 0.10: with TF-IDF this is closer to the original spirit
    // of "highly significant overlap." The old 0.05 in TF-cosine was
    // catching too many false positives because common words inflated
    // every comparison.
    const reqNodes = reqGraph.nodes.filter(n => n.group === 'epic' || n.group === 'story');
    const codeNodes = codeGraph.nodes.filter(n => n.group === 'file');

    if (reqNodes.length > 0 && codeNodes.length > 0) {
        // Build corpus: doc-id → text. Use 'req::<id>' / 'code::<path>'
        // as doc-ids to avoid collisions if a req-id happens to match
        // a file path string.
        const corpus = new Map<string, string>();
        for (const req of reqNodes) {
            corpus.set(`req::${req.id}`, `${req.id} ${req.label}`);
        }
        for (const code of codeNodes) {
            corpus.set(`code::${code.id}`, code.id.replace(/\//g, ' ').replace(/\./g, ' '));
        }

        const tfidf = new TfIdfSimilarity(corpus);
        const SEMANTIC_THRESHOLD = 0.10;

        for (const req of reqNodes) {
            for (const code of codeNodes) {
                const similarity = tfidf.similarity(`req::${req.id}`, `code::${code.id}`);

                if (similarity >= SEMANTIC_THRESHOLD) {
                    const alreadyLinked = combinedEdges.some(e => e.source === req.id && e.target === code.id);

                    if (!alreadyLinked) {
                        combinedEdges.push({
                            source: req.id,
                            target: code.id,
                            isSemantic: true,
                            weight: similarity,
                            color: 'rgba(255, 165, 0, 0.7)' // 🟠 Orange for probabilistic links
                        });
                    }
                }
            }
        }
    }

    return { nodes: combinedNodes, edges: combinedEdges };
}