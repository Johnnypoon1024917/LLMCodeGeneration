"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.indexWorkspace = indexWorkspace;
exports.retrieveContext = retrieveContext;
// src/context/ragIndexer.ts
const vscode = __importStar(require("vscode"));
/**
 * Since we are using an external Enterprise Hybrid Search Server,
 * local workspace indexing inside VS Code is no longer required!
 */
async function indexWorkspace(statusCallback) {
    statusCallback("Nexus: Connected to external Hybrid Search server.");
}
/**
 * Queries the external Hybrid Search server for relevant codebase context.
 */
async function retrieveContext(query) {
    const searchEndpoint = 'http://192.168.192.125:7001/search/hybrid';
    // 1. Get the name of the current open project to use as a potential filter
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const currentRepoName = workspaceFolders ? workspaceFolders[0].name : "unknown";
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(searchEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: query,
                // If your python backend supports it, you can pass the repo name to filter!
                filters: { repo: currentRepoName }
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok)
            throw new Error(`Server responded with status: ${response.status}`);
        const data = await response.json();
        const resultsArray = data.results || [];
        if (!resultsArray || resultsArray.length === 0)
            return "";
        let contextStr = "--- RETRIEVED VECTOR CONTEXT (HYBRID SEARCH) ---\n\n";
        let validChunks = 0;
        for (const chunk of resultsArray) {
            // 🔥 ENTERPRISE FIX 1: The Confidence Cutoff
            // Your JSON shows bad results have scores around 0.2 - 0.5. 
            // We strictly drop anything below 0.65.
            const score = chunk.score || 0;
            if (score < 0.65) {
                console.log(`[RAG] Dropped irrelevant file (${chunk.repo}) due to low score: ${score}`);
                continue;
            }
            // 🔥 ENTERPRISE FIX 2: Safely map your exact JSON schema
            // We use file_path first, fallback to repo, fallback to file_url
            const filepath = chunk.file_path || chunk.repo || chunk.file_url || "Unknown File";
            const content = chunk.content || "";
            contextStr += `📍 File: ${filepath} (Confidence: ${score.toFixed(2)})\n\`\`\`\n${content}\n\`\`\`\n\n`;
            validChunks++;
        }
        // If all 4 results were garbage (like the JSON you showed), we return an EMPTY string 
        // so the LLM relies entirely on the local Workspace Tree instead!
        return validChunks > 0 ? contextStr : "";
    }
    catch (error) {
        console.warn("[Hybrid Search] External RAG Server offline or timeout. Proceeding with local context only.");
        return "";
    }
}
//# sourceMappingURL=ragIndexer.js.map