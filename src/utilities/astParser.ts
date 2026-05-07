import * as vscode from 'vscode';
import { log } from '../logger';
import {
    detectLanguage,
    extractSymbolsAsync,
    initTreeSitter,
    isTreeSitterEnabled,
} from './treeSitterParser';

/**
 * Symbol extraction result from a single source file.
 *
 * P1.3 extension: `importedNames` distinguishes per-module import
 * identifiers from the bare module path. Without this, callee analysis
 * is path-only ("F imports something from G") rather than symbol-aware
 * ("F uses `foo` from G"). The richer signal lets the codeGraph
 * surface only the modules whose symbols are actually referenced.
 *
 * Tree-Sitter would give exact resolution (handles re-exports,
 * default-vs-named imports, namespace imports, dynamic imports
 * properly). The regex parser misses some of these — see the note
 * inside ASTParser.extractSymbols. We accept that for v1; v2 will
 * swap in Tree-Sitter (see SwapTreeSitterNote below).
 */
export interface ExtractedSymbols {
    imports: string[];
    /** P1.3: per-module imported identifiers, keyed by module path.
     *  e.g. `{ './foo': ['Foo', 'bar'], 'react': ['useState'] }`.
     *  Empty when the parser couldn't resolve named imports for a
     *  module (default imports, namespace imports, etc.) — falls back
     *  to module-path-only analysis. */
    importedNames: Record<string, string[]>;
    exports: string[];
    classes: string[];
    functions: string[];
    interfaces: string[];
    variables: string[];
}

/**
 * SwapTreeSitterNote — when v2 replaces this regex parser:
 *
 *   1. The `extractSymbols` API contract is the ExtractedSymbols
 *      interface. Implementations that match it are drop-in
 *      replacements; codeGraph.ts and any callers don't change.
 *
 *   2. Things this regex parser still misses that Tree-Sitter would
 *      catch (default/namespace imports DO now capture their local
 *      binding — that limitation was fixed):
 *      - Renamed imports: `import { x as y } from './m'` — we capture
 *        the local name `y`, missing that `x` was the original.
 *      - Re-exports: `export { foo } from './m'` — currently captured
 *        as an export but we lose the "from" link.
 *      - Dynamic imports: `import('./m')` — not captured at all.
 *      - Type-only imports: `import type { X } from './m'` — captured
 *        the same as runtime imports; the type/value distinction is
 *        lost. Usually fine for symbol-graph purposes.
 *      - Mixed default + named: `import Foo, { bar, baz } from './m'`
 *        DOES capture both the default name and the named imports
 *        (the named-import regex catches the `{ bar, baz }` part
 *        and the default-import regex catches `Foo`).
 *
 *   3. Performance: the regex parser is fast (microseconds per file).
 *      Tree-Sitter's wasm parser is slower but still well under the
 *      perceptual threshold; the bigger v2 cost is bundle size.
 *
 *   4. Failure mode: the regex parser fails silently (returns empty
 *      arrays for unparseable input). Tree-Sitter would raise on
 *      syntax errors — wrap it in try/catch with the same fallback.
 */
export class ASTParser {
    /**
     * Initialise both parser backends.
     *
     * The regex parser is always available — it's the default and the
     * sync fallback. Tree-Sitter is OPT-IN behind the
     * `nexuscode.experimental.treeSitter` setting; when enabled, we
     * pre-warm its wasm runtime here so the first parse doesn't pay
     * the ~250ms init cost on the user's critical path.
     *
     * Why init unconditionally even when the flag is off: the flag is
     * read per-call (workspace settings can change at runtime). Pre-
     * warming when the user might flip the flag mid-session is cheap
     * insurance — but only if the wasms actually ship in the VSIX.
     * Per the recon in session 1 of the language-coverage work, the
     * wasms DO ship (vsce ls confirmed parser/*.wasm and the
     * web-tree-sitter + tree-sitter-typescript node_modules entries).
     * If wasm loading fails on a user's machine, initTreeSitter logs
     * the failure and downstream calls fall back to the regex parser
     * via the dispatcher in extractSymbolsAuto below.
     */
    public static async init(context: vscode.ExtensionContext) {
        log.info("AST Regex Engine initialized");
        // Pre-warm Tree-Sitter when opted in. Failure here doesn't
        // block init — the dispatcher detects the flag at call time
        // and the regex parser remains available regardless.
        try {
            if (isTreeSitterEnabled()) {
                await initTreeSitter(context.extensionPath);
                log.info("Tree-Sitter parser pre-warmed");
            }
        } catch (e) {
            log.warn("Tree-Sitter pre-warm failed; falling back to regex parser", e);
        }
    }

    /**
     * Async dispatcher: route to Tree-Sitter when opted in AND the
     * file extension is supported, else fall back to the sync regex
     * parser. Same return shape either way (ExtractedSymbols).
     *
     * Callers in production code (codeGraph.ts) should prefer this
     * over the sync `extractSymbols` so the user can flip the feature
     * flag and get the better parser without any code change.
     *
     * Tests can keep calling `extractSymbols` directly — they want
     * deterministic regex behavior independent of the user's setting.
     *
     * Failure mode: if Tree-Sitter throws or rejects (wasm load
     * failure on the user's machine, parser core unavailable, etc.),
     * we log and fall through to the regex parser. The user gets a
     * worse parse, not a crash.
     */
    public static async extractSymbolsAuto(
        filepath: string,
        content: string,
        extensionPath: string,
    ): Promise<ExtractedSymbols> {
        if (isTreeSitterEnabled()) {
            const lang = detectLanguage(filepath);
            if (lang) {
                try {
                    return await extractSymbolsAsync(extensionPath, content, lang);
                } catch (e) {
                    log.warn(`[ASTParser] Tree-Sitter failed for ${filepath}; falling back to regex`, e);
                    // Fall through to regex
                }
            }
            // detectLanguage returned null → file extension not yet
            // supported by the Tree-Sitter walker. Use regex.
        }
        return ASTParser.extractSymbols(content);
    }

    public static extractSymbols(content: string): ExtractedSymbols {
        const result: ExtractedSymbols = {
            imports: [] as string[],
            importedNames: {} as Record<string, string[]>,
            exports: [] as string[],
            classes: [] as string[],
            functions: [] as string[],
            interfaces: [] as string[],
            variables: [] as string[]
        };

        try {
            // Strip comments to avoid false positives
            const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

            // 1. Extract Imports — both the module path and (when
            //    present) the named identifiers imported from it.
            //
            //    We capture three patterns:
            //      a. `import { Foo, bar as baz } from './m'`
            //         → importedNames['./m'] = ['Foo', 'bar'] (local name)
            //      b. `import Foo from './m'`     (default import)
            //         → importedNames['./m'] = ['Foo']
            //      c. `import * as Foo from './m'` (namespace import)
            //         → importedNames['./m'] = ['Foo']
            //      d. `import Foo, { bar } from './m'` (mixed)
            //         → importedNames['./m'] = ['Foo', 'bar']
            //
            // The named-import block is matched by the regex below;
            // default + namespace forms are matched by the otherImportRegex
            // further down. For the mixed form (d), BOTH regexes fire
            // and contribute their respective names.
            const namedImportRegex = /import\s+(?:[a-zA-Z_$][a-zA-Z0-9_$]*\s*,\s*)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
            let match;
            while ((match = namedImportRegex.exec(cleanContent)) !== null) {
                if (!match[2]) { continue; }
                const modulePath = match[2];
                const names = (match[1] ?? '')
                    .split(',')
                    .map((s) => {
                        // Handle "x as y" — record the local binding (y)
                        // because that's what the importing file
                        // actually references in code.
                        const trimmed = s.trim();
                        const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(trimmed);
                        return asMatch ? asMatch[2]! : trimmed;
                    })
                    .filter((s) => s.length > 0);
                if (!result.importedNames[modulePath]) {
                    result.importedNames[modulePath] = [];
                }
                result.importedNames[modulePath].push(...names);
                if (!result.imports.includes(modulePath)) {
                    result.imports.push(modulePath);
                }
            }

            // Default + namespace imports — capture the local
            // binding name so cross-file symbol resolvers can match
            // usages of the binding back to its source module.
            // Forms covered:
            //   import Foo from './m'         → 'Foo'
            //   import * as Foo from './m'    → 'Foo'
            //   import Foo, { bar } from './m' → 'Foo' (named already
            //                                   captured above)
            const otherImportRegex = /import\s+(?:\*\s+as\s+(\S+)|([a-zA-Z_$][a-zA-Z0-9_$]*))(?:\s*,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
            while ((match = otherImportRegex.exec(cleanContent)) !== null) {
                const namespaceName = match[1]; // from `* as <name>`
                const defaultName = match[2];   // from `<name>`
                const modulePath = match[3];
                if (!modulePath) { continue; }
                if (!result.imports.includes(modulePath)) {
                    result.imports.push(modulePath);
                }
                if (!result.importedNames[modulePath]) {
                    result.importedNames[modulePath] = [];
                }
                const localName = namespaceName ?? defaultName;
                if (localName && !result.importedNames[modulePath].includes(localName)) {
                    result.importedNames[modulePath].push(localName);
                }
            }

            // 2. Extract Classes
            const classRegex = /class\s+([a-zA-Z0-9_]+)/g;
            while ((match = classRegex.exec(cleanContent)) !== null) {
                if (match[1]) { result.classes.push(match[1]); }
            }

            // 3. Extract Standard Functions
            const funcRegex = /function\s+([a-zA-Z0-9_]+)\s*\(/g;
            while ((match = funcRegex.exec(cleanContent)) !== null) {
                if (match[1]) { result.functions.push(match[1]); }
            }

            // 4. Extract Arrow Functions
            const arrowRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;
            while ((match = arrowRegex.exec(cleanContent)) !== null) {
                if (match[1]) { result.functions.push(match[1]); }
            }

            // 5. Extract Interfaces
            const intRegex = /interface\s+([a-zA-Z0-9_]+)/g;
            while ((match = intRegex.exec(cleanContent)) !== null) {
                if (match[1]) { result.interfaces.push(match[1]); }
            }

            // 6. Extract Exports
            const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|default)\s+([a-zA-Z0-9_]+)?/g;
            while ((match = exportRegex.exec(cleanContent)) !== null) {
                if (match[1]) { result.exports.push(match[1]); }
            }
        } catch (e) {
            log.error("[AST Parser] Regex parsing failed", e);
        }

        return {
            imports: [...new Set(result.imports)],
            importedNames: result.importedNames,
            exports: [...new Set(result.exports)],
            classes: [...new Set(result.classes)],
            functions: [...new Set(result.functions)],
            interfaces: [...new Set(result.interfaces)],
            variables: [...new Set(result.variables)]
        };
    }
}