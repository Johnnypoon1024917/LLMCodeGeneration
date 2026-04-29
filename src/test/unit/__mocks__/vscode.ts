// src/test/unit/__mocks__/vscode.ts
//
// Minimal vscode mock for jest unit tests.
//
// The real vscode module only exists inside the Extension Host. Unit tests
// run in plain Node, so any import path that transitively touches `import
// 'vscode'` would crash. This mock provides just enough surface for the
// module-loading to succeed; tests that need richer vscode behavior should
// use the integration test runner (vscode-test), not this mock.
//
// Component 2B-2 expanded this mock to support the new tool registry's
// dispatch tests (filesystem.test.ts, web_fetch.test.ts, etc.). Tools at
// module-load time reference `FileType.Directory` and similar enum values;
// without those exports, the import chain fails BEFORE Jest's `jest.mock()`
// overrides take effect on some platforms (notably Windows).
//
// Test files that need richer per-test behavior (e.g. tracking calls to
// readFile) override individual methods at runtime via:
//
//     const vscode = require('vscode');
//     vscode.workspace.fs.readFile = jest.fn().mockResolvedValue(...);
//
// or by replacing the whole module via `jest.mock('vscode', () => ({...}))`
// at the top of the test file. Either pattern works AS LONG AS this base
// mock provides enough surface for module-load to succeed.

export const window = {
    createOutputChannel: () => ({
        // Bare minimum LogOutputChannel surface used by src/logger.ts
        appendLine: () => { /* no-op */ },
        append: () => { /* no-op */ },
        clear: () => { /* no-op */ },
        show: () => { /* no-op */ },
        hide: () => { /* no-op */ },
        dispose: () => { /* no-op */ },
        trace: () => { /* no-op */ },
        debug: () => { /* no-op */ },
        info: () => { /* no-op */ },
        warn: () => { /* no-op */ },
        error: () => { /* no-op */ },
        replace: () => { /* no-op */ },
        name: 'mock'
    }),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn()
};

/**
 * vscode.FileType bitmask enum. Real values from VS Code API.
 * Tools at src/agents/tools/*.ts reference these as values (not just
 * types) so the mock must export them at module load time.
 */
export const FileType = {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64
};

/**
 * Stub fs methods. Default implementations resolve to "empty" /
 * "not found" so tests that don't explicitly mock get sane behavior.
 * Most tool tests override these per-test via jest.fn().
 */
const fsStub = {
    stat: jest.fn().mockRejectedValue(new Error('ENOENT (default mock)')),
    readFile: jest.fn().mockRejectedValue(new Error('ENOENT (default mock)')),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readDirectory: jest.fn().mockResolvedValue([]),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    copy: jest.fn().mockResolvedValue(undefined)
};

export const workspace = {
    getConfiguration: () => ({
        get: () => undefined,
        update: () => Promise.resolve()
    }),
    workspaceFolders: undefined,
    fs: fsStub,
    // Default returns no matches; tests that need findFiles override
    // this per-test.
    findFiles: jest.fn().mockResolvedValue([]),
    // Convert URI back to a path string. Default strips a leading
    // /repo/ prefix (matches the convention in tool tests).
    asRelativePath: jest.fn((uriOrString: { fsPath: string } | string) => {
        const path = typeof uriOrString === 'string' ? uriOrString : uriOrString.fsPath;
        return path.replace(/^\/repo\//, '');
    })
};

export const Uri = {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
    parse: (s: string) => ({ fsPath: s, scheme: 'file', path: s }),
    /**
     * Join base URI with relative path segments. Real VS Code uses
     * forward-slash normalization; the tools rely on this behavior.
     */
    joinPath: (base: { fsPath: string }, ...segs: string[]) => {
        const joined = [base.fsPath, ...segs].join('/').replace(/\/+/g, '/');
        return { fsPath: joined, scheme: 'file', path: joined };
    }
};

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
};

export const env = {
    language: 'en'
};