import * as vscode from 'vscode';
import { log } from '../logger';

export class ASTParser {
    public static async init(_context: vscode.ExtensionContext) {
        //  We have stripped out the fragile WebAssembly Tree-Sitter dependency.
        // The AST Engine is now powered by a bulletproof, zero-dependency RegExp engine.
        log.info("AST Regex Engine initialized successfully.");
    }

    public static extractSymbols(content: string) {
        const result = {
            imports: [] as string[], exports: [] as string[], classes: [] as string[], 
            functions: [] as string[], interfaces: [] as string[], variables: [] as string[]
        };

        try {
            // Strip comments to avoid false positives
            const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

            // 1. Extract Imports
            const importRegex = /import\s+(?:\{[^}]+\}|\S+)\s+from\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = importRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.imports.push(match[1]);
            }

            // 2. Extract Classes
            const classRegex = /class\s+([a-zA-Z0-9_]+)/g;
            while ((match = classRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.classes.push(match[1]);
            }

            // 3. Extract Standard Functions
            const funcRegex = /function\s+([a-zA-Z0-9_]+)\s*\(/g;
            while ((match = funcRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.functions.push(match[1]);
            }

            // 4. Extract Arrow Functions
            const arrowRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;
            while ((match = arrowRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.functions.push(match[1]);
            }

            // 5. Extract Interfaces
            const intRegex = /interface\s+([a-zA-Z0-9_]+)/g;
            while ((match = intRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.interfaces.push(match[1]);
            }

            // 6. Extract Exports
            const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|default)\s+([a-zA-Z0-9_]+)?/g;
            while ((match = exportRegex.exec(cleanContent)) !== null) {
                if (match[1]) result.exports.push(match[1]);
            }
        } catch (e) {
            log.error("[AST Parser] Regex parsing failed", e);
        }

        return {
            imports: [...new Set(result.imports)],
            exports: [...new Set(result.exports)],
            classes: [...new Set(result.classes)],
            functions: [...new Set(result.functions)],
            interfaces: [...new Set(result.interfaces)],
            variables: [...new Set(result.variables)]
        };
    }
}