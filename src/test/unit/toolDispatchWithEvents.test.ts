// src/test/unit/toolDispatchWithEvents.test.ts
//
// Tests for the lifecycle-event-wrapping dispatcher (Component 2B-3).
//
// Verifies:
//   - emits started + completed events around a successful call
//   - emits output events when the executor calls onOutputChunk
//   - status='cancelled' when the signal aborts during dispatch
//   - status='error' when the registry returns kind='error' result
//   - preDispatchHook can block a call (emits started + completed
//     with error status; LLM gets a "Blocked: <reason>" string)
//   - source field defaults to 'coordinator'
//   - source field 'verifier-internal' propagates through (Q8=8C)

jest.mock('vscode', () => ({
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: { fs: { stat: jest.fn(), readFile: jest.fn() } },
    FileType: { Directory: 2, File: 1, SymbolicLink: 64 }
}));

import {
    registerTool,
    resetRegistryForTesting,
    type ToolExecutor
} from '../../agents/toolRegistry';
import { ToolEventEmitter } from '../../agents/toolEventEmitter';
import { dispatchWithEvents } from '../../agents/toolDispatchWithEvents';
import type { ToolLifecycleEvent } from '../../agents/toolProtocol';
import type { ToolDefinition } from '../../llm';

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

describe('dispatchWithEvents — lifecycle event emission', () => {
    let captured: ToolLifecycleEvent[];
    let emitter: ToolEventEmitter;

    beforeEach(() => {
        resetRegistryForTesting();
        captured = [];
        emitter = new ToolEventEmitter((e) => captured.push(e));
    });

    test('emits started + completed for a successful call', async () => {
        const executor: ToolExecutor = async () => ({
            llmContent: 'success',
            uiPayload: { kind: 'string' as const, content: 'success' }
        });
        registerTool(makeDef('foo'), executor);

        const result = await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } },
            { workspaceRoot: '/repo' },
            { emitter, taskId: 'task-1' }
        );

        expect(result.llmContent).toBe('success');
        expect(captured).toHaveLength(2);
        expect(captured[0]?.type).toBe('toolCallStarted');
        expect(captured[1]?.type).toBe('toolCallCompleted');
        expect((captured[1] as { status: string }).status).toBe('success');
    });

    test('emits output events when executor calls onOutputChunk', async () => {
        const executor: ToolExecutor = async (_args, ctx) => {
            ctx.onOutputChunk?.('chunk 1');
            ctx.onOutputChunk?.('chunk 2');
            return { llmContent: 'done', uiPayload: { kind: 'string' as const, content: 'done' } };
        };
        registerTool(makeDef('streamy'), executor);

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'streamy', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            { emitter, taskId: 'task-1' }
        );

        expect(captured).toHaveLength(4); // started + 2 output + completed
        expect(captured[0]?.type).toBe('toolCallStarted');
        expect(captured[1]?.type).toBe('toolCallOutput');
        expect((captured[1] as { chunk: string }).chunk).toBe('chunk 1');
        expect(captured[2]?.type).toBe('toolCallOutput');
        expect((captured[2] as { chunk: string }).chunk).toBe('chunk 2');
        expect(captured[3]?.type).toBe('toolCallCompleted');
    });

    test('preserves caller-supplied onOutputChunk', async () => {
        const callerChunks: string[] = [];
        const executor: ToolExecutor = async (_args, ctx) => {
            ctx.onOutputChunk?.('hello');
            return { llmContent: 'done', uiPayload: { kind: 'string' as const, content: 'done' } };
        };
        registerTool(makeDef('streamy2'), executor);

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'streamy2', arguments: '{}' } },
            {
                workspaceRoot: '/repo',
                onOutputChunk: (chunk) => callerChunks.push(chunk)
            },
            { emitter, taskId: 'task-1' }
        );

        // Caller's handler still receives the chunk
        expect(callerChunks).toEqual(['hello']);
        // AND the emitter received it as an event
        const outputEvents = captured.filter(e => e.type === 'toolCallOutput');
        expect(outputEvents).toHaveLength(1);
    });

    test('completed status is "error" when registry returns kind=error', async () => {
        const executor: ToolExecutor = async () => ({
            llmContent: 'oops',
            uiPayload: { kind: 'error' as const, message: 'something broke' }
        });
        registerTool(makeDef('flaky'), executor);

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'flaky', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            { emitter, taskId: 'task-1' }
        );

        const completed = captured.find(e => e.type === 'toolCallCompleted') as { status: string } | undefined;
        expect(completed?.status).toBe('error');
    });

    test('status="cancelled" when signal aborted during dispatch', async () => {
        const abortCtl = new AbortController();
        const executor: ToolExecutor = async () => {
            // Simulate the signal being aborted mid-execution
            abortCtl.abort();
            return { llmContent: 'done', uiPayload: { kind: 'string' as const, content: 'done' } };
        };
        registerTool(makeDef('aborty'), executor);

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'aborty', arguments: '{}' } },
            { workspaceRoot: '/repo', signal: abortCtl.signal },
            { emitter, taskId: 'task-1' }
        );

        const completed = captured.find(e => e.type === 'toolCallCompleted') as { status: string } | undefined;
        expect(completed?.status).toBe('cancelled');
    });

    test('preDispatchHook can block a call', async () => {
        const executor: ToolExecutor = jest.fn(async () => ({
            llmContent: 'should not reach',
            uiPayload: { kind: 'string' as const, content: 'no' }
        }));
        registerTool(makeDef('dangerous'), executor);

        const result = await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'dangerous', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            {
                emitter,
                taskId: 'task-1',
                preDispatchHook: async () => ({ blocked: true, reason: 'dangerous command' })
            }
        );

        // Executor should NOT have been called
        expect(executor).not.toHaveBeenCalled();

        // Result is an error (LLM sees "Blocked: ...")
        expect(result.uiPayload.kind).toBe('error');
        expect(result.llmContent).toContain('dangerous command');

        // Both started AND completed events emitted (UI shows the
        // attempt + the block)
        expect(captured).toHaveLength(2);
        const completed = captured[1] as { status: string };
        expect(completed.status).toBe('error');
    });

    test('preDispatchHook allowing a call dispatches normally', async () => {
        const executor: ToolExecutor = jest.fn(async () => ({
            llmContent: 'allowed',
            uiPayload: { kind: 'string' as const, content: 'allowed' }
        }));
        registerTool(makeDef('safe'), executor);

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'safe', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            {
                emitter,
                taskId: 'task-1',
                preDispatchHook: async () => ({ blocked: false })
            }
        );

        expect(executor).toHaveBeenCalledTimes(1);
        const completed = captured[1] as { status: string };
        expect(completed.status).toBe('success');
    });

    test('source field defaults to "coordinator"', async () => {
        registerTool(makeDef('foo'), async () => ({
            llmContent: 'ok',
            uiPayload: { kind: 'string' as const, content: 'ok' }
        }));

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            { emitter, taskId: 'task-1' }
        );

        expect(captured[0]?.source).toBe('coordinator');
    });

    test('source field can be overridden to "verifier-internal" (Q8=8C)', async () => {
        registerTool(makeDef('foo'), async () => ({
            llmContent: 'ok',
            uiPayload: { kind: 'string' as const, content: 'ok' }
        }));

        await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            { emitter, taskId: 'task-1', source: 'verifier-internal' }
        );

        expect(captured[0]?.source).toBe('verifier-internal');
        expect(captured[1]?.source).toBe('verifier-internal');
    });

    test('no emitter = silent dispatch (events dropped)', async () => {
        registerTool(makeDef('quiet'), async () => ({
            llmContent: 'silent',
            uiPayload: { kind: 'string' as const, content: 'silent' }
        }));

        const result = await dispatchWithEvents(
            { id: 'c1', type: 'function', function: { name: 'quiet', arguments: '{}' } },
            { workspaceRoot: '/repo' },
            {} // no emitter
        );

        expect(result.llmContent).toBe('silent');
        expect(captured).toHaveLength(0);
    });
});