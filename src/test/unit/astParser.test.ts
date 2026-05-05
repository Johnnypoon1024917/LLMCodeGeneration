// src/test/unit/astParser.test.ts
//
// PR P1.3: tests for the regex-based AST parser.
//
// Original coverage gap: ASTParser had no unit tests despite being the
// foundation of codeGraph. P1.3 adds:
//   - importedNames extraction (the new field)
//   - "x as y" alias handling
//   - default + namespace imports (which lose names but should still
//     register the path)
//   - the legacy fields (imports, exports, classes, functions,
//     interfaces) keep working — guards against regression
//
// What this test does NOT cover:
//   - Real Tree-Sitter parsing (deferred to v2 — see SwapTreeSitterNote)
//   - Dynamic imports (`import('./m')`) — known limitation
//   - Re-exports (`export { foo } from './m'`) — known limitation

import { ASTParser } from '../../utilities/astParser';

describe('ASTParser.extractSymbols — imports', () => {
    it('extracts named imports with module path and identifier list', () => {
        const result = ASTParser.extractSymbols(
            `import { foo, bar, baz } from './module';`
        );
        expect(result.imports).toContain('./module');
        expect(result.importedNames['./module']).toEqual(['foo', 'bar', 'baz']);
    });

    it('handles "x as y" rename — captures the LOCAL name', () => {
        const result = ASTParser.extractSymbols(
            `import { foo as Foo, bar as Bar } from './m';`
        );
        // The local name (Foo, Bar) is what the importing file
        // actually references — that's what matters for callee
        // analysis. The original (foo, bar) is lost; Tree-Sitter
        // would catch this.
        expect(result.importedNames['./m']).toEqual(['Foo', 'Bar']);
    });

    it('captures default import local binding name', () => {
        const result = ASTParser.extractSymbols(
            `import Foo from './m';`
        );
        expect(result.imports).toContain('./m');
        // The local binding is what matters for cross-file resolution
        // — usages of `Foo` in this file refer back to `./m`.
        expect(result.importedNames['./m']).toEqual(['Foo']);
    });

    it('captures namespace import local binding name', () => {
        const result = ASTParser.extractSymbols(
            `import * as Foo from './m';`
        );
        expect(result.imports).toContain('./m');
        expect(result.importedNames['./m']).toEqual(['Foo']);
    });

    it('handles multiple imports from different modules', () => {
        const code = `
            import { useState } from 'react';
            import { Foo } from './foo';
            import Bar from './bar';
            import * as Baz from './baz';
        `;
        const result = ASTParser.extractSymbols(code);
        expect(result.imports).toEqual(
            expect.arrayContaining(['react', './foo', './bar', './baz'])
        );
        expect(result.importedNames['react']).toEqual(['useState']);
        expect(result.importedNames['./foo']).toEqual(['Foo']);
        // Default + namespace imports now capture their local names
        expect(result.importedNames['./bar']).toEqual(['Bar']);
        expect(result.importedNames['./baz']).toEqual(['Baz']);
    });

    it('captures both default and named for mixed imports', () => {
        const result = ASTParser.extractSymbols(
            `import Foo, { bar, baz } from './m';`
        );
        expect(result.imports).toContain('./m');
        // Both the default name AND the named imports
        expect(result.importedNames['./m']).toEqual(
            expect.arrayContaining(['Foo', 'bar', 'baz'])
        );
        expect(result.importedNames['./m']).toHaveLength(3);
    });

    it('deduplicates imports from the same module', () => {
        // This isn't real source code (TS would error on duplicate
        // imports), but the parser should be defensive about it
        // since user files can be malformed.
        const code = `
            import { Foo } from './m';
            import { Bar } from './m';
        `;
        const result = ASTParser.extractSymbols(code);
        const occurrences = result.imports.filter((p) => p === './m').length;
        expect(occurrences).toBe(1);
    });

    it('strips comments before parsing', () => {
        const code = `
            // import { secret } from './fake';
            /* import { hidden } from './fake'; */
            import { real } from './real';
        `;
        const result = ASTParser.extractSymbols(code);
        expect(result.imports).not.toContain('./fake');
        expect(result.imports).toContain('./real');
    });
});

describe('ASTParser.extractSymbols — other symbol kinds', () => {
    it('extracts classes', () => {
        const result = ASTParser.extractSymbols(`
            class Foo {}
            class Bar extends Baz {}
        `);
        expect(result.classes).toContain('Foo');
        expect(result.classes).toContain('Bar');
    });

    it('extracts function declarations', () => {
        const result = ASTParser.extractSymbols(`
            function foo() {}
            function bar(a, b) {}
        `);
        expect(result.functions).toContain('foo');
        expect(result.functions).toContain('bar');
    });

    it('extracts arrow functions assigned to const/let/var', () => {
        const result = ASTParser.extractSymbols(`
            const foo = () => {};
            const bar = async (a, b) => a + b;
            let baz = (x) => x * 2;
        `);
        expect(result.functions).toContain('foo');
        expect(result.functions).toContain('bar');
        expect(result.functions).toContain('baz');
    });

    it('extracts interfaces', () => {
        const result = ASTParser.extractSymbols(`
            interface Foo {}
            interface Bar { x: number; }
        `);
        expect(result.interfaces).toEqual(expect.arrayContaining(['Foo', 'Bar']));
    });

    it('extracts exports', () => {
        const result = ASTParser.extractSymbols(`
            export const foo = 1;
            export function bar() {}
            export class Baz {}
            export interface Qux {}
        `);
        expect(result.exports).toEqual(
            expect.arrayContaining(['foo', 'bar', 'Baz', 'Qux'])
        );
    });

    it('returns empty arrays for empty input', () => {
        const result = ASTParser.extractSymbols('');
        expect(result.imports).toEqual([]);
        expect(result.exports).toEqual([]);
        expect(result.classes).toEqual([]);
        expect(result.functions).toEqual([]);
        expect(result.interfaces).toEqual([]);
        expect(result.variables).toEqual([]);
        expect(result.importedNames).toEqual({});
    });
});

describe('ASTParser.extractSymbols — known limitations', () => {
    // These tests document the regex parser's limitations. They
    // serve as TODO markers for v2's Tree-Sitter swap.

    it('does NOT capture dynamic imports (Tree-Sitter swap fixes)', () => {
        const result = ASTParser.extractSymbols(`
            const m = await import('./module');
        `);
        // Regex parser can't match dynamic imports because they look
        // syntactically different. Tree-Sitter would catch them.
        expect(result.imports).not.toContain('./module');
    });

    it('does NOT capture re-exports at all (Tree-Sitter swap fixes)', () => {
        const result = ASTParser.extractSymbols(`
            export { foo } from './m';
        `);
        // The export regex requires a keyword (const/function/class/interface/
        // type/default) after `export`, so brace-form re-exports match
        // nothing. Both the exported name AND the source path are lost.
        // Tree-Sitter would catch both.
        expect(result.exports).not.toContain('foo');
        expect(result.imports).not.toContain('./m');
    });
});