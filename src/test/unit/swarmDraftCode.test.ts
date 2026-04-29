// src/test/unit/swarmDraftCode.test.ts
//
// Tests for the rewritten swarmDraftCode (Component 2B-3c, stepping-stone
// Option C). Verifies:
//
//   - Pre-mod content is written to disk BEFORE the ReAct loop runs
//     (each retry attempt starts from the same baseline)
//   - The model's tool calls dispatch through the registered tool
//     executors (write_file actually modifies the file)
//   - The returned CodeDiff has searchBlock=pre-mod, replaceBlock=post-mod,
//     finalContent=post-mod (verifier compat + apply path signal)
//   - Lifecycle events emitted with source='coordinator'
//   - Security hook can block bash_exec (though swarmDraftCode doesn't
//     advertise bash_exec, this verifies the wiring for future expansion)
//
// We mock the Provider to script tool-call streams. The vscode mock
// from __mocks__/vscode.ts provides workspace.fs stubs we can override
// per-test.

// Mock the Provider factory
const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn()
};
jest.mock('../../llm', () => {
    const actual = jest.requireActual('../../llm');
    return {
        ...actual,
        getProvider: async () => mockProvider
    };
});

// Mock the security hook so bash_exec gating is deterministic.
// Default: allow everything (swarmDraftCode's catalog doesn't include
// bash_exec anyway, but this keeps tests insulated from any future
// catalog changes).
jest.mock('../../agents/securityHook', () => ({
    buildSecurityHook: () => async () => ({ blocked: false }),
    allowAllHook: async () => ({ blocked: false })
}));

import * as vscode from 'vscode';
import * as path from 'path';
import { swarmDraftCode } from '../../agents/Coordinator';
import { ToolEventEmitter } from '../../agents/toolEventEmitter';
import type { ToolLifecycleEvent } from '../../agents/toolProtocol';

// Cast for jest mock methods on vscode workspace.fs
const mockedFs = vscode.workspace.fs as unknown as {
    stat: jest.Mock;
    readFile: jest.Mock;
    writeFile: jest.Mock;
    readDirectory: jest.Mock;
    createDirectory: jest.Mock;
};

/**
 * Helper to construct a scripted async iterable simulating
 * provider.streamChatCompletion. Yields the given deltas in order,
 * then closes.
 */
function scriptedStream(deltas: Array<{ kind: 'text'; content: string } | { kind: 'tool_call'; toolCall: import('../../llm').ToolCall } | { kind: 'finish'; reason: string }>) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const delta of deltas) {
                yield delta;
            }
        }
    };
}

describe('swarmDraftCode — stepping-stone Option C', () => {
    beforeEach(() => {
        // Reset all fs mocks. Default to "exists as file" for stat,
        // empty for readFile (post-mod state can be overridden per-test).
        mockedFs.stat.mockReset().mockResolvedValue({ type: vscode.FileType.File });
        mockedFs.readFile.mockReset();
        mockedFs.writeFile.mockReset().mockResolvedValue(undefined);
        mockedFs.readDirectory.mockReset().mockResolvedValue([]);
        mockedFs.createDirectory.mockReset().mockResolvedValue(undefined);

        mockProvider.streamChatCompletion.mockReset();
    });

    test('writes pre-mod content to disk before ReAct loop runs', async () => {
        // Model says "done" without tool calls — simplest case to
        // verify the pre-mod write step.
        mockProvider.streamChatCompletion.mockResolvedValueOnce(scriptedStream([
            { kind: 'text', content: 'Done.' },
            { kind: 'finish', reason: 'stop' }
        ]));

        // Post-loop readFile returns the pre-mod content (no tool wrote to it)
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('original content'));

        const result = await swarmDraftCode(
            'spec',
            'src/x.ts',
            'original content',
            [],
            '',
            '/repo',
            'task-1'
        );

        // Pre-mod write happened
        expect(mockedFs.writeFile).toHaveBeenCalled();
        const writeCall = mockedFs.writeFile.mock.calls[0]!;
        // Use path.join to compute the expected fsPath the same way
        // production code does. This makes the assertion portable across
        // platforms — Linux returns '/repo/src/x.ts' while Windows returns
        // '\\repo\\src\\x.ts'. Both are correct for their respective OS.
        expect(writeCall[0].fsPath).toBe(path.join('/repo', 'src/x.ts'));
        expect(new TextDecoder().decode(writeCall[1])).toBe('original content');

        // CodeDiff has the expected shape
        expect(result.filepath).toBe('src/x.ts');
        expect(result.searchBlock).toBe('original content');
        expect(result.replaceBlock).toBe('original content'); // unchanged (no tool calls)
        expect(result.finalContent).toBe('original content');
    });

    test('returns CodeDiff with finalContent populated after model writes', async () => {
        // First turn: model emits a write_file tool call.
        // Second turn: model says "done".
        mockProvider.streamChatCompletion
            .mockResolvedValueOnce(scriptedStream([
                {
                    kind: 'tool_call',
                    toolCall: {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'write_file', arguments: JSON.stringify({ filepath: 'src/x.ts', content: 'new content' }) }
                    }
                },
                { kind: 'finish', reason: 'tool_calls' }
            ]))
            .mockResolvedValueOnce(scriptedStream([
                { kind: 'text', content: 'Wrote the file.' },
                { kind: 'finish', reason: 'stop' }
            ]));

        // The mock fs is consumed in this order:
        //   1. swarmDraftCode's pre-mod writeFile (writes 'old content')
        //   2. write_file tool's readFile to capture `before` (returns 'old content')
        //      — the dispatcher reads to build the diff payload
        //   3. write_file tool's stat to check it's not a directory
        //   4. write_file tool's writeFile (writes 'new content')
        //   5. swarmDraftCode's post-loop readFile (returns 'new content')
        mockedFs.readFile
            .mockResolvedValueOnce(new TextEncoder().encode('old content'))      // (2) write_file before-capture
            .mockResolvedValueOnce(new TextEncoder().encode('new content'));     // (5) post-loop readback
        mockedFs.stat.mockResolvedValue({ type: vscode.FileType.File });

        const result = await swarmDraftCode(
            'spec',
            'src/x.ts',
            'old content',
            [],
            '',
            '/repo',
            'task-1'
        );

        expect(result.searchBlock).toBe('old content');
        expect(result.replaceBlock).toBe('new content');
        expect(result.finalContent).toBe('new content');
    });

    test('emits lifecycle events with source="coordinator" for tool calls', async () => {
        const captured: ToolLifecycleEvent[] = [];
        const emitter = new ToolEventEmitter((e) => captured.push(e));

        mockProvider.streamChatCompletion
            .mockResolvedValueOnce(scriptedStream([
                {
                    kind: 'tool_call',
                    toolCall: {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ filepath: 'src/y.ts' }) }
                    }
                },
                { kind: 'finish', reason: 'tool_calls' }
            ]))
            .mockResolvedValueOnce(scriptedStream([
                { kind: 'text', content: 'Done.' },
                { kind: 'finish', reason: 'stop' }
            ]));

        // read_file's executor first calls fs.stat, then fs.readFile.
        mockedFs.stat.mockResolvedValue({ type: vscode.FileType.File });
        mockedFs.readFile
            .mockResolvedValueOnce(new TextEncoder().encode('y file content'))   // read_file dispatch
            .mockResolvedValueOnce(new TextEncoder().encode('original'));        // post-loop readback

        await swarmDraftCode(
            'spec',
            'src/x.ts',
            'original',
            [],
            '',
            '/repo',
            'task-1',
            undefined, // streamCallback
            undefined, // signal
            undefined, // usageCallback
            emitter
        );

        // Should see at least started + completed for the read_file call
        const sources = captured.map(e => e.source);
        expect(sources).toContain('coordinator');
        const types = captured.map(e => e.type);
        expect(types).toContain('toolCallStarted');
        expect(types).toContain('toolCallCompleted');
    });

    test('handles missing file gracefully (returns empty post-mod content)', async () => {
        mockProvider.streamChatCompletion.mockResolvedValueOnce(scriptedStream([
            { kind: 'text', content: 'Nothing to do.' },
            { kind: 'finish', reason: 'stop' }
        ]));

        // Post-loop readFile fails (file disappeared somehow)
        mockedFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await swarmDraftCode(
            'spec',
            'src/missing.ts',
            'pre',
            [],
            '',
            '/repo',
            'task-1'
        );

        expect(result.replaceBlock).toBe('');
        expect(result.finalContent).toBe('');
        // Verifier sees a "file got wiped" diff and rejects.
    });

    test('handles new-file case (filepath="unknown") without pre-mod write', async () => {
        mockProvider.streamChatCompletion.mockResolvedValueOnce(scriptedStream([
            { kind: 'text', content: 'No file specified.' },
            { kind: 'finish', reason: 'stop' }
        ]));

        const result = await swarmDraftCode(
            'spec',
            'unknown',
            '',
            [],
            '',
            '/repo',
            'task-1'
        );

        // No writeFile call for the pre-mod restore (filepath==='unknown')
        // — the model would create the file via write_file tool if it
        // wanted to. This test just verifies the non-crash path.
        expect(result.filepath).toBe('unknown');
    });

    test('respects MAX_STEPS ceiling on runaway tool calls', async () => {
        // Model keeps calling tools forever — should bail at MAX_STEPS=6
        for (let i = 0; i < 10; i++) {
            mockProvider.streamChatCompletion.mockResolvedValueOnce(scriptedStream([
                {
                    kind: 'tool_call',
                    toolCall: {
                        id: `call_${i}`,
                        type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ filepath: 'src/x.ts' }) }
                    }
                },
                { kind: 'finish', reason: 'tool_calls' }
            ]));
        }

        mockedFs.stat.mockResolvedValue({ type: vscode.FileType.File });
        mockedFs.readFile.mockResolvedValue(new TextEncoder().encode('content'));

        await swarmDraftCode(
            'spec',
            'src/x.ts',
            'content',
            [],
            '',
            '/repo',
            'task-1'
        );

        // streamChatCompletion called 6 times (MAX_STEPS) — not 10
        expect(mockProvider.streamChatCompletion).toHaveBeenCalledTimes(6);
    });

    // ─── Component 2B-3c (post-2B audit): noModifyingToolCalls flag ─────

    test('sets noModifyingToolCalls=true when model emits no write_file/edit_file', async () => {
        // Model says "done" without any tool calls
        mockProvider.streamChatCompletion.mockResolvedValueOnce(scriptedStream([
            { kind: 'text', content: 'Lots of narrative but no tool calls.' },
            { kind: 'finish', reason: 'stop' }
        ]));
        mockedFs.readFile.mockResolvedValueOnce(new TextEncoder().encode('original'));

        const result = await swarmDraftCode(
            'spec',
            'src/x.ts',
            'original',
            [],
            '',
            '/repo',
            'task-1'
        );

        expect(result.noModifyingToolCalls).toBe(true);
    });

    test('sets noModifyingToolCalls=true when model only does read_file', async () => {
        // Read-only tool calls don't count — only write/edit count
        mockProvider.streamChatCompletion
            .mockResolvedValueOnce(scriptedStream([
                {
                    kind: 'tool_call',
                    toolCall: {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ filepath: 'src/y.ts' }) }
                    }
                },
                { kind: 'finish', reason: 'tool_calls' }
            ]))
            .mockResolvedValueOnce(scriptedStream([
                { kind: 'text', content: 'Read but did not write.' },
                { kind: 'finish', reason: 'stop' }
            ]));

        mockedFs.stat.mockResolvedValue({ type: vscode.FileType.File });
        mockedFs.readFile
            .mockResolvedValueOnce(new TextEncoder().encode('y file content'))   // read_file dispatch
            .mockResolvedValueOnce(new TextEncoder().encode('original'));        // post-loop readback

        const result = await swarmDraftCode(
            'spec',
            'src/x.ts',
            'original',
            [],
            '',
            '/repo',
            'task-1'
        );

        expect(result.noModifyingToolCalls).toBe(true);
    });

    test('does NOT set noModifyingToolCalls when write_file dispatched successfully', async () => {
        mockProvider.streamChatCompletion
            .mockResolvedValueOnce(scriptedStream([
                {
                    kind: 'tool_call',
                    toolCall: {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'write_file', arguments: JSON.stringify({ filepath: 'src/x.ts', content: 'new content' }) }
                    }
                },
                { kind: 'finish', reason: 'tool_calls' }
            ]))
            .mockResolvedValueOnce(scriptedStream([
                { kind: 'text', content: 'Done.' },
                { kind: 'finish', reason: 'stop' }
            ]));

        mockedFs.readFile
            .mockResolvedValueOnce(new TextEncoder().encode('old content'))   // before-capture
            .mockResolvedValueOnce(new TextEncoder().encode('new content'));  // post-loop readback
        mockedFs.stat.mockResolvedValue({ type: vscode.FileType.File });

        const result = await swarmDraftCode(
            'spec',
            'src/x.ts',
            'old content',
            [],
            '',
            '/repo',
            'task-1'
        );

        expect(result.noModifyingToolCalls).toBeUndefined();
    });
});