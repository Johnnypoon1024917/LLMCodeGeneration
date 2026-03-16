// src/utilities/symbolManager.ts
import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';

let parser: Parser;

/**
 * Initializes the parser and loads the language-specific WASM grammar.
 */
async function initParser(extensionUri: vscode.Uri, languageId: string) {
    if (!parser) {
        await Parser.init();
        parser = new Parser();
    }

    const wasmMapping: Record<string, string> = {
        'typescript': 'tree-sitter-typescript.wasm',
        'typescriptreact': 'tree-sitter-tsx.wasm',
        'html': 'tree-sitter-html.wasm',
        'python': 'tree-sitter-python.wasm',
        'javascript': 'tree-sitter-javascript.wasm'
    };

    const wasmFile = wasmMapping[languageId] || 'tree-sitter-typescript.wasm';
    const wasmPath = vscode.Uri.joinPath(extensionUri, 'parsers', wasmFile).fsPath;

    try {
        const lang = await Parser.Language.load(wasmPath);
        parser.setLanguage(lang);
    } catch (e) {
        console.error(`[AST] Failed to load WASM for ${languageId}:`, e);
    }
}

/**
 * Parses the document AST and returns the exact coordinate to stream injected code.
 */
export async function getInjectionPosition(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    symbolName: string
): Promise<vscode.Position | null> {
    try {
        await initParser(extensionUri, document.languageId);
        const tree = parser.parse(document.getText());

        // AST Query to find the symbol name regardless of class or function type
        const query = parser.getLanguage().query(`
            [
                (class_declaration name: (type_identifier) @name)
                (function_declaration name: (identifier) @name)
                (method_definition name: (property_identifier) @name)
                (variable_declarator name: (identifier) @name value: (arrow_function))
            ] @match
        `);

        const captures = query.captures(tree.rootNode);
        const target = captures.find(c => c.node.text === symbolName);

        if (!target) {
            console.warn(`[AST] Target symbol '${symbolName}' not found in file.`);
            return null;
        }

        // Find the block/body child of the matched node (where the actual code goes)
        const bodyNode = target.node.parent?.children.find(n => 
            n.type === 'class_body' || n.type === 'statement_block' || n.type === 'block'
        );

        if (!bodyNode || !bodyNode.lastChild) return null;

        // The last child of a block is typically the closing '}'
        const closingBrace = bodyNode.lastChild;
        
        // Return the position immediately BEFORE the closing brace
        return document.positionAt(closingBrace.startIndex);

    } catch (error) {
        console.error("[AST Error] Failed to calculate injection position:", error);
        return null;
    }
}