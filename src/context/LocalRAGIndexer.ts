// src/context/LocalRAGIndexer.ts
import { VectorStore, VectorRecord } from './LightweightVectorStore'; 
import * as fs from 'fs/promises';

export class AirGappedRAG {
    private embedder: any = null;
    private db: VectorStore;

    constructor(workspaceRoot: string) {
        this.db = new VectorStore(`${workspaceRoot}/.nexuscode/vectors.json`);
    }

    async init() {
        // ARCHITECTURAL BYPASS: Dynamically import the ESM module into our CJS context
        const transformers = await import('@xenova/transformers');
        const pipeline = transformers.pipeline;

        this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        await this.db.init();
    }

    async indexWorkspace(files: string[]) {
        for (const file of files) {
            const content = await fs.readFile(file, 'utf8');
            const chunks = this.chunkByAST(content, file); 

            for (const chunk of chunks) {
                const vector = await this.embedder(chunk.text, { pooling: 'mean', normalize: true });
                
                await this.db.insert({
                    id: chunk.id,
                    filePath: file,
                    embedding: Array.from(vector.data),
                    text: chunk.text
                });
            }
        }
    }

    async semanticSearch(userQuery: string, limit: number = 5): Promise<string> {
        if (!this.embedder) await this.init();

        const queryVector = await this.embedder(userQuery, { pooling: 'mean', normalize: true });
        const results = await this.db.search(Array.from(queryVector.data), limit);
        
        return results.map((r: VectorRecord) => `// Source: ${r.filePath}\n${r.text}`).join('\n\n');
    }
    
    private chunkByAST(content: string, filepath: string): any[] {
        const rawChunks = content.split('\n\n').filter(c => c.trim().length > 20);
        return rawChunks.map((text, i) => ({
            id: `${filepath}-chunk-${i}`,
            text: text.trim()
        }));
    }
}