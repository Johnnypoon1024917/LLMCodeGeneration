// src/test/unit/toolRegistry.test.ts
//
// Tests for the tool registry plumbing (Component 2B-2, Q6=6B).
//
// What we test:
//   - registerTool() adds an entry; the executor is callable via dispatchTool
//   - dispatchTool returns a structured error for unknown tools
//   - dispatchTool returns a structured error for malformed JSON args
//   - dispatchTool catches executor exceptions and surfaces as error result
//   - getAllToolDefinitions() returns sorted definitions
//   - getToolDefinitions(names) returns only requested tools
//
// What we DON'T test (covered by per-tool tests):
//   - Specific tool behavior (read_file, bash_exec, etc.)
//   - vscode.workspace.fs interactions

jest.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { fs: { stat: jest.fn(), readFile: jest.fn() } },
    FileType: { Directory: 2, File: 1, SymbolicLink: 64 }
}), { virtual: true });

import {
    registerTool,
    dispatchTool,
    getAllToolDefinitions,
    getToolDefinitions,
    resetRegistryForTesting,
    getRegisteredToolNames
} from '../../agents/toolRegistry';
import type { ToolExecutor } from '../../agents/toolRegistry';
import type { ToolDefinition } from '../../llm';

describe('toolRegistry — plumbing (Component 2B-2)', () => {
    beforeEach(() => {
        resetRegistryForTesting();
    });

    /** Construct a minimal valid tool definition. */
    function makeDef(name: string): ToolDefinition {
        return {
            type: 'function',
            function: {
                name,
                description: `tool ${name}`,
                parameters: { type: 'object', properties: {}, required: [] }
            }
        };
    }

    test('registered tool is reachable via dispatchTool', async () => {
        const calls: Array<{ args: Record<string, unknown> }> = [];
        const executor: ToolExecutor = async (args) => {
            calls.push({ args });
            return { llmContent: 'ok', uiPayload: { kind: 'string', content: 'ok' } };
        };

        registerTool(makeDef('foo'), executor);

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.llmContent).toBe('ok');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual({ x: 1 });
    });

    test('returns structured error for unknown tool name', async () => {
        registerTool(makeDef('foo'), async () => ({
            llmContent: 'ok',
            uiPayload: { kind: 'string', content: 'ok' }
        }));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('Unknown tool');
        expect(result.llmContent).toContain('foo'); // available tools listed
    });

    test('returns structured error for malformed JSON arguments', async () => {
        registerTool(makeDef('foo'), async () => ({
            llmContent: 'ok',
            uiPayload: { kind: 'string', content: 'ok' }
        }));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: 'not valid json {' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('Invalid JSON arguments');
    });

    test('treats empty arguments string as empty object', async () => {
        // Some tools take no parameters; the model emits arguments: ""
        // which should NOT be a JSON parse error.
        let received: Record<string, unknown> | null = null;
        registerTool(makeDef('noargs'), async (args) => {
            received = args;
            return { llmContent: 'ran', uiPayload: { kind: 'string', content: 'ran' } };
        });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'noargs', arguments: '' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.llmContent).toBe('ran');
        expect(received).toEqual({});
    });

    test('catches executor exceptions and surfaces as error result', async () => {
        registerTool(makeDef('crashy'), async () => {
            throw new Error('something broke');
        });

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'crashy', arguments: '{}' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('Error executing crashy');
        expect(result.llmContent).toContain('something broke');
    });

    test('getAllToolDefinitions returns sorted-by-name definitions', async () => {
        registerTool(makeDef('zeta'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));
        registerTool(makeDef('alpha'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));
        registerTool(makeDef('mu'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));

        const defs = getAllToolDefinitions();
        expect(defs.map(d => d.function.name)).toEqual(['alpha', 'mu', 'zeta']);
    });

    test('getToolDefinitions(names) returns only requested tools', async () => {
        registerTool(makeDef('a'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));
        registerTool(makeDef('b'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));
        registerTool(makeDef('c'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));

        const defs = getToolDefinitions(['a', 'c', 'nonexistent']);
        expect(defs.map(d => d.function.name)).toEqual(['a', 'c']);
    });

    test('getRegisteredToolNames returns sorted names', async () => {
        registerTool(makeDef('zeta'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));
        registerTool(makeDef('alpha'), async () => ({ llmContent: '', uiPayload: { kind: 'string', content: '' } }));

        expect(getRegisteredToolNames()).toEqual(['alpha', 'zeta']);
    });

    test('re-registering a tool replaces the previous executor', async () => {
        registerTool(makeDef('replaceme'), async () => ({
            llmContent: 'first',
            uiPayload: { kind: 'string', content: 'first' }
        }));

        registerTool(makeDef('replaceme'), async () => ({
            llmContent: 'second',
            uiPayload: { kind: 'string', content: 'second' }
        }));

        const result = await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'replaceme', arguments: '{}' } },
            { workspaceRoot: '/repo' }
        );

        expect(result.llmContent).toBe('second');
    });

    test('passes ctx through to the executor', async () => {
        const abortCtl = new AbortController();
        const onChunk = jest.fn();
        let receivedCtx: { workspaceRoot: string; signal?: AbortSignal; onOutputChunk?: (c: string) => void } | null = null;
        registerTool(makeDef('ctxcheck'), async (_args, ctx) => {
            receivedCtx = ctx;
            return { llmContent: 'ok', uiPayload: { kind: 'string', content: 'ok' } };
        });

        await dispatchTool(
            { id: 'c1', type: 'function', function: { name: 'ctxcheck', arguments: '{}' } },
            { workspaceRoot: '/my/repo', signal: abortCtl.signal, onOutputChunk: onChunk }
        );

        expect(receivedCtx).not.toBeNull();
        expect(receivedCtx!.workspaceRoot).toBe('/my/repo');
        expect(receivedCtx!.signal).toBe(abortCtl.signal);
        expect(receivedCtx!.onOutputChunk).toBe(onChunk);
    });
});

describe('toolRegistry — barrel auto-registration', () => {
    test('importing the tools barrel registers all 10 tools', () => {
        // Reset and re-import in an isolated module scope so the
        // barrel's registerTool calls hit a fresh registry. The
        // registry must be queried INSIDE the isolated scope —
        // querying from outside would hit the test file's module-
        // level registry, which is a different instance.
        let names: string[] = [];
        jest.isolateModules(() => {
            // The act of requiring the barrel triggers registration.
            require('../../agents/tools');
            // Query the SAME isolated registry instance.
            const reg = require('../../agents/toolRegistry') as typeof import('../../agents/toolRegistry');
            names = reg.getRegisteredToolNames();
        });

        expect(names).toEqual([
            'bash_exec',
            'edit_file',
            'git_commit',
            'install_package',
            'list_directory',
            'read_file',
            'run_tests',
            'search_codebase',
            'web_fetch',
            'write_file'
        ]);
    });
});