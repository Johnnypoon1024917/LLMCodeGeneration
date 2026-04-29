// src/test/unit/tools/web_fetch.test.ts
//
// Tests for web_fetch — exercises URL validation, content cap,
// timeout, and abort signal handling. Uses a mocked global fetch
// so tests don't hit real network.

jest.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { fs: { stat: jest.fn(), readFile: jest.fn() } },
    FileType: { Directory: 2, File: 1, SymbolicLink: 64 }
}));

import { dispatchTool, type ToolExecutionContext } from '../../../agents/toolRegistry';
import '../../../agents/tools';

describe('web_fetch tool', () => {
    const ctx: ToolExecutionContext = { workspaceRoot: '/repo' };
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    test('returns response body for successful fetch', async () => {
        globalThis.fetch = (async () => {
            return new Response('<html>hello</html>', {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'text/html' }
            });
        }) as typeof globalThis.fetch;

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com' }) } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('string');
        expect(result.llmContent).toContain('Status: 200');
        expect(result.llmContent).toContain('hello');
    });

    test('rejects non-http URLs', async () => {
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'file:///etc/passwd' }) } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('http://');
    });

    test('rejects javascript: URL', async () => {
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'javascript:alert(1)' }) } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
    });

    test('returns error for missing url argument', async () => {
        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain("'url'");
    });

    test('captures fetch errors in structured result', async () => {
        globalThis.fetch = (async () => {
            throw new Error('network unreachable');
        }) as typeof globalThis.fetch;

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://nonexistent.example' }) } },
            ctx
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('network unreachable');
    });

    test('honors abort signal', async () => {
        // Simulate slow server: fetch never resolves until aborted
        globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
            return new Promise((_resolve, reject) => {
                if (init?.signal) {
                    init.signal.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        }) as typeof globalThis.fetch;

        const abortCtl = new AbortController();
        const cmdCtx: ToolExecutionContext = { workspaceRoot: '/repo', signal: abortCtl.signal };

        const dispatchPromise = dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://slow.example' }) } },
            cmdCtx
        );

        setTimeout(() => abortCtl.abort(), 50);

        const result = await dispatchPromise;
        expect(result.uiPayload.kind).toBe('error');
    });
});