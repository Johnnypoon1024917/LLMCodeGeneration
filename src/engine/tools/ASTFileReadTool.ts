// src/engine/tools/ASTFileReadTool.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolResult } from '../types';

// Architectural Bypass: We dynamically require the module and cast it to 'any'.
// This prevents TS2709, TS2339, and TS2351 while preserving runtime execution.
const Parser: any = require('web-tree-sitter');

export class ASTFileReadTool {
    // We type the class property as 'any' to match the dynamic import
    private parser: any = null;

    constructor(private workspaceRoot: string) {}

    async init() {
        await Parser.init();
        this.parser = new Parser();
        const lang = await Parser.Language.load(
            // Ensure this points accurately to your WASM binary
            path.join(__dirname, '../../../parser/tree-sitter-typescript.wasm') 
        );
        this.parser.setLanguage(lang);
    }

    async readSymbol(filePath: string, symbolName: string): Promise<ToolResult> {
        if (!this.parser) await this.init();

        const fullPath = path.resolve(this.workspaceRoot, filePath);
        const fileContent = await fs.readFile(fullPath, 'utf8');
        
        const tree = this.parser.parse(fileContent);
        
        const query = this.parser.getLanguage().query(`
            (function_declaration name: (identifier) @name (#eq? @name "${symbolName}")) @target
            (class_declaration name: (identifier) @name (#eq? @name "${symbolName}")) @target
            (method_definition name: (property_identifier) @name (#eq? @name "${symbolName}")) @target
        `);

        const matches = query.matches(tree.rootNode);

        if (matches.length === 0) {
            return {
                success: false,
                output: `Symbol '${symbolName}' not found in ${filePath}.`
            };
        }

        const targetNode = matches[0].captures.find((c: any) => c.name === 'target')?.node;
        
        return {
            success: true,
            output: `// File: ${filePath}\n${targetNode?.text}`
        };
    }

    async readFullFile(filePath: string): Promise<ToolResult> {
        const fullPath = path.resolve(this.workspaceRoot, filePath);
        const fileContent = await fs.readFile(fullPath, 'utf8');
        return { success: true, output: fileContent };
    }
}