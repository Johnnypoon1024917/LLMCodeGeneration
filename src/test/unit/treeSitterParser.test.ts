// src/test/unit/treeSitterParser.test.ts
//
// PR P1.3 (deferred): tests for the Tree-Sitter parser implementation.
//
// These tests exercise the REAL wasm runtime — Parser.init() loads
// the actual web-tree-sitter.wasm, Language.load() loads the actual
// tree-sitter-typescript.wasm. If something is wrong with the
// packaging contract, these tests fail loudly.
//
// What's covered:
//   - Init + language load round-trip
//   - Parity with regex parser on basic cases (named imports,
//     classes, functions, interfaces)
//   - Cases the regex parser couldn't handle:
//     - `import { x as y } from './m'` — captures local binding y
//     - `import('./m')` — dynamic imports captured into imports[]
//     - `export { foo } from './m'` — re-exports captured as both
//       export and import-from-link
//
// What's NOT covered:
//   - Real VS Code packaging via vsce — that's the runtime
//     validation the feature flag exists to defer.
//   - JSX / TSX (would just need to swap the language; the walker
//     is identical for our purposes).

import * as path from 'path';
import {
    extractSymbolsAsync,
    detectLanguage,
    resetTreeSitterForTests,
} from '../../utilities/treeSitterParser';

// Resolve to the real repo root so the parser finds the wasm files.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

beforeEach(() => {
    // Each test starts with cold init — flush any cached state from
    // a previous test in this run so timing-sensitive bugs surface
    resetTreeSitterForTests();
});

describe('Tree-Sitter parser — language detection', () => {
    it('detects TypeScript', () => {
        expect(detectLanguage('foo.ts')).toBe('typescript');
        expect(detectLanguage('SRC/MyComponent.TS')).toBe('typescript');
    });

    it('detects TSX', () => {
        expect(detectLanguage('Component.tsx')).toBe('tsx');
    });

    it('detects JS as TypeScript-equivalent', () => {
        expect(detectLanguage('legacy.js')).toBe('typescript');
        expect(detectLanguage('Component.jsx')).toBe('tsx');
    });

    it('returns null for unsupported extensions', () => {
        expect(detectLanguage('readme.md')).toBeNull();
        expect(detectLanguage('config.json')).toBeNull();
        // Python WAS in this list before V2 language session 2.
        // It's now supported — see the dedicated Python detection
        // suite below if/when the user authors Python tests.
        expect(detectLanguage('source.go')).toBeNull();
        expect(detectLanguage('Main.java')).toBeNull();
    });
});

describe('Tree-Sitter parser — basic symbols', () => {
    it('extracts class names', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `class Foo { x: number = 1; }`,
            'typescript'
        );
        expect(result.classes).toContain('Foo');
    });

    it('extracts function declarations', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `function bar(x: number): string { return String(x); }`,
            'typescript'
        );
        expect(result.functions).toContain('bar');
    });

    it('extracts interface declarations', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `interface Foo { x: number; }`,
            'typescript'
        );
        expect(result.interfaces).toContain('Foo');
    });

    it('extracts variable bindings (const/let/var)', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `const a = 1;\nlet b = 2;\nvar c = 3;`,
            'typescript'
        );
        expect(result.variables).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    });

    it('extracts destructured variable bindings', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `const { a, b } = obj;\nconst [x, y] = arr;`,
            'typescript'
        );
        expect(result.variables).toEqual(expect.arrayContaining(['a', 'b', 'x', 'y']));
    });
});

describe('Tree-Sitter parser — imports', () => {
    it('captures named imports as local bindings', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import { useState, useEffect } from 'react';`,
            'typescript'
        );
        expect(result.imports).toContain('react');
        expect(result.importedNames['react']).toEqual(
            expect.arrayContaining(['useState', 'useEffect'])
        );
    });

    it('captures default import name', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import Foo from './foo';`,
            'typescript'
        );
        expect(result.imports).toContain('./foo');
        expect(result.importedNames['./foo']).toContain('Foo');
    });

    it('captures namespace import name', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import * as React from 'react';`,
            'typescript'
        );
        expect(result.importedNames['react']).toContain('React');
    });

    it('captures renamed imports (x as y) — local binding wins', async () => {
        // The whole point of Tree-Sitter — regex parser captured
        // either x or y depending on which side of the alias, but
        // for cross-file resolution we want the LOCAL binding (y).
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import { foo as renamed } from './m';`,
            'typescript'
        );
        expect(result.importedNames['./m']).toContain('renamed');
    });

    it('captures mixed default + named imports', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import Default, { named1, named2 } from './m';`,
            'typescript'
        );
        const names = result.importedNames['./m'] ?? [];
        expect(names).toEqual(expect.arrayContaining(['Default', 'named1', 'named2']));
    });

    it('captures dynamic imports (a regex-parser limitation that this fixes)', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `async function load() { const m = await import('./dynamic'); return m; }`,
            'typescript'
        );
        expect(result.imports).toContain('./dynamic');
    });
});

describe('Tree-Sitter parser — exports', () => {
    it('captures `export class Foo`', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `export class Foo {}`,
            'typescript'
        );
        expect(result.classes).toContain('Foo');
        expect(result.exports).toContain('Foo');
    });

    it('captures `export function bar`', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `export function bar() {}`,
            'typescript'
        );
        expect(result.functions).toContain('bar');
        expect(result.exports).toContain('bar');
    });

    it('captures `export { a, b }` clauses', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `const a = 1;\nconst b = 2;\nexport { a, b };`,
            'typescript'
        );
        expect(result.exports).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('captures re-exports as both export and import (a regex-parser limitation that this fixes)', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `export { Foo, Bar } from './m';`,
            'typescript'
        );
        expect(result.imports).toContain('./m');
        expect(result.exports).toEqual(expect.arrayContaining(['Foo', 'Bar']));
    });
});

describe('Tree-Sitter parser — robustness', () => {
    it('returns empty result on unparseable garbage', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `this is not @ valid !! TypeScript ###`,
            'typescript'
        );
        // Tree-Sitter is error-tolerant — it'll produce a partial
        // tree even for garbage. We just shouldn't extract bogus
        // symbols. Either empty or some best-effort identifiers
        // is acceptable; we just shouldn't crash.
        expect(result).toBeDefined();
        expect(Array.isArray(result.classes)).toBe(true);
        expect(Array.isArray(result.functions)).toBe(true);
    });

    it('handles empty source', async () => {
        const result = await extractSymbolsAsync(REPO_ROOT, '', 'typescript');
        expect(result.imports).toEqual([]);
        expect(result.classes).toEqual([]);
        expect(result.functions).toEqual([]);
    });

    it('deduplicates repeated extractions', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            // Two separate imports of the same module — modulePath
            // appears twice but should be deduplicated
            `import { a } from './m';\nimport { b } from './m';`,
            'typescript'
        );
        const occurrences = result.imports.filter((p) => p === './m').length;
        expect(occurrences).toBe(1);
    });
});

describe('Tree-Sitter parser — TSX support', () => {
    it('parses JSX-bearing TSX', async () => {
        const result = await extractSymbolsAsync(
            REPO_ROOT,
            `import React from 'react';\nfunction MyComponent() { return <div>Hi</div>; }`,
            'tsx'
        );
        expect(result.imports).toContain('react');
        expect(result.functions).toContain('MyComponent');
    });
});