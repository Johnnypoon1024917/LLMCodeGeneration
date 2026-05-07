// webview-ui/src/test/unit/codeGraphContext.test.ts
//
// Tests for the code-map side panel derivation helpers.

import { describe, test, expect } from 'vitest';
import {
    buildImporterIndex,
    buildNodeContext,
    type WorkspaceGraphData,
} from '../../codeGraphContext';

const sampleGraph: WorkspaceGraphData = {
    'src/auth/login.ts': {
        filepath: 'src/auth/login.ts',
        imports: ['./session', '../utils/hash', 'react', 'crypto'],
        exports: ['handleLogin'],
        classes: ['LoginController'],
        functions: ['handleLogin', 'validateInput'],
        interfaces: [],
        variables: [],
    },
    'src/auth/session.ts': {
        filepath: 'src/auth/session.ts',
        imports: ['../utils/hash'],
        exports: ['createSession', 'destroySession', 'Session'],
        classes: [],
        functions: ['createSession', 'destroySession'],
        interfaces: ['Session'],
        variables: [],
    },
    'src/utils/hash.ts': {
        filepath: 'src/utils/hash.ts',
        imports: [],
        exports: ['hashPassword', 'verifyPassword'],
        classes: [],
        functions: ['hashPassword', 'verifyPassword'],
        interfaces: [],
        variables: [],
    },
    'src/api/auth.ts': {
        filepath: 'src/api/auth.ts',
        imports: ['../auth/login', '../auth/session'],
        exports: ['authRouter'],
        classes: [],
        functions: [],
        interfaces: [],
        variables: ['authRouter'],
    },
};

describe('buildImporterIndex', () => {
    test('builds inverse import map for a typical workspace', () => {
        const idx = buildImporterIndex(sampleGraph);
        // session is imported by login and api/auth
        expect(idx['src/auth/session.ts']).toContain('src/auth/login.ts');
        expect(idx['src/auth/session.ts']).toContain('src/api/auth.ts');
        // hash is imported by login and session
        expect(idx['src/utils/hash.ts']).toContain('src/auth/login.ts');
        expect(idx['src/utils/hash.ts']).toContain('src/auth/session.ts');
    });

    test('files with no importers are absent from the index', () => {
        const idx = buildImporterIndex(sampleGraph);
        // api/auth.ts is imported by nobody in the sample
        expect(idx['src/api/auth.ts']).toBeUndefined();
    });

    test('skips external libraries (no resolution to workspace)', () => {
        const idx = buildImporterIndex(sampleGraph);
        // 'react', 'crypto' resolve to nothing in the workspace
        expect(idx['react']).toBeUndefined();
        expect(idx['crypto']).toBeUndefined();
    });

    test('de-duplicates importers (same file with two imports of same target)', () => {
        const dupGraph: WorkspaceGraphData = {
            'a.ts': {
                filepath: 'a.ts',
                imports: ['./b', './b'], // pathological but possible
            },
            'b.ts': { filepath: 'b.ts', imports: [] },
        };
        const idx = buildImporterIndex(dupGraph);
        expect(idx['b.ts']).toEqual(['a.ts']); // not ['a.ts', 'a.ts']
    });

    test('empty graph returns empty index', () => {
        expect(buildImporterIndex({})).toEqual({});
    });
});

describe('buildNodeContext - file nodes', () => {
    const idx = buildImporterIndex(sampleGraph);

    test('returns file context with importers, imports, and symbols', () => {
        const ctx = buildNodeContext('src/auth/session.ts', sampleGraph, idx);
        expect(ctx?.kind).toBe('file');
        if (ctx?.kind !== 'file') { return; }

        expect(ctx.filepath).toBe('src/auth/session.ts');
        expect(ctx.importers).toContain('src/auth/login.ts');
        expect(ctx.importsResolved).toContain('src/utils/hash.ts');
        expect(ctx.symbols.find(s => s.name === 'createSession')?.kind).toBe('function');
        expect(ctx.symbols.find(s => s.name === 'Session')?.kind).toBe('interface');
        expect(ctx.exports).toContain('createSession');
    });

    test('separates external imports from resolved workspace imports', () => {
        const ctx = buildNodeContext('src/auth/login.ts', sampleGraph, idx);
        if (ctx?.kind !== 'file') { throw new Error('expected file'); }

        expect(ctx.importsResolved).toContain('src/auth/session.ts');
        expect(ctx.importsResolved).toContain('src/utils/hash.ts');
        // 'react' and 'crypto' are external — not resolvable to workspace
        expect(ctx.externalImports).toContain('react');
        expect(ctx.externalImports).toContain('crypto');
    });

    test('returns null for unknown file', () => {
        expect(buildNodeContext('not/a/real/file.ts', sampleGraph, idx)).toBeNull();
    });

    test('symbol order: classes first, then functions, then interfaces', () => {
        // login.ts has class LoginController + functions handleLogin/validateInput
        const ctx = buildNodeContext('src/auth/login.ts', sampleGraph, idx);
        if (ctx?.kind !== 'file') { throw new Error('expected file'); }

        expect(ctx.symbols[0]?.kind).toBe('class');
        expect(ctx.symbols[1]?.kind).toBe('function');
        // symbols after the class should all be function or interface,
        // never another class (sample has only one class)
    });
});

describe('buildNodeContext - symbol nodes', () => {
    const idx = buildImporterIndex(sampleGraph);

    test('returns symbol context for "filepath::name" id', () => {
        const ctx = buildNodeContext(
            'src/auth/session.ts::createSession',
            sampleGraph,
            idx
        );
        expect(ctx?.kind).toBe('symbol');
        if (ctx?.kind !== 'symbol') { return; }

        expect(ctx.filepath).toBe('src/auth/session.ts');
        expect(ctx.symbol).toBe('createSession');
        expect(ctx.symbolKind).toBe('function');
        expect(ctx.isExported).toBe(true);
    });

    test('detects class kind correctly', () => {
        const ctx = buildNodeContext(
            'src/auth/login.ts::LoginController',
            sampleGraph,
            idx
        );
        if (ctx?.kind !== 'symbol') { throw new Error('expected symbol'); }
        expect(ctx.symbolKind).toBe('class');
    });

    test('detects interface kind correctly', () => {
        const ctx = buildNodeContext(
            'src/auth/session.ts::Session',
            sampleGraph,
            idx
        );
        if (ctx?.kind !== 'symbol') { throw new Error('expected symbol'); }
        expect(ctx.symbolKind).toBe('interface');
    });

    test('isExported is false for unexported symbols', () => {
        // validateInput is not in login.ts's exports list
        const ctx = buildNodeContext(
            'src/auth/login.ts::validateInput',
            sampleGraph,
            idx
        );
        if (ctx?.kind !== 'symbol') { throw new Error('expected symbol'); }
        expect(ctx.isExported).toBe(false);
    });

    test('siblings excludes the selected symbol itself', () => {
        const ctx = buildNodeContext(
            'src/auth/login.ts::handleLogin',
            sampleGraph,
            idx
        );
        if (ctx?.kind !== 'symbol') { throw new Error('expected symbol'); }
        expect(ctx.siblings.find(s => s.name === 'handleLogin')).toBeUndefined();
        expect(ctx.siblings.find(s => s.name === 'LoginController')).toBeDefined();
        expect(ctx.siblings.find(s => s.name === 'validateInput')).toBeDefined();
    });

    test('returns null when parent file is not in graph', () => {
        const ctx = buildNodeContext(
            'src/missing/file.ts::foo',
            sampleGraph,
            idx
        );
        expect(ctx).toBeNull();
    });

    test('symbolKind is "unknown" when symbol is not in any list', () => {
        // Defensive: stale node id pointing at a symbol that no
        // longer exists in the file (rename, delete, etc.).
        const ctx = buildNodeContext(
            'src/auth/login.ts::nonexistentSymbol',
            sampleGraph,
            idx
        );
        if (ctx?.kind !== 'symbol') { throw new Error('expected symbol'); }
        expect(ctx.symbolKind).toBe('unknown');
        expect(ctx.isExported).toBe(false);
    });
});

describe('buildNodeContext - empty / malformed input', () => {
    test('empty nodeId returns null', () => {
        expect(buildNodeContext('', sampleGraph, {})).toBeNull();
    });

    test('nodeId with leading "::" treated as file (not symbol)', () => {
        // Defensive against weird input. "::foo" has no parent file
        // before the separator, so it's treated as a (nonexistent)
        // file path, returning null.
        expect(buildNodeContext('::foo', sampleGraph, {})).toBeNull();
    });

    test('nodeId with trailing "::" treated as file (not symbol)', () => {
        // "src/foo::" has no symbol after the separator.
        expect(buildNodeContext('src/foo::', sampleGraph, {})).toBeNull();
    });
});