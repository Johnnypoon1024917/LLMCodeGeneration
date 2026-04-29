// src/test/unit/searchReplace.test.ts
//
// Unit tests for src/utilities/searchReplace.ts
//
// Coverage philosophy:
//   - Every documented edge case in searchReplace.ts has at least one test
//   - Errors are tested for both "throws" and "throws with the right diagnostic"
//   - Multi-block and multi-file scenarios get their own block of tests
//   - Tests are intentionally readable as documentation — the test name + body
//     should make the protocol's behavior obvious to a reader.

import {
    parseBlocks,
    applyBlock,
    applyBlocks,
    type ParsedBlock
} from '../../utilities/searchReplace';

// ─── Parser tests ─────────────────────────────────────────────────────

describe('parseBlocks — basic shapes', () => {
    test('parses a single canonical block', () => {
        const input = [
            '<<<<SEARCH',
            'old code',
            '====',
            'new code',
            '>>>>REPLACE'
        ].join('\n');
        const result = parseBlocks(input);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]?.search).toBe('old code');
        expect(result.blocks[0]?.replace).toBe('new code');
    });

    test('parses multiple sequential blocks', () => {
        const input = [
            '<<<<SEARCH',
            'a',
            '====',
            'A',
            '>>>>REPLACE',
            '',
            'some prose between blocks',
            '',
            '<<<<SEARCH',
            'b',
            '====',
            'B',
            '>>>>REPLACE'
        ].join('\n');
        const result = parseBlocks(input);
        expect(result.blocks).toHaveLength(2);
        expect(result.blocks[0]?.search).toBe('a');
        expect(result.blocks[1]?.search).toBe('b');
    });

    test('returns empty result when no markers present', () => {
        const result = parseBlocks('just some text\nwith no markers\n');
        expect(result.blocks).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    test('preserves multi-line search and replace bodies', () => {
        const input = [
            '<<<<SEARCH',
            'line1',
            'line2',
            'line3',
            '====',
            'newA',
            'newB',
            '>>>>REPLACE'
        ].join('\n');
        const { blocks } = parseBlocks(input);
        expect(blocks[0]?.search).toBe('line1\nline2\nline3');
        expect(blocks[0]?.replace).toBe('newA\nnewB');
    });
});

describe('parseBlocks — marker fuzzing', () => {
    test('accepts up to 4 leading spaces on markers', () => {
        const input = [
            '    <<<<SEARCH',
            'x',
            '    ====',
            'X',
            '    >>>>REPLACE'
        ].join('\n');
        const { blocks } = parseBlocks(input);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.search).toBe('x');
    });

    test('accepts tabs as leading whitespace on markers', () => {
        const input = [
            '\t<<<<SEARCH',
            'x',
            '\t====',
            'X',
            '\t>>>>REPLACE'
        ].join('\n');
        const { blocks } = parseBlocks(input);
        expect(blocks).toHaveLength(1);
    });

    test('accepts 5-7 angle brackets on SEARCH/REPLACE markers (model fuzzing)', () => {
        const input = [
            '<<<<<<SEARCH',
            'x',
            '====',
            'X',
            '>>>>>>>REPLACE'
        ].join('\n');
        const { blocks } = parseBlocks(input);
        expect(blocks).toHaveLength(1);
    });

    test('accepts 3-7 equals signs on separator', () => {
        const inputs = ['===', '====', '=====', '======', '======='];
        for (const sep of inputs) {
            const input = [`<<<<SEARCH`, 'x', sep, 'X', `>>>>REPLACE`].join('\n');
            const { blocks } = parseBlocks(input);
            expect(blocks).toHaveLength(1);
        }
    });

    test('rejects 2 equals signs on separator (too short)', () => {
        const input = ['<<<<SEARCH', 'x', '==', 'X', '>>>>REPLACE'].join('\n');
        // No separator found → SEARCH has no matching === marker → throws.
        expect(() => parseBlocks(input)).toThrow(/no separator/);
    });

    test('normalizes CRLF input', () => {
        const input = '<<<<SEARCH\r\nold\r\n====\r\nnew\r\n>>>>REPLACE\r\n';
        const { blocks } = parseBlocks(input);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]?.search).toBe('old');
        expect(blocks[0]?.replace).toBe('new');
    });
});

describe('parseBlocks — error cases', () => {
    test('throws on SEARCH without separator', () => {
        const input = '<<<<SEARCH\nold\n>>>>REPLACE\n';
        // The >>>>REPLACE is found, but no === between, so the second marker
        // is `replace` instead of the expected `separator`.
        expect(() => parseBlocks(input)).toThrow(/no separator/);
    });

    test('throws on SEARCH without REPLACE', () => {
        const input = '<<<<SEARCH\nold\n====\nnew\n';
        expect(() => parseBlocks(input)).toThrow(/no >>>>REPLACE marker/);
    });

    test('throws on empty SEARCH block', () => {
        const input = '<<<<SEARCH\n====\nnew\n>>>>REPLACE\n';
        expect(() => parseBlocks(input)).toThrow(/Empty SEARCH block/);
    });

    test('warns (not throws) on stray separator before any SEARCH', () => {
        const input = [
            '====',  // stray
            '<<<<SEARCH',
            'x',
            '====',
            'X',
            '>>>>REPLACE'
        ].join('\n');
        const { blocks, warnings } = parseBlocks(input);
        expect(blocks).toHaveLength(1);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toMatch(/Stray SEPARATOR/);
    });
});

// ─── Applier tests ─────────────────────────────────────────────────────

describe('applyBlock — Tier A exact matching', () => {
    test('replaces exact unique match', () => {
        const file = 'function foo() {\n    return 1;\n}\n';
        const block: ParsedBlock = {
            search: '    return 1;',
            replace: '    return 2;',
            blockOffset: 0
        };
        expect(applyBlock(file, block)).toBe('function foo() {\n    return 2;\n}\n');
    });

    test('rejects when SEARCH appears multiple times', () => {
        const file = 'foo\nbar\nfoo\n';
        const block: ParsedBlock = { search: 'foo', replace: 'baz', blockOffset: 0 };
        expect(() => applyBlock(file, block)).toThrow(/matches 2 regions/);
    });

    test('preserves $ characters in replacement (no regex interpretation)', () => {
        const file = 'const price = OLD_PRICE;\n';
        const block: ParsedBlock = {
            search: 'OLD_PRICE',
            replace: '$100.00',
            blockOffset: 0
        };
        // If we used String.replace(string, string), $1 would be replaced with
        // the matched group. Our impl uses () => replacement to bypass that.
        expect(applyBlock(file, block)).toBe('const price = $100.00;\n');
    });

    test('handles CRLF in input file', () => {
        const file = 'a\r\nb\r\nc\r\n';
        const block: ParsedBlock = { search: 'b', replace: 'B', blockOffset: 0 };
        // Note: result is normalized to LF.
        expect(applyBlock(file, block)).toBe('a\nB\nc\n');
    });
});

describe('applyBlock — Tier B trailing whitespace tolerance', () => {
    test('matches when file has trailing whitespace search does not', () => {
        const file = 'function foo() {   \n    return 1;\t\n}\n';
        const block: ParsedBlock = {
            search: 'function foo() {\n    return 1;\n}',
            replace: 'function foo() {\n    return 2;\n}',
            blockOffset: 0
        };
        const result = applyBlock(file, block);
        expect(result).toContain('return 2;');
        expect(result).not.toContain('return 1;');
    });

    test('still rejects when fuzzy match is ambiguous', () => {
        const file = 'foo \nbar\nfoo  \n';  // two "foo"s differing only in trailing ws
        const block: ParsedBlock = { search: 'foo', replace: 'BAZ', blockOffset: 0 };
        expect(() => applyBlock(file, block)).toThrow();
    });
});

describe('applyBlock — Tier C leading whitespace tolerance', () => {
    test('matches when file uses tabs and search uses spaces', () => {
        const file = '\t\tif (x) {\n\t\t\treturn 1;\n\t\t}\n';
        const block: ParsedBlock = {
            search: '        if (x) {\n            return 1;\n        }',
            replace: '        if (x) {\n            return 2;\n        }',
            blockOffset: 0
        };
        const result = applyBlock(file, block);
        expect(result).toContain('return 2;');
    });
});

describe('applyBlock — error diagnostics', () => {
    test('error includes searchPreview for "did you mean" hint', () => {
        const file = 'function bar() {\n    return 1;\n}\n';
        const block: ParsedBlock = {
            search: 'function FOO() {',
            replace: 'function FOO() { /* edited */',
            blockOffset: 0
        };
        try {
            applyBlock(file, block);
            fail('should have thrown');
        } catch (e) {
            expect((e as Error).message).toContain('not found');
            const apply = e as { searchPreview?: string };
            expect(apply.searchPreview).toBe('function FOO() {');
        }
    });

    test('error includes candidates for similar lines', () => {
        const file = 'function bar() {\n    return 1;\n}\n';
        const block: ParsedBlock = {
            search: 'function baz() {',
            replace: 'whatever',
            blockOffset: 0
        };
        try {
            applyBlock(file, block);
            fail('should have thrown');
        } catch (e) {
            const apply = e as { candidates?: string[] };
            expect(apply.candidates).toBeDefined();
            // The closest candidate should be the `function bar() {` line.
            expect(apply.candidates?.[0]).toMatch(/bar/);
        }
    });
});

// ─── Atomic batch apply tests ─────────────────────────────────────────────

describe('applyBlocks — atomic batch', () => {
    test('applies multiple blocks to multiple files', () => {
        const files = new Map([
            ['a.ts', 'old1\n'],
            ['b.ts', 'old2\n']
        ]);
        const blocks = [
            { filepath: 'a.ts', block: { search: 'old1', replace: 'new1', blockOffset: 0 } },
            { filepath: 'b.ts', block: { search: 'old2', replace: 'new2', blockOffset: 0 } }
        ];
        const result = applyBlocks(files, blocks);
        expect(result.get('a.ts')).toBe('new1\n');
        expect(result.get('b.ts')).toBe('new2\n');
    });

    test('applies multiple blocks to the same file in order', () => {
        const files = new Map([['x.ts', 'AAA\nBBB\n']]);
        const blocks = [
            { filepath: 'x.ts', block: { search: 'AAA', replace: 'CCC', blockOffset: 0 } },
            { filepath: 'x.ts', block: { search: 'BBB', replace: 'DDD', blockOffset: 0 } }
        ];
        const result = applyBlocks(files, blocks);
        expect(result.get('x.ts')).toBe('CCC\nDDD\n');
    });

    test('rejects whole batch if any block fails (atomic)', () => {
        const files = new Map([
            ['a.ts', 'old1\n'],
            ['b.ts', 'old2\n']
        ]);
        const blocks = [
            { filepath: 'a.ts', block: { search: 'old1', replace: 'new1', blockOffset: 0 } },
            // This block targets a substring that doesn't exist:
            { filepath: 'b.ts', block: { search: 'NOTHERE', replace: 'oops', blockOffset: 0 } }
        ];
        expect(() => applyBlocks(files, blocks)).toThrow();
        // Crucially: original `files` map must be UNCHANGED. The function
        // returns a new map, never mutates the input.
        expect(files.get('a.ts')).toBe('old1\n');
        expect(files.get('b.ts')).toBe('old2\n');
    });

    test('throws when block targets a file not in the map', () => {
        const files = new Map([['a.ts', 'content']]);
        const blocks = [
            { filepath: 'b.ts', block: { search: 'x', replace: 'y', blockOffset: 0 } }
        ];
        expect(() => applyBlocks(files, blocks)).toThrow(/no content for filepath/);
    });
});

// ─── Integration: parse + apply ───────────────────────────────────────────

describe('integration — parse then apply', () => {
    test('full happy path with a single block', () => {
        const llmOutput = [
            'I will fix the bug:',
            '',
            '<<<<SEARCH',
            '    return 1;',
            '====',
            '    return 2;',
            '>>>>REPLACE',
            '',
            'Done!'
        ].join('\n');

        const file = 'function foo() {\n    return 1;\n}\n';

        const { blocks } = parseBlocks(llmOutput);
        expect(blocks).toHaveLength(1);
        const result = applyBlock(file, blocks[0]!);
        expect(result).toBe('function foo() {\n    return 2;\n}\n');
    });

    test('survives prose interleaved with blocks', () => {
        const llmOutput = [
            "Here's the first edit:",
            '<<<<SEARCH',
            'A',
            '====',
            'a',
            '>>>>REPLACE',
            "And the second:",
            '<<<<SEARCH',
            'B',
            '====',
            'b',
            '>>>>REPLACE',
            'Done.'
        ].join('\n');

        const { blocks } = parseBlocks(llmOutput);
        expect(blocks).toHaveLength(2);

        const files = new Map([['x.ts', 'A then B\n']]);
        const batch = blocks.map(b => ({ filepath: 'x.ts', block: b }));
        const result = applyBlocks(files, batch);
        expect(result.get('x.ts')).toBe('a then b\n');
    });
});