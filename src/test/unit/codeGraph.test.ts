// src/test/unit/codeGraph.test.ts
//
// PR P1.3: tests for the workspace code-graph correlator.
//
// Coverage:
//   - pathMatchesAnyExclude: pure substring matcher
//   - resolveImportPath: relative-to-absolute resolution with the
//     extension probing
//   - calculateGraphCorrelation: P1.3's caller/callee scoring
//   - getSmartASTContext: opts.excludePatterns + opts.topN
//
// Because calculateGraphCorrelation reads module-global state, every
// test resets the graph via clearWorkspaceGraph in beforeEach.

import {
    addFileToGraph,
    calculateGraphCorrelation,
    clearWorkspaceGraph,
    getSmartASTContext,
    pathMatchesAnyExclude,
    resolveImportPath
} from '../../context/codeGraph';

describe('pathMatchesAnyExclude', () => {
    it('returns false for empty pattern list', () => {
        expect(pathMatchesAnyExclude('/repo/src/foo.ts', [])).toBe(false);
    });

    it('matches when pattern is a substring of the path', () => {
        expect(pathMatchesAnyExclude('/repo/legacy/foo.ts', ['legacy/'])).toBe(true);
    });

    it('does not match when no pattern is found', () => {
        expect(pathMatchesAnyExclude('/repo/src/foo.ts', ['legacy/', 'generated/'])).toBe(false);
    });

    it('matches against any pattern in the list', () => {
        expect(
            pathMatchesAnyExclude('/repo/generated/types.ts', ['legacy/', 'generated/'])
        ).toBe(true);
    });

    it('normalizes backslashes to forward slashes for cross-platform behavior', () => {
        // Windows-style path with patterns that use forward slashes
        expect(
            pathMatchesAnyExclude('C:\\repo\\src\\legacy\\foo.ts', ['src/legacy/'])
        ).toBe(true);
    });

    it('skips empty pattern strings (defensive — user might have stray bullet)', () => {
        expect(pathMatchesAnyExclude('/repo/foo.ts', ['', '   '])).toBe(false);
    });

    it('is case-sensitive (legacy != Legacy)', () => {
        expect(pathMatchesAnyExclude('/repo/Legacy/foo.ts', ['legacy/'])).toBe(false);
    });
});

describe('resolveImportPath', () => {
    beforeEach(() => clearWorkspaceGraph());

    it('returns null for bare package imports', async () => {
        await addFileToGraph('/repo/src/index.ts', '');
        expect(resolveImportPath('/repo/src/index.ts', 'react')).toBe(null);
        expect(resolveImportPath('/repo/src/index.ts', 'lodash/fp')).toBe(null);
    });

    it('resolves a relative import with explicit extension', async () => {
        await addFileToGraph('/repo/src/index.ts', '');
        await addFileToGraph('/repo/src/foo.ts', '');
        expect(resolveImportPath('/repo/src/index.ts', './foo.ts')).toBe('/repo/src/foo.ts');
    });

    it('resolves a relative import without extension (probes .ts)', async () => {
        await addFileToGraph('/repo/src/index.ts', '');
        await addFileToGraph('/repo/src/foo.ts', '');
        expect(resolveImportPath('/repo/src/index.ts', './foo')).toBe('/repo/src/foo.ts');
    });

    it('resolves to index.ts when import path is a directory', async () => {
        await addFileToGraph('/repo/src/index.ts', '');
        await addFileToGraph('/repo/src/utils/index.ts', '');
        expect(resolveImportPath('/repo/src/index.ts', './utils')).toBe('/repo/src/utils/index.ts');
    });

    it('returns null when nothing in graph matches', async () => {
        await addFileToGraph('/repo/src/index.ts', '');
        expect(resolveImportPath('/repo/src/index.ts', './nonexistent')).toBe(null);
    });

    it('handles Windows-style backslash paths in graph keys', async () => {
        // Production on Windows stores graph keys with backslashes
        // because vscode.Uri.fsPath returns the native separator.
        // The resolver must still match imports written with forward
        // slashes (which is how source code expresses them).
        await addFileToGraph('C:\\repo\\src\\index.ts', '');
        await addFileToGraph('C:\\repo\\src\\foo.ts', '');
        const result = resolveImportPath('C:\\repo\\src\\index.ts', './foo');
        // Return value is the ORIGINAL graph key (preserves the
        // separator the graph was populated with) — callers compare
        // to graph keys, not to normalized paths.
        expect(result).toBe('C:\\repo\\src\\foo.ts');
    });

    it('handles forward-slash importer with backslash graph keys', async () => {
        // Mixed-separator scenario: graph populated with backslashes
        // (Windows production), but the test or some other caller
        // passes forward-slash paths.
        await addFileToGraph('C:\\repo\\src\\index.ts', '');
        await addFileToGraph('C:\\repo\\src\\foo.ts', '');
        // Resolver should match in normalized space and return the
        // original (backslash) key.
        const result = resolveImportPath('C:/repo/src/index.ts', './foo');
        expect(result).toBe('C:\\repo\\src\\foo.ts');
    });
});

describe('calculateGraphCorrelation — P1.3 caller/callee scoring', () => {
    beforeEach(() => clearWorkspaceGraph());

    it('scores the target file as 100', async () => {
        await addFileToGraph('/repo/src/foo.ts', `export const foo = 1;`);
        const results = calculateGraphCorrelation('foo.ts');
        expect(results[0]!.filepath).toBe('/repo/src/foo.ts');
        expect(results[0]!.score).toBe(100);
    });

    it('scores a CALLEE (target imports from it) at 50+', async () => {
        // target = main.ts, it imports from helpers.ts
        await addFileToGraph('/repo/src/main.ts', `
            import { helper } from './helpers';
            helper();
        `);
        await addFileToGraph('/repo/src/helpers.ts', `
            export function helper() {}
        `);
        const results = calculateGraphCorrelation('main.ts');
        const helpersResult = results.find((r) => r.filepath === '/repo/src/helpers.ts');
        expect(helpersResult).toBeDefined();
        expect(helpersResult!.score).toBeGreaterThanOrEqual(50);
        expect(helpersResult!.reasons.some((r) => r.includes('Target uses'))).toBe(true);
    });

    it('scores a CALLER (file imports from target) at 50+ with bonus per used symbol', async () => {
        // target = utils.ts; main.ts imports two symbols from it
        await addFileToGraph('/repo/src/utils.ts', `
            export const a = 1;
            export const b = 2;
        `);
        await addFileToGraph('/repo/src/main.ts', `
            import { a, b } from './utils';
            console.log(a, b);
        `);
        const results = calculateGraphCorrelation('utils.ts');
        const mainResult = results.find((r) => r.filepath === '/repo/src/main.ts');
        expect(mainResult).toBeDefined();
        // 50 base + 5 per symbol × 2 symbols = 60
        expect(mainResult!.score).toBeGreaterThanOrEqual(60);
        expect(mainResult!.reasons.some((r) => r.includes('Uses:'))).toBe(true);
    });

    it('caps the per-symbol bonus at 25 (heavy users dont blow up the score)', async () => {
        // target = util.ts; main.ts imports 10 symbols
        const importedSymbols = Array.from({ length: 10 }, (_, i) => `s${i}`);
        const exportLines = importedSymbols.map((s) => `export const ${s} = 0;`).join('\n');
        await addFileToGraph('/repo/src/util.ts', exportLines);
        await addFileToGraph('/repo/src/main.ts', `
            import { ${importedSymbols.join(', ')} } from './util';
        `);
        const results = calculateGraphCorrelation('util.ts');
        const mainResult = results.find((r) => r.filepath === '/repo/src/main.ts');
        // 50 base + 25 cap = 75 max
        expect(mainResult!.score).toBeLessThanOrEqual(75);
    });

    it('falls back to weak signals when no caller/callee relationship', async () => {
        // No cross-imports — but both share a 'react' import
        await addFileToGraph('/repo/src/foo.ts', `
            import { useState } from 'react';
            interface Common { x: number }
            export const FooData = (): Common => ({ x: 1 });
        `);
        await addFileToGraph('/repo/src/bar.ts', `
            import { useState } from 'react';
            interface Common { x: number }
        `);
        const results = calculateGraphCorrelation('foo.ts');
        const barResult = results.find((r) => r.filepath === '/repo/src/bar.ts');
        // Some weak score — shared import + shared interface
        expect(barResult).toBeDefined();
        expect(barResult!.score).toBeGreaterThan(0);
        // Should be much lower than callee/caller scores
        expect(barResult!.score).toBeLessThan(50);
    });

    it('returns empty when target query matches nothing in the graph', () => {
        const results = calculateGraphCorrelation('does-not-exist');
        expect(results).toEqual([]);
    });

    it('orders results by score descending', async () => {
        await addFileToGraph('/repo/src/target.ts', `
            export const x = 1;
        `);
        // Direct caller
        await addFileToGraph('/repo/src/direct.ts', `
            import { x } from './target';
        `);
        // Just shared import
        await addFileToGraph('/repo/src/weak.ts', `
            import { x } from './target';
        `);
        const results = calculateGraphCorrelation('target.ts');
        // Target is first (100), then callers
        expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
    });
});

describe('getSmartASTContext — P1.3 options', () => {
    beforeEach(() => clearWorkspaceGraph());

    it('returns the legacy format when called without options', async () => {
        await addFileToGraph('/repo/src/foo.ts', `export const foo = 1;`);
        const out = getSmartASTContext('foo.ts');
        expect(out).toContain('[Score: 100]');
        expect(out).toContain('foo.ts');
    });

    it('honors excludePatterns to filter results', async () => {
        await addFileToGraph('/repo/src/main.ts', `
            import { foo } from './foo';
            import { legacy } from '../legacy/old';
        `);
        await addFileToGraph('/repo/src/foo.ts', `export const foo = 1;`);
        await addFileToGraph('/repo/legacy/old.ts', `export const legacy = 1;`);

        const withoutExclude = getSmartASTContext('main.ts');
        const withExclude = getSmartASTContext('main.ts', { excludePatterns: ['legacy/'] });

        // Without exclude, legacy/old.ts should appear as a callee
        expect(withoutExclude).toContain('legacy/old.ts');
        // With exclude, it should be filtered out
        expect(withExclude).not.toContain('legacy/old.ts');
        // foo.ts should still appear
        expect(withExclude).toContain('foo.ts');
    });

    it('honors topN to control result count', async () => {
        await addFileToGraph('/repo/src/target.ts', `export const x = 1;`);
        // Five callers
        for (let i = 0; i < 5; i++) {
            await addFileToGraph(`/repo/src/caller${i}.ts`, `
                import { x } from './target';
            `);
        }
        const top2 = getSmartASTContext('target.ts', { topN: 2 });
        // Count how many [Score:] entries appear — each result has one
        const matches = top2.match(/\[Score:/g) || [];
        expect(matches.length).toBe(2);
    });

    it('returns empty string when target not found', () => {
        expect(getSmartASTContext('does-not-exist')).toBe('');
    });
});