"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASTParser = void 0;
const logger_1 = require("../logger");
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
class ASTParser {
    static async init(_context) {
        //  We have stripped out the fragile WebAssembly Tree-Sitter dependency.
        // The AST Engine is now powered by a bulletproof, zero-dependency RegExp engine.
        logger_1.log.info("AST Regex Engine initialized successfully.");
    }
    static extractSymbols(content) {
        const result = {
            imports: [],
            importedNames: {},
            exports: [],
            classes: [],
            functions: [],
            interfaces: [],
            variables: []
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
                if (!match[2]) {
                    continue;
                }
                const modulePath = match[2];
                const names = (match[1] ?? '')
                    .split(',')
                    .map((s) => {
                    // Handle "x as y" — record the local binding (y)
                    // because that's what the importing file
                    // actually references in code.
                    const trimmed = s.trim();
                    const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(trimmed);
                    return asMatch ? asMatch[2] : trimmed;
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
                const defaultName = match[2]; // from `<name>`
                const modulePath = match[3];
                if (!modulePath) {
                    continue;
                }
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
                if (match[1]) {
                    result.classes.push(match[1]);
                }
            }
            // 3. Extract Standard Functions
            const funcRegex = /function\s+([a-zA-Z0-9_]+)\s*\(/g;
            while ((match = funcRegex.exec(cleanContent)) !== null) {
                if (match[1]) {
                    result.functions.push(match[1]);
                }
            }
            // 4. Extract Arrow Functions
            const arrowRegex = /(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;
            while ((match = arrowRegex.exec(cleanContent)) !== null) {
                if (match[1]) {
                    result.functions.push(match[1]);
                }
            }
            // 5. Extract Interfaces
            const intRegex = /interface\s+([a-zA-Z0-9_]+)/g;
            while ((match = intRegex.exec(cleanContent)) !== null) {
                if (match[1]) {
                    result.interfaces.push(match[1]);
                }
            }
            // 6. Extract Exports
            const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|default)\s+([a-zA-Z0-9_]+)?/g;
            while ((match = exportRegex.exec(cleanContent)) !== null) {
                if (match[1]) {
                    result.exports.push(match[1]);
                }
            }
        }
        catch (e) {
            logger_1.log.error("[AST Parser] Regex parsing failed", e);
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
exports.ASTParser = ASTParser;
//# sourceMappingURL=astParser.js.map