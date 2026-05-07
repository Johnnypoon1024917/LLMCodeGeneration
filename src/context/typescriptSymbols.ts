// src/context/typescriptSymbols.ts
//
// V2.3 bundle 4 (TypeScript-only stepping-stone): extract exported
// symbols from TypeScript files in node_modules so the Coder's
// system prompt can include actual available types. Targets the
// "phantom Prisma type" failure mode (Prisma.BookingWhereInput
// phantom because the installed Prisma version doesn't export it).
//
// This is a pragmatic substitute for the full bundle 4 plan
// (Tree-Sitter symbol-graph context for multi-language). The full
// plan is ~1 week; this stepping-stone ships value today using
// the TypeScript compiler API which is already a dependency.
//
// Strategy:
// 1. For a small whitelist of "high-value" packages where type
//    drift is most painful (Prisma client being the canonical
//    example), find the package's main .d.ts.
// 2. Extract top-level exported names + a one-line signature.
// 3. Render as a prompt section.
//
// What this does NOT do:
// - Multi-language (Python/Go/Rust) — comes with bundle 4-real
// - Dynamic per-task symbol selection — we render a static set
// - Deep type analysis (e.g., field-level extraction) — only top-
//   level exports
// - Symbol-graph traversal (callers, callees) — a real bundle 4
//   feature, deferred
//
// Why this still helps: production logs showed Prisma.BookingWhereInput
// phantom and similar "namespace has no exported member" errors. Just
// listing "these are the actual exports of @prisma/client" prevents
// the Coder from inventing names from training data.

import * as vscode from 'vscode';
import { log } from '../logger';

/**
 * Packages whose .d.ts we eagerly extract for the Coder. Keep this
 * list short — every package added is more tokens injected into
 * every Coder turn. Add only when:
 *   - The package has aggressive type drift between major versions
 *   - We've seen the model phantom-import or phantom-reference its
 *     types in production logs
 *   - The package is very common in target customer projects
 */
const HIGH_VALUE_PACKAGES = [
    '@prisma/client',     // BookingWhereInput phantom in production
    'express',            // request/response types vary by version
    'zod',                // schema types prone to API drift
];

interface ExtractedSymbol {
    /** Exported name as it appears in the .d.ts. */
    name: string;
    /** What kind of declaration: 'class' | 'interface' | 'type' |
     *  'enum' | 'function' | 'const' | 'namespace' | 'unknown' */
    kind: string;
}

interface PackageSymbols {
    packageName: string;
    version: string;
    symbols: ExtractedSymbol[];
}

/**
 * Heuristic exported-name extractor over .d.ts text. We use regex
 * rather than the TypeScript compiler API because:
 *   1. Compiler API is heavy to spin up per-call
 *   2. We only need top-level names, not deep type info
 *   3. Regex over .d.ts is robust enough for declaration files
 *      (which have a stable, predictable shape)
 *
 * Patterns matched:
 *   export class X
 *   export interface X
 *   export type X =
 *   export enum X
 *   export function X
 *   export const X
 *   export declare class X
 *   export declare namespace X
 *   export { X, Y, Z }   (re-exports — matched separately)
 *
 * Limitations:
 *   - Doesn't handle "export default" (rare in .d.ts files)
 *   - Doesn't follow re-exports recursively (top-level only)
 *   - Comments containing "export class Foo" would false-match,
 *     but in practice that's rare in generated .d.ts files
 */
function extractSymbolsFromDts(content: string): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    const seen = new Set<string>();

    // Pattern 1: "export [declare] <kind> <name>"
    const declarePattern = /^\s*export\s+(?:declare\s+)?(class|interface|type|enum|function|const|let|var|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = declarePattern.exec(content)) !== null) {
        const [, kind, name] = m;
        if (name && !seen.has(name)) {
            seen.add(name);
            symbols.push({ name, kind: kind || 'unknown' });
        }
    }

    // Pattern 2: "export { Name1, Name2 }" re-exports.
    const reexportPattern = /^\s*export\s*\{\s*([^}]+)\s*\}/gm;
    while ((m = reexportPattern.exec(content)) !== null) {
        const list = m[1] || '';
        for (const part of list.split(',')) {
            const cleaned = part.trim().split(/\s+as\s+/)[1] ?? part.trim().split(/\s+as\s+/)[0];
            if (cleaned && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned) && !seen.has(cleaned)) {
                seen.add(cleaned);
                symbols.push({ name: cleaned, kind: 'reexport' });
            }
        }
    }

    return symbols;
}

/**
 * Read a high-value package's .d.ts and extract its top-level exports.
 * Returns null if the package isn't installed or its .d.ts can't be
 * read. Best-effort — never throws.
 */
async function readPackageSymbols(workspaceRoot: vscode.Uri, packageName: string): Promise<PackageSymbols | null> {
    try {
        // Resolve the package's main .d.ts. Most packages put types at:
        //   node_modules/<name>/index.d.ts
        // Some put them at a custom location declared in package.json
        // ("types" field). For this stepping-stone, we only check the
        // common index.d.ts location — if a package uses a custom
        // path we won't extract its symbols. Acceptable trade-off for
        // an ~hour fix vs the full compiler-API integration.
        const pkgPath = vscode.Uri.joinPath(workspaceRoot, 'node_modules', packageName);
        let pkgJson: { version?: string; types?: string; typings?: string };
        try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(pkgPath, 'package.json'));
            pkgJson = JSON.parse(new TextDecoder().decode(data));
        } catch {
            return null; // package not installed
        }

        const dtsPath = pkgJson.types || pkgJson.typings || 'index.d.ts';
        const dtsUri = vscode.Uri.joinPath(pkgPath, dtsPath);
        let content: string;
        try {
            const data = await vscode.workspace.fs.readFile(dtsUri);
            content = new TextDecoder().decode(data);
        } catch {
            // .d.ts missing — package may not ship types
            return null;
        }

        // Cap content size — very large .d.ts files (Prisma's can be
        // 1MB+) blow the regex matcher and waste prompt tokens. We
        // grab the first 100KB which usually has the top-level
        // exports declared near the top of the file.
        const MAX_DTS_BYTES = 100_000;
        if (content.length > MAX_DTS_BYTES) {
            content = content.slice(0, MAX_DTS_BYTES);
        }

        const symbols = extractSymbolsFromDts(content);
        return {
            packageName,
            version: pkgJson.version || 'unknown',
            symbols,
        };
    } catch (e) {
        log.warn(`[readPackageSymbols] ${packageName} failed:`, String(e));
        return null;
    }
}

/**
 * Detect symbols for all high-value packages in the workspace.
 * Best-effort — packages not installed are silently skipped.
 */
export async function detectHighValueSymbols(workspaceRoot: vscode.Uri): Promise<PackageSymbols[]> {
    const results: PackageSymbols[] = [];
    for (const pkg of HIGH_VALUE_PACKAGES) {
        const result = await readPackageSymbols(workspaceRoot, pkg);
        if (result && result.symbols.length > 0) {
            results.push(result);
        }
    }
    return results;
}

/**
 * Render symbols as a prompt section. Returns empty string when
 * nothing useful to say.
 *
 * Format:
 *   ════════════════════════════════════════════════════════
 *   AVAILABLE TYPE SYMBOLS (use these, not training-data names)
 *   ════════════════════════════════════════════════════════
 *   @prisma/client@5.10.2:
 *     class: PrismaClient, Prisma
 *     type: BookingCreateInput, BookingUpdateInput, BookingWhereUniqueInput
 *     enum: SortOrder
 *
 *   express@4.18.2:
 *     interface: Request, Response, NextFunction, Express, Router
 *     ...
 *
 *   Rules:
 *   1. If you reference a type from these packages, use a name that
 *      appears above. Do NOT invent type names from training data.
 *   2. If you need a type that ISN'T listed but you believe should
 *      exist, run read_file on the package's index.d.ts to verify
 *      before using it.
 *
 * Output is bounded — we cap the per-package symbol count to keep
 * total injected tokens reasonable.
 */
export function renderSymbolsPromptSection(packages: PackageSymbols[]): string {
    if (packages.length === 0) { return ''; }

    const SYMBOLS_PER_PACKAGE = 50;

    const sections: string[] = [];
    sections.push('═══════════════════════════════════════════════════════════════════════');
    sections.push('AVAILABLE TYPE SYMBOLS (use these names, not training-data assumptions)');
    sections.push('═══════════════════════════════════════════════════════════════════════');

    for (const pkg of packages) {
        sections.push(`${pkg.packageName}@${pkg.version}:`);
        // Group by kind for readability.
        const byKind: Record<string, string[]> = {};
        for (const sym of pkg.symbols.slice(0, SYMBOLS_PER_PACKAGE)) {
            const kind = sym.kind;
            if (!byKind[kind]) { byKind[kind] = []; }
            byKind[kind]!.push(sym.name);
        }
        for (const kind of Object.keys(byKind).sort()) {
            const names = byKind[kind]!;
            sections.push(`  ${kind}: ${names.join(', ')}`);
        }
        if (pkg.symbols.length > SYMBOLS_PER_PACKAGE) {
            sections.push(`  ... and ${pkg.symbols.length - SYMBOLS_PER_PACKAGE} more (truncated; use read_file on the .d.ts for full list)`);
        }
        sections.push('');
    }

    sections.push('Rules:');
    sections.push('1. Reference type names that appear above. Training-data names may be wrong');
    sections.push('   for the installed version (Prisma\'s namespace exports drift across versions).');
    sections.push('2. If you need a type not listed but believe it should exist, read_file the');
    sections.push('   package\'s .d.ts to verify before using it.');
    sections.push('3. The list above is truncated to top-level exports. Nested namespace members');
    sections.push('   (e.g., Prisma.SomeNestedType) are NOT listed — read the .d.ts if needed.');
    sections.push('');

    return sections.join('\n');
}   