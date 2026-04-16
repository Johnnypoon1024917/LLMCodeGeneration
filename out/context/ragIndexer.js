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
const vectorDB_1 = require("./vectorDB");
/**
 * Sweeps the entire workspace, chunks the code, and builds the dense vector matrix.
 */
async function indexWorkspace(onProgress) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders)
        return;
    onProgress("🧠 Initializing Dense Vector Embedding Matrix...");
    vectorDB_1.globalVectorDB.clear();
    const files = await vscode.workspace.findFiles('**/*.{ts,js,py,go,rs,md,txt}', '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 100 // Cap at 100 files to prevent API rate limits during dev
    );
    let count = 0;
    for (const file of files) {
        try {
            const data = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(data).toString('utf8');
            const relativePath = vscode.workspace.asRelativePath(file);
            await vectorDB_1.globalVectorDB.addDocument(relativePath, content);
            count++;
            if (count % 10 === 0) {
                onProgress(`🧠 Vectorizing workspace... (${count}/${files.length} files)`);
            }
        }
        catch (e) {
            // Silently skip unreadable files
        }
    }
    onProgress(`✅ Vector Indexing Complete. Matrix contains ${count} files.`);
}
/**
 * Converts the user's prompt into a geometric vector and searches the matrix.
 */
async function retrieveContext(query, maxResults = 5) {
    const results = await vectorDB_1.globalVectorDB.search(query, maxResults);
    if (results.length === 0)
        return "No semantic context found.";
    let contextStr = "--- RELEVANT SEMANTIC CODE CHUNKS ---\n";
    // Group chunks by file to make it readable for the AI
    const groupedByFile = new Map();
    for (const res of results) {
        if (!groupedByFile.has(res.filepath)) {
            groupedByFile.set(res.filepath, []);
        }
        groupedByFile.get(res.filepath)?.push(res.content);
    }
    for (const [filepath, chunks] of groupedByFile.entries()) {
        contextStr += `\n📍 File: ${filepath}\n`;
        chunks.forEach(c => contextStr += `\`\`\`\n${c}\n\`\`\`\n`);
    }
    return contextStr;
}
//# sourceMappingURL=ragIndexer.js.map