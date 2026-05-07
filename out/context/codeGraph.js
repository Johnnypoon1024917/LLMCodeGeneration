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
exports.addFileToGraph = addFileToGraph;
exports.clearWorkspaceGraph = clearWorkspaceGraph;
exports.resolveImportPath = resolveImportPath;
exports.calculateGraphCorrelation = calculateGraphCorrelation;
exports.buildWorkspaceGraph = buildWorkspaceGraph;
exports.getGraphJSON = getGraphJSON;
exports.pathMatchesAnyExclude = pathMatchesAnyExclude;
exports.getSmartASTContext = getSmartASTContext;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const astParser_1 = require("../utilities/astParser");
const logger_1 = require("../logger");
let workspaceGraph = new Map();
/**
 * Parses file content and adds it to the workspace graph using AST
 */
async function addFileToGraph(filepath, content) {
    const symbols = astParser_1.ASTParser.extractSymbols(content);
    const node = {
        filepath,
        imports: symbols.imports,
        importedNames: symbols.importedNames,
        exports: symbols.exports,
        classes: symbols.classes,
        functions: symbols.functions,
        interfaces: symbols.interfaces,
        variables: symbols.variables
    };
    workspaceGraph.set(filepath, node);
}
/**
 * P1.3: clear the workspace graph. Exposed for tests — calculateGraphCorrelation
 * reads module-global state, so unit tests need to reset between cases. Not
 * intended for production use; the IDE workflow rebuilds via buildWorkspaceGraph.
 */
function clearWorkspaceGraph() {
    workspaceGraph.clear();
}
/**
 * P1.3: resolve a relative import path (as it appears in source) to
 * the absolute filesystem path that's the graph key.
 *
 * Returns null when the import doesn't resolve to a known graph file.
 * Bare-package imports (`'react'`, `'lodash'`) always return null
 * because we don't index node_modules. Relative imports without
 * extension are checked against `.ts`, `.tsx`, `.js`, `.jsx`, and
 * `<path>/index.{ts,tsx,js,jsx}` in that order — matching common
 * Node + bundler resolution.
 *
 * This is structurally correct for the common case but doesn't honor
 * tsconfig path aliases (`@/foo` → `./src/foo`). v2's Tree-Sitter +
 * tsserver integration would do that properly; for now, alias-using
 * codebases get partial coverage.
 */
function resolveImportPath(importerPath, importPath) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        // Bare package import (e.g. 'react') — not in our graph.
        return null;
    }
    // Normalize to forward slashes for cross-platform matching.
    // `path.resolve` on Windows can prepend a drive letter when given
    // forward-slash-only inputs without a drive (e.g. `/repo/src` →
    // `C:\repo\src`), which breaks tests that pass POSIX paths and
    // also breaks any production codepath where graph keys and
    // candidates disagree on separator. Doing the resolution in
    // forward-slash space sidesteps both issues.
    const normImporter = importerPath.replace(/\\/g, '/');
    const normImport = importPath.replace(/\\/g, '/');
    // Manual posix-style resolution: take the importer's directory,
    // append the import, then collapse `.` and `..` segments.
    const importerDir = normImporter.substring(0, normImporter.lastIndexOf('/'));
    const joined = `${importerDir}/${normImport}`;
    const segments = joined.split('/');
    const stack = [];
    for (const seg of segments) {
        if (seg === '' || seg === '.') {
            // Preserve leading empty segment (POSIX absolute root)
            // by pushing it once at the start; ignore others.
            if (stack.length === 0 && seg === '') {
                stack.push('');
            }
            continue;
        }
        if (seg === '..') {
            if (stack.length > 1) {
                stack.pop();
            }
            continue;
        }
        stack.push(seg);
    }
    const baseResolved = stack.join('/');
    // Try in order: exact-as-given, then with extensions, then index files.
    const candidates = [
        baseResolved,
        `${baseResolved}.ts`,
        `${baseResolved}.tsx`,
        `${baseResolved}.js`,
        `${baseResolved}.jsx`,
        `${baseResolved}/index.ts`,
        `${baseResolved}/index.tsx`,
        `${baseResolved}/index.js`,
        `${baseResolved}/index.jsx`
    ];
    // Build a normalized lookup: graph key → original key. Match
    // candidates against normalized keys; return the original key
    // (which preserves whatever separator the production code stored).
    const normalizedKeys = new Map();
    for (const key of workspaceGraph.keys()) {
        normalizedKeys.set(key.replace(/\\/g, '/'), key);
    }
    for (const candidate of candidates) {
        const original = normalizedKeys.get(candidate);
        if (original !== undefined) {
            return original;
        }
    }
    return null;
}
/**
 * 🧮 THE CORRELATION ENGINE: Mathematically scores how related every file is to the target edit.
 *
 * P1.3 scoring updates:
 *   - **Callees** (target imports F): high signal — these files
 *     define symbols the target USES. +50 per resolved import.
 *   - **Callers** (F imports target): high signal — these files USE
 *     symbols the target defines. +50 base + bonus per used export.
 *   - Shared imports + shared symbols stay as a weak fallback signal
 *     when there's no direct structural relationship.
 *
 * Why callees/callers score higher than the legacy keyword/import
 * overlap: a caller is GUARANTEED to break if you change the target's
 * exports incompatibly. A file that just shares some imports with the
 * target may or may not interact at all. Scoring should reflect that
 * causal certainty.
 */
function calculateGraphCorrelation(targetFileQuery) {
    const results = [];
    const targetKey = Array.from(workspaceGraph.keys()).find(k => k.includes(targetFileQuery));
    if (!targetKey) {
        return [];
    }
    const targetNode = workspaceGraph.get(targetKey);
    const cleanTarget = targetKey.replace(/\.[^/.]+$/, ""); // Strip extensions for import matching
    // P1.3: pre-compute the target's RESOLVED imports (callees) so we
    // can match against them in the per-file loop. Resolved-callees is
    // a Set<absolutePath> of files the target imports from.
    const targetCalleePaths = new Set();
    for (const importPath of targetNode.imports) {
        const resolved = resolveImportPath(targetKey, importPath);
        if (resolved) {
            targetCalleePaths.add(resolved);
        }
    }
    for (const [filepath, node] of workspaceGraph.entries()) {
        if (filepath === targetKey) {
            results.push({ filepath, score: 100, reasons: ['📍 Target File'], node });
            continue;
        }
        let score = 0;
        const reasons = [];
        // P1.3 — Structural relationships first (higher weight). These
        // are causal: if you change the target, these files are at
        // direct risk of breaking.
        // 1a. CALLEE: target imports from this file. The agent will
        //     likely need to read this file's exports to understand
        //     what symbols are available.
        if (targetCalleePaths.has(filepath)) {
            score += 50;
            // Surface which symbols the target uses, when we know.
            // (Default/namespace imports lose this signal — see
            //  ExtractedSymbols.importedNames docstring.)
            const importPath = targetNode.imports.find((ip) => resolveImportPath(targetKey, ip) === filepath);
            const usedNames = importPath
                ? (targetNode.importedNames[importPath] || [])
                : [];
            if (usedNames.length > 0) {
                reasons.push(`⬇️ Target uses: ${usedNames.slice(0, 5).join(', ')}`);
            }
            else {
                reasons.push('⬇️ Target imports from this file');
            }
        }
        // 1b. CALLER: this file imports from the target. Changes to
        //     the target's exports will affect this file.
        const callerImportPaths = node.imports.filter((ip) => {
            const resolved = resolveImportPath(filepath, ip);
            return resolved === targetKey;
        });
        if (callerImportPaths.length > 0) {
            score += 50;
            // What does this caller use? Surface that for the agent.
            const usedNamesAcrossModule = callerImportPaths
                .flatMap((ip) => node.importedNames[ip] || []);
            if (usedNamesAcrossModule.length > 0) {
                // Bonus per used symbol — files that lean heavily on
                // the target deserve higher priority than those that
                // only pull a single helper.
                score += Math.min(usedNamesAcrossModule.length * 5, 25);
                reasons.push(`⬆️ Uses: ${usedNamesAcrossModule.slice(0, 5).join(', ')}`);
            }
            else {
                reasons.push('⬆️ Imports from target');
            }
        }
        // 2. WEAKER SIGNALS — only count when there's no direct
        //    structural relationship. Otherwise these double-count
        //    and inflate the noise.
        if (score === 0) {
            // 2a. Direct dependency by basename (catches cases the
            //     resolver missed — e.g. dynamic imports, tsconfig
            //     paths). This is the legacy heuristic preserved as
            //     a fallback.
            if (node.imports.some(imp => imp.includes(path.basename(cleanTarget)))) {
                score += 20;
                reasons.push('⬇️ Imports Target (basename match)');
            }
            // 2b. Shared dependencies (both files import the same module)
            const sharedImports = node.imports.filter(imp => targetNode.imports.includes(imp));
            if (sharedImports.length > 0) {
                score += Math.min(sharedImports.length * 3, 15);
                reasons.push(`🔗 Shared imports (${sharedImports.length})`);
            }
            // 2c. Shared terminology/symbols
            const sharedClasses = node.classes.filter(c => targetNode.classes.includes(c));
            const sharedInterfaces = node.interfaces.filter(i => targetNode.interfaces.includes(i));
            if (sharedClasses.length > 0 || sharedInterfaces.length > 0) {
                score += 10;
                reasons.push('🧬 Shares Data Structures');
            }
        }
        if (score > 0) {
            results.push({ filepath, score, reasons, node });
        }
    }
    // Sort by highest correlation score
    return results.sort((a, b) => b.score - a.score);
}
/**
 * Builds the initial workspace graph by scanning the project
 */
/**
 * V2.1.2 spec-fix-4: language-aware import extraction for non-TS/JS files.
 * The full ASTParser only handles TypeScript/JavaScript. For other
 * common languages we use a regex-based fallback so the code map at
 * least shows file existence + cross-file dependencies. Imperfect by
 * design — this is a "show something useful" path, not a parse-perfect
 * one. Symbol-level data (functions/classes) is left empty for these
 * files; the symbol-level toggle will only show TS/JS symbols.
 *
 * Each entry maps an extension to a regex that captures the imported
 * path/module. Patterns are conservative — we'd rather miss imports
 * than produce false matches that confuse the user.
 */
const IMPORT_PATTERNS = {
    '.py': [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm],
    '.go': [/^\s*import\s+"([^"]+)"/gm, /^\s*import\s+\(\s*"([^"]+)"/gm],
    '.java': [/^\s*import\s+([\w.]+);/gm],
    '.rs': [/^\s*use\s+([\w:]+)/gm],
    '.html': [/<script[^>]+src=["']([^"']+)["']/gi, /<link[^>]+href=["']([^"']+\.css)["']/gi],
    '.css': [/@import\s+url\(["']?([^"')]+)["']?\)/gi, /@import\s+["']([^"']+)["']/gi],
    '.vue': [/import\s+.*?\s+from\s+["']([^"']+)["']/g],
    '.svelte': [/import\s+.*?\s+from\s+["']([^"']+)["']/g],
};
/**
 * Extract imports from a non-AST-parsed file using language-specific
 * regex patterns. Returns an empty array when the language has no
 * pattern defined or when the patterns don't match.
 */
function extractImportsLite(filepath, content) {
    const ext = path.extname(filepath).toLowerCase();
    const patterns = IMPORT_PATTERNS[ext];
    if (!patterns) {
        return [];
    }
    const imports = [];
    for (const re of patterns) {
        // Reset lastIndex — the regexes are flagged /g and re-using the
        // same instance across calls would skip matches.
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content)) !== null) {
            if (m[1]) {
                imports.push(m[1]);
            }
        }
    }
    return imports;
}
async function buildWorkspaceGraph(rootUri) {
    // V2.1.2 spec-fix-4: extended language coverage. The original glob
    // only matched JS/TS so any project written in another language
    // produced an empty code map (which then cascaded — req map and
    // combined map showed nothing because they merge against codeMap).
    // Now we scan the common web/backend extensions; for non-TS/JS
    // files we use regex-based import extraction (extractImportsLite).
    const exts = '{ts,tsx,js,jsx,mjs,cjs,py,go,java,rs,vue,svelte,html,css}';
    const searchPattern = rootUri
        ? new vscode.RelativePattern(rootUri, `**/*.${exts}`)
        : `**/*.${exts}`;
    const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**');
    for (const file of files) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            const content = doc.getText();
            const ext = path.extname(file.fsPath).toLowerCase();
            // TS/JS go through the full AST parser. Everything else
            // goes through the regex-lite path with empty symbols.
            if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
                await addFileToGraph(file.fsPath, content);
            }
            else {
                const imports = extractImportsLite(file.fsPath, content);
                workspaceGraph.set(file.fsPath, {
                    filepath: file.fsPath,
                    imports,
                    importedNames: {},
                    exports: [],
                    classes: [],
                    functions: [],
                    interfaces: [],
                    variables: [],
                });
            }
        }
        catch (e) {
            logger_1.log.warn(`Failed to parse ${file.fsPath} for GraphRAG`);
        }
    }
}
/**
 * Returns the graph as a JSON string for the Webview UI
 */
function getGraphJSON() {
    const obj = {};
    for (const [key, value] of workspaceGraph.entries()) {
        obj[key] = value;
    }
    return JSON.stringify(obj);
}
/**
 * P1.3: pure path-exclusion check, exported for testability. A path
 * is considered excluded if any of the patterns is a substring of the
 * path (case-sensitive on POSIX, normalized to forward slashes for
 * cross-platform consistency).
 *
 * Why substring instead of glob: simpler API, covers the common
 * regulated-industry use cases ("don't read legacy/", "skip
 * generated/", "exclude src/server/internal/"), no extra deps. Globs
 * would be more powerful but require minimatch; not worth the bundle
 * weight for v1. Steering authors who need glob-level precision can
 * write multiple substring patterns.
 *
 * Returns true when the path matches at least one exclude pattern.
 */
function pathMatchesAnyExclude(filepath, excludePatterns) {
    if (excludePatterns.length === 0) {
        return false;
    }
    const normalized = filepath.replace(/\\/g, '/');
    return excludePatterns.some((pattern) => {
        const trimmed = pattern.trim();
        if (!trimmed) {
            return false;
        }
        const normPattern = trimmed.replace(/\\/g, '/');
        return normalized.includes(normPattern);
    });
}
/**
 * Gets the most relevant context for a target query.
 *
 * P1.3 changes:
 *   - Accepts optional `opts.excludePatterns` so callers (typically
 *     SidebarProvider with steering loaded) can hide files the
 *     project conventions say not to read.
 *   - Accepts optional `opts.topN` to tune the result count.
 *   - Legacy single-arg callers behave exactly as before.
 */
function getSmartASTContext(query, opts = {}) {
    const correlatedNodes = calculateGraphCorrelation(query);
    const excludePatterns = opts.excludePatterns ?? [];
    const topN = opts.topN ?? 5;
    // Exclude is applied AFTER correlation but BEFORE topN so the
    // top-5 are 5 non-excluded files, not 5 - excluded.
    const filtered = excludePatterns.length > 0
        ? correlatedNodes.filter((c) => !pathMatchesAnyExclude(c.filepath, excludePatterns))
        : correlatedNodes;
    //  THE FIX: Inject the [Score:] prefix so SidebarProvider.ts can parse it for the UI!
    return filtered.slice(0, topN).map(c => `[Score: ${c.score}] 📍 ${c.filepath} (${c.reasons.join(', ')})\nExports: ${c.node.exports.join(', ')}\nClasses: ${c.node.classes.join(', ')}\nFunctions: ${c.node.functions.join(', ')}`).join('\n\n');
}
//# sourceMappingURL=codeGraph.js.map