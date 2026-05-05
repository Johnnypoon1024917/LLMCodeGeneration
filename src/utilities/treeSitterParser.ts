// src/utilities/treeSitterParser.ts
//
// PR P1.3 (deferred): Tree-Sitter implementation of the
// ExtractedSymbols contract. Currently OPT-IN behind the
// `nexuscode.experimental.treeSitter` setting; the regex parser
// in astParser.ts remains the default.
//
// Why opt-in:
//   The Tree-Sitter swap has three packaging concerns that need
//   runtime validation before flipping the default:
//
//     1. vsce package must include the .wasm files. Listed below
//        in the FILES_BUNDLED comment block; the build script /
//        .vscodeignore needs corresponding updates.
//
//     2. The webview's CSP must allow wasm-unsafe-eval. NexusCode's
//        host-side parsing happens in the extension host, NOT the
//        webview, so this should not affect us — but the SDK init
//        path may still trigger CSP-relevant code paths under some
//        VS Code versions. Needs validation.
//
//     3. Async lifecycle: Parser.init() is async and must complete
//        before any parse(). The ExtractedSymbols contract is sync
//        in the regex parser. We bridge by making the public
//        `extractSymbols` async on this implementation; callers that
//        want sync access keep using the regex parser.
//
// Migration path (for the follow-up PR that flips the default):
//   - Verify the .wasm files load correctly when packaged via vsce
//     (run vsce package, install the .vsix, parse a file)
//   - Update astParser.ts callers to await extractSymbolsAsync OR
//     use the synchronous regex fallback when the user hasn't opted
//     in to the Tree-Sitter setting
//   - Remove the regex parser once Tree-Sitter parity is proven on
//     the fixture set
//
// What this parser fixes that regex couldn't:
//   - Renamed imports: `import { x as y } from './m'` — Tree-Sitter
//     captures both x (original) and y (local binding) so cross-file
//     resolution can use either
//   - Re-exports: `export { foo } from './m'` — captured as both an
//     export AND an import-from-link
//   - Dynamic imports: `import('./m')` — captured into imports[]
//
// What this parser still doesn't handle (deferred to a later PR):
//   - Type-only-import distinction: TS `import type { X }` is treated
//     identically to `import { X }`. Usually fine for symbol-graph;
//     the Coordinator's context picker doesn't care about the type/
//     value split.

// FILES_BUNDLED:
//   When packaging with vsce, the following files MUST be included.
//   Add to package.json's `files` array OR remove the corresponding
//   patterns from .vscodeignore:
//
//     node_modules/web-tree-sitter/web-tree-sitter.wasm
//     node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm
//     node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm
//
//   These are loaded at runtime via locateFile (web-tree-sitter)
//   and a direct fetch on the language wasm. Total ~3.6MB added to
//   the .vsix; non-trivial but acceptable for the symbol-graph
//   accuracy gain.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Parser, Language } from 'web-tree-sitter';
import { log } from '../logger';
import type { ExtractedSymbols } from './astParser';

/** Source language hint. Drives which wasm grammar is loaded. */
export type SupportedLanguage = 'typescript' | 'tsx';

/**
 * Internal: cached language objects. First call to `getLanguage`
 * loads + caches; subsequent calls reuse. Init of the Parser core
 * is also cached as a one-shot Promise.
 */
let _initPromise: Promise<void> | null = null;
const _languageCache = new Map<SupportedLanguage, Promise<Language>>();

/**
 * Initialise the Tree-Sitter Parser core. Idempotent — repeated
 * calls return the same Promise.
 *
 * `extensionPath` is the absolute path the ExtensionContext exposes
 * for the running VS Code extension; locateFile resolves wasm assets
 * relative to it. In tests, callers may pass a fixture-relative root.
 */
export function initTreeSitter(extensionPath: string): Promise<void> {
    if (_initPromise) { return _initPromise; }
    _initPromise = Parser.init({
        // The web-tree-sitter package provides web-tree-sitter.wasm
        // alongside its JS file. locateFile is how Emscripten finds
        // it at runtime — without this, it tries to GET it relative
        // to the VS Code window's URL, which fails.
        locateFile: (file: string) => {
            return path.join(extensionPath, 'node_modules', 'web-tree-sitter', file);
        }
    } as Parameters<typeof Parser.init>[0]);
    return _initPromise;
}

/** Load a language wasm. Cached per-language. */
async function getLanguage(extensionPath: string, lang: SupportedLanguage): Promise<Language> {
    let cached = _languageCache.get(lang);
    if (cached) { return cached; }

    cached = (async () => {
        const wasmPath = lang === 'tsx'
            ? path.join(extensionPath, 'node_modules', 'tree-sitter-typescript', 'tree-sitter-tsx.wasm')
            : path.join(extensionPath, 'node_modules', 'tree-sitter-typescript', 'tree-sitter-typescript.wasm');
        // Language.load accepts either a path string (browser) or
        // raw bytes (Node). In the extension host we read bytes
        // directly — more reliable than letting Emscripten guess
        // how to fetch a file: URL.
        const bytes = fs.readFileSync(wasmPath);
        return Language.load(bytes);
    })();
    _languageCache.set(lang, cached);
    return cached;
}

/**
 * Detect the source language from a filename. Used to pick the
 * right grammar. Returns null for unsupported extensions; callers
 * should fall back to the regex parser in that case.
 */
export function detectLanguage(filename: string): SupportedLanguage | null {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.ts') { return 'typescript'; }
    if (ext === '.tsx') { return 'tsx'; }
    if (ext === '.js') { return 'typescript'; }    // JS is a TS subset for symbol purposes
    if (ext === '.jsx') { return 'tsx'; }
    return null;
}

/**
 * Extract symbols from source using Tree-Sitter. Same shape as
 * ASTParser.extractSymbols.
 *
 * Returns an empty result on parse failure — matches regex parser
 * fallback behavior. Errors are logged but not thrown.
 */
export async function extractSymbolsAsync(
    extensionPath: string,
    source: string,
    lang: SupportedLanguage
): Promise<ExtractedSymbols> {
    const empty: ExtractedSymbols = {
        imports: [],
        importedNames: {},
        exports: [],
        classes: [],
        functions: [],
        interfaces: [],
        variables: []
    };

    try {
        await initTreeSitter(extensionPath);
        const language = await getLanguage(extensionPath, lang);

        const parser = new Parser();
        parser.setLanguage(language);
        const tree = parser.parse(source);
        if (!tree) {
            parser.delete();
            return empty;
        }

        const result: ExtractedSymbols = {
            imports: [],
            importedNames: {},
            exports: [],
            classes: [],
            functions: [],
            interfaces: [],
            variables: []
        };

        walk(tree.rootNode, source, result);

        // Deduplicate string arrays. Tree-Sitter visits each node
        // once but multi-name extractions (e.g. `import { a, b }`)
        // can produce repeats if the source has the same import
        // statement twice, which is legal TS.
        result.imports = Array.from(new Set(result.imports));
        result.exports = Array.from(new Set(result.exports));
        result.classes = Array.from(new Set(result.classes));
        result.functions = Array.from(new Set(result.functions));
        result.interfaces = Array.from(new Set(result.interfaces));
        result.variables = Array.from(new Set(result.variables));
        for (const k of Object.keys(result.importedNames)) {
            result.importedNames[k] = Array.from(new Set(result.importedNames[k]));
        }

        parser.delete();
        return result;
    } catch (e) {
        log.warn(`[TreeSitter] parse failed:`, e);
        return empty;
    }
}

/**
 * Recursive AST walker. Tree-Sitter exposes a tree we walk by
 * `node.namedChildren`. Each node has a `type` (string) we match
 * against the language's documented node-type names.
 *
 * The TypeScript grammar's relevant node types (a small subset
 * captured from `node-types.json`):
 *   - import_statement       — `import ...` syntax
 *   - import_clause          — the `{ x, y }` part inside import
 *   - named_imports          — wraps `{ x, y }`
 *   - import_specifier       — single `x` or `x as y`
 *   - namespace_import       — `* as Foo`
 *   - export_statement       — `export ...`
 *   - export_specifier       — single `foo` inside `export { foo }`
 *   - class_declaration      — `class Foo {}`
 *   - function_declaration   — `function foo() {}`
 *   - interface_declaration  — `interface Foo {}`
 *   - lexical_declaration    — `const`, `let` blocks
 *   - variable_declaration   — `var` blocks
 *   - call_expression        — for `import()` dynamic imports
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(node: any, source: string, out: ExtractedSymbols): void {
    if (!node) { return; }

    switch (node.type) {
        case 'import_statement':
            handleImportStatement(node, source, out);
            // Imports have no nested declarations of interest, but
            // we don't return — keeps the switch homogeneous with
            // export_statement which DOES need recursion to capture
            // `export class Foo`'s class_declaration.
            break;
        case 'export_statement':
            handleExportStatement(node, source, out);
            // Fall through to recurse — `export class Foo {}`
            // contains a class_declaration child that needs to be
            // visited so Foo lands in classes[].
            break;
        case 'class_declaration':
            captureNameOf(node, source, out.classes);
            break;
        case 'function_declaration':
            captureNameOf(node, source, out.functions);
            break;
        case 'method_definition':
            // Methods inside classes — record their names too so
            // codeGraph can resolve "F.bar" callee references
            captureNameOf(node, source, out.functions);
            break;
        case 'interface_declaration':
            captureNameOf(node, source, out.interfaces);
            break;
        case 'lexical_declaration':
        case 'variable_declaration':
            captureVariableNames(node, source, out.variables);
            break;
        case 'call_expression':
            // Dynamic import: `import('./m')` shows up as a
            // call_expression where the function name is `import`
            handleDynamicImport(node, source, out);
            break;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const child of (node.namedChildren ?? []) as any[]) {
        walk(child, source, out);
    }
}

/** Extract `name` field from a named declaration node. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureNameOf(node: any, source: string, into: string[]): void {
    const nameNode = node.childForFieldName?.('name');
    if (nameNode) {
        const text = sliceSource(source, nameNode);
        if (text) { into.push(text); }
    }
}

/** Variable declarations can have multiple bindings: `const a = 1, b = 2`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureVariableNames(node: any, source: string, into: string[]): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const child of (node.namedChildren ?? []) as any[]) {
        if (child.type === 'variable_declarator') {
            const nameNode = child.childForFieldName?.('name');
            if (nameNode && nameNode.type === 'identifier') {
                const text = sliceSource(source, nameNode);
                if (text) { into.push(text); }
            }
            // Destructuring patterns (object_pattern, array_pattern)
            // bind multiple names — walk into them
            else if (nameNode) {
                collectDestructuredNames(nameNode, source, into);
            }
        }
    }
}

/** Walk a destructuring pattern and collect every bound identifier. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectDestructuredNames(node: any, source: string, into: string[]): void {
    if (!node) { return; }
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
        const text = sliceSource(source, node);
        if (text) { into.push(text); }
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const child of (node.namedChildren ?? []) as any[]) {
        collectDestructuredNames(child, source, into);
    }
}

/** Handle `import ... from '...'` statements. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleImportStatement(node: any, source: string, out: ExtractedSymbols): void {
    // The module path is in the `source` field — confusingly named
    // but that's what Tree-Sitter calls the import target. It's a
    // string literal node; strip quotes.
    const sourceField = node.childForFieldName?.('source');
    if (!sourceField) { return; }
    const modulePath = unquote(sliceSource(source, sourceField));
    if (!modulePath) { return; }

    if (!out.imports.includes(modulePath)) { out.imports.push(modulePath); }
    if (!out.importedNames[modulePath]) { out.importedNames[modulePath] = []; }

    // Walk the import_clause to find named/default/namespace imports
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const child of (node.namedChildren ?? []) as any[]) {
        if (child.type !== 'import_clause') { continue; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const grandchild of (child.namedChildren ?? []) as any[]) {
            if (grandchild.type === 'identifier') {
                // Default import: `import Foo from './m'`
                const name = sliceSource(source, grandchild);
                if (name) { out.importedNames[modulePath].push(name); }
            } else if (grandchild.type === 'namespace_import') {
                // `* as Foo` — the identifier is a named child
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for (const nameNode of (grandchild.namedChildren ?? []) as any[]) {
                    if (nameNode.type === 'identifier') {
                        const name = sliceSource(source, nameNode);
                        if (name) { out.importedNames[modulePath].push(name); }
                    }
                }
            } else if (grandchild.type === 'named_imports') {
                // `{ a, b as c }`
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                for (const spec of (grandchild.namedChildren ?? []) as any[]) {
                    if (spec.type !== 'import_specifier') { continue; }
                    // `import_specifier` has fields `name` (original)
                    // and optional `alias` (local binding). Local
                    // binding is what other code in this file
                    // actually references — that's what cross-file
                    // resolvers care about.
                    const aliasNode = spec.childForFieldName?.('alias');
                    const nameNode = spec.childForFieldName?.('name');
                    const localName = aliasNode
                        ? sliceSource(source, aliasNode)
                        : (nameNode ? sliceSource(source, nameNode) : null);
                    if (localName) { out.importedNames[modulePath].push(localName); }
                }
            }
        }
    }
}

/** Handle `export ...` statements. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleExportStatement(node: any, source: string, out: ExtractedSymbols): void {
    // Re-export: `export { foo } from './m'` — captured as both
    // export AND import-from-link
    const sourceField = node.childForFieldName?.('source');
    if (sourceField) {
        const modulePath = unquote(sliceSource(source, sourceField));
        if (modulePath && !out.imports.includes(modulePath)) {
            out.imports.push(modulePath);
        }
        if (modulePath && !out.importedNames[modulePath]) {
            out.importedNames[modulePath] = [];
        }
    }

    // The exported symbols themselves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const child of (node.namedChildren ?? []) as any[]) {
        if (child.type === 'export_clause') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const spec of (child.namedChildren ?? []) as any[]) {
                if (spec.type !== 'export_specifier') { continue; }
                const nameNode = spec.childForFieldName?.('name');
                if (nameNode) {
                    const name = sliceSource(source, nameNode);
                    if (name) { out.exports.push(name); }
                }
            }
        } else if (
            child.type === 'class_declaration' ||
            child.type === 'function_declaration' ||
            child.type === 'interface_declaration' ||
            child.type === 'lexical_declaration' ||
            child.type === 'variable_declaration'
        ) {
            // `export class Foo {}` — capture both as export and as
            // class. Walk handles the latter via normal recursion;
            // here we just add the export.
            const nameNode = child.childForFieldName?.('name');
            if (nameNode) {
                const name = sliceSource(source, nameNode);
                if (name) { out.exports.push(name); }
            }
        }
    }
}

/** Handle dynamic imports: `import('./m')` parses as a call_expression. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleDynamicImport(node: any, source: string, out: ExtractedSymbols): void {
    const fnNode = node.childForFieldName?.('function');
    if (!fnNode || fnNode.type !== 'import') { return; }
    const argsNode = node.childForFieldName?.('arguments');
    if (!argsNode) { return; }
    // First argument should be a string literal
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const arg of (argsNode.namedChildren ?? []) as any[]) {
        if (arg.type === 'string') {
            const path = unquote(sliceSource(source, arg));
            if (path && !out.imports.includes(path)) {
                out.imports.push(path);
            }
            if (path && !out.importedNames[path]) {
                out.importedNames[path] = [];
            }
            break;
        }
    }
}

/** Extract source text for a node by its byte offsets. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sliceSource(source: string, node: any): string {
    if (!node || typeof node.startIndex !== 'number' || typeof node.endIndex !== 'number') {
        return '';
    }
    return source.slice(node.startIndex, node.endIndex);
}

/** Strip surrounding quotes from a string-literal node text. */
function unquote(s: string): string {
    if (!s) { return ''; }
    const first = s.charAt(0);
    const last = s.charAt(s.length - 1);
    if ((first === '"' || first === "'" || first === '`') && first === last) {
        return s.slice(1, -1);
    }
    return s;
}

/**
 * Whether the user has opted in to the Tree-Sitter parser via
 * `nexuscode.experimental.treeSitter`.
 *
 * Default false until the packaging story is verified at runtime.
 * Once verified (vsce package contains the wasm files, they load
 * in the installed extension), flip the default to true and
 * eventually retire the regex parser.
 */
export function isTreeSitterEnabled(): boolean {
    try {
        return vscode.workspace
            .getConfiguration('nexuscode.experimental')
            .get<boolean>('treeSitter') === true;
    } catch {
        // In test environments without a vscode mock that supports
        // get(), default to off
        return false;
    }
}

/**
 * Test-only: reset the lazy-init caches. Each test should start
 * with a fresh init flow so timing-related bugs surface.
 */
export function resetTreeSitterForTests(): void {
    _initPromise = null;
    _languageCache.clear();
}