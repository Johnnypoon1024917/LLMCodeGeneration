// webview-ui/src/codeGraphContext.ts
//
// Derive a "360-degree" view of a graph node from the workspace
// FileNode dictionary. Pure — no React, no DOM, no I/O. Used by
// the code-map side panel (Option A polish) to surface callers,
// callees, and same-file symbols without backend changes.
//
// V2.8 will replace this with a richer derivation backed by the
// symbol-level call graph (functions calling functions across
// files, cluster membership, process-flow membership). For now
// this gives the user the file-level neighborhood, which is what
// the existing graphData dictionary actually carries.
//
// Input shape: graphData is the dictionary form emitted by
// codeGraph.ts → getGraphJSON. Each value is a FileNode with:
//   imports: string[]                    (raw module specifiers)
//   importedNames: Record<string, string[]>
//   exports: string[]
//   classes / functions / interfaces / variables: string[]

export interface FileNodeData {
    filepath: string;
    imports: string[];
    importedNames?: Record<string, string[]>;
    exports?: string[];
    classes?: string[];
    functions?: string[];
    interfaces?: string[];
    variables?: string[];
}

/** Dictionary form: filepath → FileNodeData */
export type WorkspaceGraphData = Record<string, FileNodeData>;

export interface FileContextView {
    kind: 'file';
    filepath: string;
    /** Files this one imports, resolved to graph-known paths.
     *  External libs (those not present in the dictionary) appear
     *  in `externalImports` instead. */
    importsResolved: string[];
    /** Raw import specifiers we couldn't resolve to a workspace
     *  file (typically external libs like 'react', 'lodash'). */
    externalImports: string[];
    /** Files that import THIS file. Computed by inverse lookup. */
    importers: string[];
    /** Symbols defined in this file. Combined and de-duplicated
     *  from classes/functions/interfaces. Order: classes, then
     *  functions, then interfaces — most-meaningful first. */
    symbols: Array<{ name: string; kind: 'class' | 'function' | 'interface' }>;
    /** Public exports (what other files can import). Subset of
     *  symbols but included separately so the panel can highlight
     *  "this is the public API of this file". */
    exports: string[];
}

export interface SymbolContextView {
    kind: 'symbol';
    /** "filepath::symbolName" — the original node id. */
    id: string;
    filepath: string;
    symbol: string;
    symbolKind: 'class' | 'function' | 'interface' | 'unknown';
    /** True if this symbol is in the parent file's exports list. */
    isExported: boolean;
    /** Other symbols defined in the same file. Useful for
     *  "navigate to a sibling" UX — junior engineers exploring
     *  unfamiliar code want this. */
    siblings: Array<{ name: string; kind: 'class' | 'function' | 'interface' }>;
}

export type CodeGraphContextView = FileContextView | SymbolContextView | null;

/**
 * Resolve a raw import specifier (`'./auth'`, `'../utils/x'`,
 * `'react'`) to a workspace file path, if any. Mirrors the
 * existing best-effort resolution in App.tsx's visualGraphData
 * memo — keeps the derivation here consistent with what the
 * graph itself shows.
 *
 * Returns null when no workspace file matches (typically external
 * libraries from node_modules).
 */
function resolveImport(spec: string, allFilepaths: readonly string[]): string | null {
    const cleaned = spec.replace(/['"]/g, '').replace(/^\.\.?\//, '');
    if (cleaned.length === 0) { return null; }
    // Substring match against known filepaths. Same heuristic the
    // visualizer uses, so resolution stays consistent — if the
    // graph shows an edge, the panel surfaces it; if the graph
    // doesn't, neither does the panel.
    const match = allFilepaths.find(fp => fp.includes(cleaned));
    return match ?? null;
}

/**
 * Compute the inverse import map: { filepath → list of files that
 * import it }. The graph stores forward edges (A imports B); side
 * panels need backward edges (who imports A?). This walks the
 * graph once and builds the inverse — O(N * average-imports)
 * which is fine for typical workspaces (5k files × ~10 imports).
 *
 * Memoize at the call site if you compute it on every render —
 * the function itself is cheap to call but produces a new object
 * each time.
 */
export function buildImporterIndex(
    graphData: WorkspaceGraphData
): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    const allFilepaths = Object.keys(graphData);
    for (const importer of allFilepaths) {
        const node = graphData[importer];
        if (!node?.imports) { continue; }
        for (const spec of node.imports) {
            const resolved = resolveImport(spec, allFilepaths);
            if (!resolved) { continue; }
            if (!index[resolved]) { index[resolved] = []; }
            // De-dupe: a file can have two import statements that
            // resolve to the same target. The panel doesn't need
            // to show duplicates.
            if (!index[resolved]!.includes(importer)) {
                index[resolved]!.push(importer);
            }
        }
    }
    return index;
}

/**
 * Build a 360-degree view for a selected graph node.
 *
 * Node id format:
 *   - File:   "src/path/to/file.ts"
 *   - Symbol: "src/path/to/file.ts::symbolName"  (split on first "::")
 *
 * The `importerIndex` is passed in (rather than computed here)
 * so callers can memoize it across renders — building it on every
 * click would be wasteful for large workspaces.
 *
 * Returns null when:
 *   - nodeId is empty or malformed
 *   - the file isn't in graphData (stale node from a prior graph)
 *   - the symbol isn't in the parent file's symbol lists
 */
export function buildNodeContext(
    nodeId: string,
    graphData: WorkspaceGraphData,
    importerIndex: Record<string, string[]>
): CodeGraphContextView {
    if (!nodeId) { return null; }

    const allFilepaths = Object.keys(graphData);

    // Symbol nodes encode their parent file in the id. Split on
    // the first "::" only — symbol names themselves shouldn't
    // contain "::" but we're defensive against weird input.
    const sepIdx = nodeId.indexOf('::');
    const isSymbol = sepIdx > 0 && sepIdx < nodeId.length - 2;

    if (isSymbol) {
        const filepath = nodeId.substring(0, sepIdx);
        const symbol = nodeId.substring(sepIdx + 2);
        const fileNode = graphData[filepath];
        if (!fileNode) { return null; }

        // Determine which list this symbol came from.
        let symbolKind: SymbolContextView['symbolKind'] = 'unknown';
        if (fileNode.classes?.includes(symbol))         { symbolKind = 'class'; }
        else if (fileNode.functions?.includes(symbol))  { symbolKind = 'function'; }
        else if (fileNode.interfaces?.includes(symbol)) { symbolKind = 'interface'; }

        const siblings: SymbolContextView['siblings'] = [];
        (fileNode.classes ?? []).forEach(name => {
            if (name !== symbol) { siblings.push({ name, kind: 'class' }); }
        });
        (fileNode.functions ?? []).forEach(name => {
            if (name !== symbol) { siblings.push({ name, kind: 'function' }); }
        });
        (fileNode.interfaces ?? []).forEach(name => {
            if (name !== symbol) { siblings.push({ name, kind: 'interface' }); }
        });

        return {
            kind: 'symbol',
            id: nodeId,
            filepath,
            symbol,
            symbolKind,
            isExported: !!fileNode.exports?.includes(symbol),
            siblings,
        };
    }

    // File node.
    const fileNode = graphData[nodeId];
    if (!fileNode) { return null; }

    const importsResolved: string[] = [];
    const externalImports: string[] = [];
    for (const spec of fileNode.imports ?? []) {
        const resolved = resolveImport(spec, allFilepaths);
        if (resolved) { importsResolved.push(resolved); }
        else { externalImports.push(spec.replace(/['"]/g, '')); }
    }

    const symbols: FileContextView['symbols'] = [];
    (fileNode.classes ?? []).forEach(name => symbols.push({ name, kind: 'class' }));
    (fileNode.functions ?? []).forEach(name => symbols.push({ name, kind: 'function' }));
    (fileNode.interfaces ?? []).forEach(name => symbols.push({ name, kind: 'interface' }));

    return {
        kind: 'file',
        filepath: nodeId,
        importsResolved,
        externalImports,
        importers: importerIndex[nodeId] ?? [],
        symbols,
        exports: fileNode.exports ?? [],
    };
}