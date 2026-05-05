import * as vscode from 'vscode';
import * as path from 'path';
import { ASTParser } from '../utilities/astParser';
import { log } from '../logger';

export interface FileNode {
    filepath: string;
    imports: string[];
    /** P1.3: per-module imported identifiers, keyed by module path.
     *  Distinguishes "F imports something from G" (path-only) from
     *  "F uses `foo` from G" (symbol-aware). Drives the
     *  callers/callees scoring below. Empty values mean the parser
     *  couldn't resolve the names (default + namespace imports). */
    importedNames: Record<string, string[]>;
    exports: string[];
    classes: string[];
    functions: string[];
    interfaces: string[];
    variables: string[];
}

let workspaceGraph = new Map<string, FileNode>();

export interface ScoredNode {
    filepath: string;
    score: number;
    reasons: string[];
    node: FileNode;
}

/**
 * Parses file content and adds it to the workspace graph using AST
 */
export async function addFileToGraph(filepath: string, content: string) {
    const symbols = ASTParser.extractSymbols(content);

    const node: FileNode = {
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
export function clearWorkspaceGraph(): void {
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
export function resolveImportPath(importerPath: string, importPath: string): string | null {
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
    const stack: string[] = [];
    for (const seg of segments) {
        if (seg === '' || seg === '.') {
            // Preserve leading empty segment (POSIX absolute root)
            // by pushing it once at the start; ignore others.
            if (stack.length === 0 && seg === '') { stack.push(''); }
            continue;
        }
        if (seg === '..') {
            if (stack.length > 1) { stack.pop(); }
            continue;
        }
        stack.push(seg);
    }
    const baseResolved = stack.join('/');

    // Try in order: exact-as-given, then with extensions, then index files.
    const candidates: string[] = [
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
    const normalizedKeys = new Map<string, string>();
    for (const key of workspaceGraph.keys()) {
        normalizedKeys.set(key.replace(/\\/g, '/'), key);
    }

    for (const candidate of candidates) {
        const original = normalizedKeys.get(candidate);
        if (original !== undefined) { return original; }
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
export function calculateGraphCorrelation(targetFileQuery: string): ScoredNode[] {
    const results: ScoredNode[] = [];
    const targetKey = Array.from(workspaceGraph.keys()).find(k => k.includes(targetFileQuery));

    if (!targetKey) { return []; }

    const targetNode = workspaceGraph.get(targetKey)!;
    const cleanTarget = targetKey.replace(/\.[^/.]+$/, ""); // Strip extensions for import matching

    // P1.3: pre-compute the target's RESOLVED imports (callees) so we
    // can match against them in the per-file loop. Resolved-callees is
    // a Set<absolutePath> of files the target imports from.
    const targetCalleePaths = new Set<string>();
    for (const importPath of targetNode.imports) {
        const resolved = resolveImportPath(targetKey, importPath);
        if (resolved) { targetCalleePaths.add(resolved); }
    }

    for (const [filepath, node] of workspaceGraph.entries()) {
        if (filepath === targetKey) {
            results.push({ filepath, score: 100, reasons: ['📍 Target File'], node });
            continue;
        }

        let score = 0;
        const reasons: string[] = [];

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
            const importPath = targetNode.imports.find(
                (ip) => resolveImportPath(targetKey, ip) === filepath
            );
            const usedNames = importPath
                ? (targetNode.importedNames[importPath] || [])
                : [];
            if (usedNames.length > 0) {
                reasons.push(`⬇️ Target uses: ${usedNames.slice(0, 5).join(', ')}`);
            } else {
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
            } else {
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
export async function buildWorkspaceGraph(rootUri?: vscode.Uri) {
    // If a rootUri is provided, scope the search to that folder. Otherwise, search everywhere.
    const searchPattern = rootUri ? new vscode.RelativePattern(rootUri, '**/*.{ts,tsx,js,jsx}') : '**/*.{ts,tsx,js,jsx}';
    
    const files = await vscode.workspace.findFiles(searchPattern, '**/node_modules/**');
    
    for (const file of files) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            await addFileToGraph(file.fsPath, doc.getText());
        } catch (e) {
            log.warn(`Failed to parse ${file.fsPath} for GraphRAG`);
        }
    }
}

/**
 * Returns the graph as a JSON string for the Webview UI
 */
export function getGraphJSON(): string {
    const obj: Record<string, FileNode> = {};
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
export function pathMatchesAnyExclude(filepath: string, excludePatterns: ReadonlyArray<string>): boolean {
    if (excludePatterns.length === 0) { return false; }
    const normalized = filepath.replace(/\\/g, '/');
    return excludePatterns.some((pattern) => {
        const trimmed = pattern.trim();
        if (!trimmed) { return false; }
        const normPattern = trimmed.replace(/\\/g, '/');
        return normalized.includes(normPattern);
    });
}

/**
 * P1.3: options for getSmartASTContext.
 *
 * Adding a single optional opts parameter (rather than overloading the
 * function signature) keeps the no-config path unchanged for legacy
 * callers — they just pass the query string. New callers that have
 * steering data pass `{ excludePatterns: [...] }`.
 */
export interface SmartContextOptions {
    /** P1.3: paths matching any of these substrings are filtered out
     *  of the result set BEFORE ranking. Used by the steering layer
     *  to honor "never include legacy/" rules. Empty array = no filter.
     *
     *  See `pathMatchesAnyExclude` for the matching semantics. */
    excludePatterns?: ReadonlyArray<string>;
    /** P1.3: how many top results to include in the formatted output.
     *  Default 5 (matches legacy behavior). Increase for richer
     *  context, decrease for tighter token budget. */
    topN?: number;
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
export function getSmartASTContext(query: string, opts: SmartContextOptions = {}): string {
    const correlatedNodes = calculateGraphCorrelation(query);
    const excludePatterns = opts.excludePatterns ?? [];
    const topN = opts.topN ?? 5;

    // Exclude is applied AFTER correlation but BEFORE topN so the
    // top-5 are 5 non-excluded files, not 5 - excluded.
    const filtered = excludePatterns.length > 0
        ? correlatedNodes.filter((c) => !pathMatchesAnyExclude(c.filepath, excludePatterns))
        : correlatedNodes;

    //  THE FIX: Inject the [Score:] prefix so SidebarProvider.ts can parse it for the UI!
    return filtered.slice(0, topN).map(c =>
        `[Score: ${c.score}] 📍 ${c.filepath} (${c.reasons.join(', ')})\nExports: ${c.node.exports.join(', ')}\nClasses: ${c.node.classes.join(', ')}\nFunctions: ${c.node.functions.join(', ')}`
    ).join('\n\n');
}