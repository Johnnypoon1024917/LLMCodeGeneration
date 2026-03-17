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
exports.getInjectionPosition = getInjectionPosition;
// src/utilities/symbolManager.ts
const vscode = __importStar(require("vscode"));
const Parser = __importStar(require("web-tree-sitter"));
// FIX: Use 'any' type for the instance variable to avoid namespace-as-type errors
let parser;
/**
 * Initializes the parser and loads the language-specific WASM grammar.
 */
async function initParser(extensionUri, languageId) {
    if (!parser) {
        // FIX: Cast to 'any' to access .init() and the constructor safely
        await Parser.init();
        parser = new Parser();
    }
    const wasmMapping = {
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
    }
    catch (e) {
        console.error(`[AST] Failed to load WASM for ${languageId}:`, e);
    }
}
/**
 * Parses the document AST and returns the exact coordinate to stream injected code.
 */
async function getInjectionPosition(extensionUri, document, symbolName) {
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
        // FIX: Explicitly type 'c' as 'any' to prevent implicit-any errors
        const target = captures.find((c) => c.node.text === symbolName);
        if (!target) {
            console.warn(`[AST] Target symbol '${symbolName}' not found in file.`);
            return null;
        }
        // Find the block/body child of the matched node (where the actual code goes)
        // FIX: Explicitly type 'n' as 'any'
        const bodyNode = (target.node.parent?.children || []).find((n) => n.type === 'class_body' || n.type === 'statement_block' || n.type === 'block');
        if (!bodyNode || !bodyNode.lastChild)
            return null;
        // The last child of a block is typically the closing '}'
        const closingBrace = bodyNode.lastChild;
        // Return the position immediately BEFORE the closing brace
        return document.positionAt(closingBrace.startIndex);
    }
    catch (error) {
        console.error("[AST Error] Failed to calculate injection position:", error);
        return null;
    }
}
//# sourceMappingURL=symbolManager.js.map