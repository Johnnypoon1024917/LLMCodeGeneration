import * as vscode from 'vscode';
import * as path from 'path';

// Use require to bypass the namespace/type resolution errors
const Parser = require('web-tree-sitter');

export class ASTParser {
    private static parser: any = null;
    private static isInitialized = false;

    public static async init(context: vscode.ExtensionContext) {
        if (this.isInitialized) return;

        try {
            await Parser.init();
            this.parser = new Parser();
            
            const wasmPath = path.join(context.extensionPath, 'parser', 'tree-sitter-tsx.wasm');
            const lang = await Parser.Language.load(wasmPath);
            
            this.parser.setLanguage(lang);
            this.isInitialized = true;
            console.log("AST Parser initialized successfully.");
        } catch (error) {
            console.error("Failed to initialize Tree-Sitter:", error);
        }
    }

    public static extractSymbols(content: string): {
        imports: string[], exports: string[], classes: string[], 
        functions: string[], interfaces: string[], variables: string[]
    } {
        const result = {
            imports: [] as string[], exports: [] as string[], classes: [] as string[],
            functions: [] as string[], interfaces: [] as string[], variables: [] as string[]
        };

        if (!this.parser || !this.isInitialized) return result;

        try {
            const tree = this.parser.parse(content);
            this.walkTreeSafe(tree.rootNode, result);
        } catch (e) {
            console.error("[GraphRAG] Critical error parsing AST content", e);
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

    // 🔥 THE FIX: Iterative Stack traversal. No more Call Stack Exceeded, no more aborted files!
    private static walkTreeSafe(rootNode: any, result: any) {
        const stack = [rootNode];

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;

            // Safely push children to the stack to continue traversing downward
            if (node.children && Array.isArray(node.children)) {
                for (let i = node.children.length - 1; i >= 0; i--) {
                    stack.push(node.children[i]);
                }
            }

            if (node.type === 'comment') continue;

            try {
                switch (node.type) {
                    case 'import_statement': {
                        const source = node.children?.find((c: any) => c.type === 'string');
                        if (source) result.imports.push(source.text.replace(/['"`]/g, ''));
                        break;
                    }
                    case 'export_statement': {
                        const children = node.children || [];
                        for (const child of children) {
                            if (child.type === 'class_declaration' || child.type === 'function_declaration' || child.type === 'interface_declaration' || child.type === 'type_alias_declaration') {
                                const idNode = child.children?.find((c: any) => c.type === 'identifier' || c.type === 'type_identifier');
                                if (idNode) result.exports.push(idNode.text);
                            } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
                                // 🔥 FIX: Grab ALL variables exported in a single line (e.g., export const x = 1, y = 2)
                                const varDecls = child.children?.filter((c: any) => c.type === 'variable_declarator') || [];
                                varDecls.forEach((varDecl: any) => {
                                    const idNode = varDecl.children?.find((c: any) => c.type === 'identifier');
                                    if (idNode) result.exports.push(idNode.text);
                                });
                            } else if (child.type === 'export_clause') {
                                // 🔥 FIX: Grab destructured exports (e.g., export { A, B })
                                child.children?.forEach((c: any) => {
                                    if (c.type === 'export_specifier') {
                                        const idNode = c.children?.find((cc: any) => cc.type === 'identifier');
                                        if (idNode) result.exports.push(idNode.text);
                                    }
                                });
                            }
                        }
                        break;
                    }
                    case 'class_declaration': {
                        const className = node.children?.find((c: any) => c.type === 'type_identifier' || c.type === 'identifier');
                        if (className) result.classes.push(className.text);
                        break;
                    }
                    case 'function_declaration':
                    case 'method_definition': {
                        const funcName = node.children?.find((c: any) => c.type === 'property_identifier' || c.type === 'identifier');
                        if (funcName) result.functions.push(funcName.text);
                        break;
                    }
                    case 'interface_declaration':
                    case 'type_alias_declaration': {
                        const intName = node.children?.find((c: any) => c.type === 'type_identifier');
                        if (intName) result.interfaces.push(intName.text);
                        break;
                    }
                    case 'variable_declarator': {
                        const varName = node.children?.find((c: any) => c.type === 'identifier');
                        const isArrow = node.children?.some((c: any) => c.type === 'arrow_function');
                        if (varName) {
                            if (isArrow) result.functions.push(varName.text);
                            else result.variables.push(varName.text);
                        }
                        break;
                    }
                }
            } catch (e) {
                // 🔥 THE SHIELD: If a weird JSX node throws an error, we silently ignore it 
                // and keep processing the rest of the stack! The file parse survives.
            }
        }
    }
}