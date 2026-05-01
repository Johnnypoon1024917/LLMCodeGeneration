// src/test/unit/ReAct/ReActEngine.test.ts
//
// Integration tests for the shared ReAct engine. Mocks the LLM
// provider and dispatchWithEvents so the engine's loop semantics can
// be exercised against scripted assistant responses.
//
// What we test:
//   - Basic loop: tool calls dispatched, tool results pushed back,
//     model emits final content, loop terminates
//   - Termination check: isDone() controls when the loop ends
//   - maxSteps cap: loop returns best-effort content when limit hit
//   - Re-prompt: non-tool, non-done turn appends the configured
//     re-prompt and continues (vs returning, when no re-prompt)
//   - Hardening flags wire correctly through to the guard classes
//   - Custom tool resolvers route around dispatchWithEvents
//   - Configuration validation rejects bad configs early
//   - Emitter + taskId requirement enforced
//
// What we DON'T test:
//   - Internal guard logic — covered by loopGuards.test.ts
//   - Actual tool execution — that's dispatchWithEvents/registry's job
//   - HTTP wire format — that's the Provider's job
//
// Test mocking approach mirrors planAgent.test.ts:
//   - Mock dispatchWithEvents to return scripted results
//   - Mock the Provider to play scripted assistant responses
//   - All other dependencies stubbed at jest.mock time

const mockDispatchWithEvents = jest.fn();
jest.mock('../../../agents/toolDispatchWithEvents', () => ({
    dispatchWithEvents: mockDispatchWithEvents
}));

const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamChatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn(),
};
jest.mock('../../../llm', () => ({
    getProvider: async () => mockProvider
}));

// Import under test AFTER mocks are wired.
import { runReAct } from '../../../agents/ReAct/ReActEngine';
import {
    ReActStuckLoopError,
    ReActBudgetExceededError
} from '../../../agents/ReAct/ReActConfig';
import type { ReActConfig } from '../../../agents/ReAct/ReActConfig';
import type { AssistantMessage, ToolDefinition } from '../../../llm';

// ─── Test fixtures ───────────────────────────────────────────────────

const READ_FILE_TOOL: ToolDefinition = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: { filepath: { type: 'string' } },
            required: ['filepath']
        }
    }
};

const allowAllHook = async () => ({ blocked: false as const });

/**
 * Build a minimal valid ReActConfig with sensible test defaults.
 * Tests can override individual fields by spreading.
 */
function makeConfig(overrides: Partial<ReActConfig> = {}): ReActConfig {
    return {
        systemPrompt: 'system',
        userPrompt: 'user',
        tools: [READ_FILE_TOOL],
        workspaceRoot: '/repo',
        maxSteps: 4,
        isDone: (c: string) => c.includes('DONE'),
        preDispatchHook: allowAllHook,
        eventSource: 'planner',
        log: () => undefined,
        ...overrides
    };
}

/**
 * Helper to script a sequence of assistant responses against the
 * mocked provider. Each call to chatCompletion pulls the next
 * response off the array.
 */
function scriptResponses(responses: AssistantMessage[]): void {
    let idx = 0;
    mockProvider.chatCompletion.mockImplementation(async () => {
        if (idx >= responses.length) {
            throw new Error(`Mock chatCompletion ran out of scripted responses (idx=${idx})`);
        }
        return responses[idx++]!;
    });
}

beforeEach(() => {
    mockProvider.chatCompletion.mockReset();
    mockProvider.streamChatCompletion.mockReset();
    mockDispatchWithEvents.mockReset();
});

// ─── Basic loop semantics ────────────────────────────────────────────

describe('runReAct — basic loop', () => {
    test('returns final content when first turn is non-tool and isDone matches', async () => {
        scriptResponses([
            { role: 'assistant', content: 'Here is the DONE answer.' }
        ]);

        const result = await runReAct(makeConfig());

        expect(result.completedNormally).toBe(true);
        expect(result.finalContent).toContain('DONE');
        expect(result.totalSteps).toBe(1);
        expect(result.totalToolCalls).toBe(0);
    });

    test('dispatches tool calls and accumulates tool results before termination', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function' as const,
                    function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
                }]
            },
            { role: 'assistant', content: 'Read complete. DONE.' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'file contents here',
            uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: 'X' }
        });

        const result = await runReAct(makeConfig());

        expect(result.completedNormally).toBe(true);
        expect(result.totalToolCalls).toBe(1);
        expect(result.totalSteps).toBe(2);
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('handles multiple tool calls in a single turn', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } },
                    { id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' } }
                ]
            },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data',
            uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        const result = await runReAct(makeConfig());

        expect(result.totalToolCalls).toBe(2);
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(2);
    });

    test('returns best-effort content when maxSteps is reached without termination', async () => {
        // 3 turns of tool calls, then we hit maxSteps=3.
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' } }] },
            // Note: no occurrence of 'DONE' anywhere — the previous version
            // accidentally included 'DONE' as part of the phrase "no DONE
            // here", which matched isDone's substring check.
            { role: 'assistant', content: 'best effort, still exploring' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        const result = await runReAct(makeConfig({ maxSteps: 3 }));

        expect(result.completedNormally).toBe(false);
        expect(result.totalSteps).toBe(3);
        expect(result.finalContent).toContain('best effort');
    });

    test('captures all assistant messages produced during the run', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: '', uiPayload: { kind: 'file_contents', filepath: '', contents: '' }
        });

        const result = await runReAct(makeConfig());

        expect(result.assistantMessages).toHaveLength(2);
        expect(result.assistantMessages[0]?.tool_calls).toBeDefined();
        expect(result.assistantMessages[1]?.content).toContain('DONE');
    });
});

// ─── Re-prompt behavior ──────────────────────────────────────────────

describe('runReAct — re-prompt vs return on non-done non-tool turn', () => {
    test('without repromptOnNonDone, non-tool non-done turn ends the loop (Coder pattern)', async () => {
        scriptResponses([
            { role: 'assistant', content: 'I am chatting but not saying DONE.' }
        ]);

        const result = await runReAct(makeConfig());

        // Without re-prompt configured, non-tool turn = completion.
        expect(result.completedNormally).toBe(true);
        expect(result.finalContent).toContain('chatting');
        expect(result.totalSteps).toBe(1);
    });

    test('with repromptOnNonDone, non-tool non-done turn re-prompts and continues', async () => {
        scriptResponses([
            { role: 'assistant', content: 'I am chatting but not saying the magic word.' },
            { role: 'assistant', content: 'OK fine — DONE.' }
        ]);

        const reprompts: number[] = [];
        const result = await runReAct(makeConfig({
            repromptOnNonDone: (turn) => {
                reprompts.push(turn);
                return 'Please emit DONE.';
            }
        }));

        expect(result.completedNormally).toBe(true);
        expect(result.totalSteps).toBe(2);
        expect(reprompts).toEqual([1]);
        expect(result.finalContent).toContain('DONE');
    });
});

// ─── Hardening flags ─────────────────────────────────────────────────

describe('runReAct — hardening flags', () => {
    test('stuck-loop detector throws when consecutive turns have identical tool calls', async () => {
        const sameCall = {
            id: 'c1', type: 'function' as const,
            function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
        };
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [sameCall] },
            { role: 'assistant', content: null, tool_calls: [{ ...sameCall, id: 'c2' }] },
            // Should never reach the third response — engine throws first.
            { role: 'assistant', content: 'unreachable' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await expect(runReAct(makeConfig({
            hardening: { enableStuckLoopDetector: true }
        }))).rejects.toThrow(ReActStuckLoopError);
    });

    test('stuck-loop detector does not fire when call args differ across turns', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        const result = await runReAct(makeConfig({
            hardening: { enableStuckLoopDetector: true }
        }));
        expect(result.completedNormally).toBe(true);
    });

    test('dedup cache short-circuits identical calls and feeds back synthetic message', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'real data', uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: 'X' }
        });

        const result = await runReAct(makeConfig({
            hardening: { enableDedupCache: true }
        }));

        expect(result.completedNormally).toBe(true);
        // dispatchWithEvents called only ONCE — second call was deduped.
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('dedup cache disabled by default — duplicate calls re-dispatch', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await runReAct(makeConfig());

        // No dedup → both calls dispatched.
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(2);
    });

    test('stuck-detector + dedup layered defense: dedup hits do NOT trigger stuck (regression for user-reported abort)', async () => {
        // The user-reported bug: model emits the same tool call two
        // turns in a row. The OLD ordering checked the stuck-detector
        // BEFORE dispatching, so the second turn aborted with
        // "ReAct loop stuck" before the dedup cache had a chance to
        // feed back the synthetic "already dispatched" message.
        //
        // The fix reorders the per-turn flow: dispatch first (dedup
        // short-circuits during dispatch), THEN compute the stuck-
        // detector signature from the NON-DEDUPED calls only. If
        // every call this turn was deduped, the signature is empty
        // and the stuck-detector cannot fire. The dedup synthetic
        // messages flow back to the model and it gets a chance to
        // recover (typically by emitting the final output instead of
        // re-reading).
        const sameCall = {
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
        };
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', ...sameCall }] },
            // Same args, different id (the model's call_ids vary
            // turn-to-turn; what matters for both dedup and stuck is
            // the (name, args) tuple).
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', ...sameCall }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: '' }
        });

        // BOTH stuck-detector and dedup enabled — same as the planner
        // configuration. The fix means stuck-detector doesn't pre-empt
        // dedup; the session completes normally on turn 3.
        const result = await runReAct(makeConfig({
            hardening: {
                enableStuckLoopDetector: true,
                enableDedupCache: true
            }
        }));

        expect(result.completedNormally).toBe(true);
        // First turn dispatched, second turn deduped (no real dispatch),
        // third turn was non-tool (no dispatch).
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('total-call budget throws when cumulative count exceeds limit', async () => {
        scriptResponses([
            {
                role: 'assistant', content: null, tool_calls: [
                    { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } },
                    { id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' } },
                    { id: 'c3', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"c.ts"}' } }
                ]
            }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await expect(runReAct(makeConfig({
            hardening: { enableTotalCallBudget: true },
            maxTotalToolCalls: 2
        }))).rejects.toThrow(ReActBudgetExceededError);
    });
});

// ─── Custom tool resolvers ───────────────────────────────────────────

describe('runReAct — custom tool resolvers', () => {
    test('routes calls to custom resolver when name not in registered tools', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'grep_search', arguments: '{"pattern":"foo"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);

        let resolverCalledWith: { pattern?: string } | null = null;
        const result = await runReAct(makeConfig({
            customToolResolvers: {
                grep_search: async (toolCall) => {
                    resolverCalledWith = JSON.parse(toolCall.function.arguments);
                    return { llmContent: 'grep results: nothing' };
                }
            }
        }));

        expect(result.completedNormally).toBe(true);
        expect(resolverCalledWith).toEqual({ pattern: 'foo' });
        // Standard dispatchWithEvents path NOT used for custom-resolved calls.
        expect(mockDispatchWithEvents).not.toHaveBeenCalled();
    });

    test('falls through to dispatchWithEvents when call name is NOT in customToolResolvers', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await runReAct(makeConfig({
            customToolResolvers: {
                grep_search: async () => ({ llmContent: 'grep' })
                // read_file is NOT in customToolResolvers — falls through.
            }
        }));

        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });
});

// ─── onToolDispatched callback ───────────────────────────────────────

describe('runReAct — onToolDispatched callback', () => {
    test('invoked once per dispatched tool call, with both the call and result', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        const dispatchResult = {
            llmContent: 'X',
            uiPayload: { kind: 'file_contents' as const, filepath: 'x', contents: '' }
        };
        mockDispatchWithEvents.mockResolvedValue(dispatchResult);

        const observed: Array<{ name: string; resultContent: string }> = [];
        await runReAct(makeConfig({
            onToolDispatched: (call, result) => {
                observed.push({ name: call.function.name, resultContent: result.llmContent });
            }
        }));

        expect(observed).toEqual([{ name: 'read_file', resultContent: 'X' }]);
    });

    test('NOT invoked for dedup-shortcircuited calls (no real dispatch happened)', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function' as const, function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        const observed: string[] = [];
        await runReAct(makeConfig({
            hardening: { enableDedupCache: true },
            onToolDispatched: (call) => observed.push(call.id)
        }));

        // First call dispatched (c1). Second call (c2) deduped — no
        // dispatch happened, so no callback.
        expect(observed).toEqual(['c1']);
    });

    test('invoked for custom-resolver dispatches too (C-3 added uniformity)', async () => {
        // Earlier the engine only fired onToolDispatched for the
        // standard registered-tool path (dispatchWithEvents). C-3
        // unified this — custom resolvers also fire the callback so
        // that callers like PlannerAgent's explore mode can accumulate
        // tool results uniformly across resolution paths.
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'grep_search', arguments: '{"pattern":"foo"}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);

        const observed: Array<{ name: string; resultContent: string }> = [];
        await runReAct(makeConfig({
            customToolResolvers: {
                grep_search: async () => ({
                    llmContent: 'grep output: 3 matches'
                })
            },
            onToolDispatched: (call, result) => {
                observed.push({ name: call.function.name, resultContent: result.llmContent });
            }
        }));

        expect(observed).toEqual([
            { name: 'grep_search', resultContent: 'grep output: 3 matches' }
        ]);
        // Custom resolver path doesn't call dispatchWithEvents.
        expect(mockDispatchWithEvents).not.toHaveBeenCalled();
    });
});

// ─── Configuration validation ────────────────────────────────────────

describe('runReAct — configuration validation', () => {
    test('rejects maxSteps <= 0', async () => {
        await expect(runReAct(makeConfig({ maxSteps: 0 })))
            .rejects.toThrow(/maxSteps must be > 0/);
    });

    test('rejects emitter without taskId', async () => {
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../../agents/toolEventEmitter').ToolEventEmitter;
        await expect(runReAct(makeConfig({
            emitter: fakeEmitter,
            // No taskId.
        }))).rejects.toThrow(/taskId/);
    });

    test('accepts emitter when taskId is provided', async () => {
        scriptResponses([
            { role: 'assistant', content: 'DONE' }
        ]);
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../../agents/toolEventEmitter').ToolEventEmitter;

        const result = await runReAct(makeConfig({
            emitter: fakeEmitter,
            taskId: 'task-1'
        }));
        expect(result.completedNormally).toBe(true);
    });
});

// ─── Emitter wiring ──────────────────────────────────────────────────

describe('runReAct — emitter wiring', () => {
    test('passes emitter and taskId through to dispatchWithEvents when provided', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'X', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../../agents/toolEventEmitter').ToolEventEmitter;

        await runReAct(makeConfig({
            emitter: fakeEmitter,
            taskId: 'my-task',
            eventSource: 'planner'
        }));

        const dispatchCall = mockDispatchWithEvents.mock.calls[0];
        expect(dispatchCall).toBeDefined();
        const opts = dispatchCall![2];
        expect(opts.emitter).toBe(fakeEmitter);
        expect(opts.taskId).toBe('my-task');
        expect(opts.source).toBe('planner');
    });

    test('omits emitter from dispatch options when caller does not provide one', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'X', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await runReAct(makeConfig());

        const dispatchCall = mockDispatchWithEvents.mock.calls[0];
        const opts = dispatchCall![2];
        expect(opts.emitter).toBeUndefined();
        expect(opts.taskId).toBeUndefined();
    });
});

// ─── Provider integration ────────────────────────────────────────────

describe('runReAct — provider integration', () => {
    test('forwards tools and toolChoice to chatCompletion on every turn', async () => {
        scriptResponses([
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'assistant', content: 'DONE' }
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'X', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        await runReAct(makeConfig());

        expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(2);
        const firstCall = mockProvider.chatCompletion.mock.calls[0];
        expect(firstCall).toBeDefined();
        const opts = firstCall![1];
        expect(opts.tools).toBeDefined();
        expect(opts.toolChoice).toBe('auto');
    });

    test('forwards abort signal to chatCompletion when configured', async () => {
        scriptResponses([
            { role: 'assistant', content: 'DONE' }
        ]);
        const ctrl = new AbortController();
        await runReAct(makeConfig({ abortSignal: ctrl.signal }));

        const firstCall = mockProvider.chatCompletion.mock.calls[0];
        const opts = firstCall![1];
        expect(opts.signal).toBe(ctrl.signal);
    });

    test('forwards usageCallback through to chatCompletion onUsage', async () => {
        scriptResponses([
            { role: 'assistant', content: 'DONE' }
        ]);
        const usageCalls: unknown[] = [];
        await runReAct(makeConfig({
            usageCallback: (u) => usageCalls.push(u)
        }));

        const opts = mockProvider.chatCompletion.mock.calls[0]![1];
        expect(opts.onUsage).toBeDefined();

        // Simulate the provider invoking onUsage.
        opts.onUsage!({ prompt_tokens: 100, completion_tokens: 50 });
        expect(usageCalls).toHaveLength(1);
    });
});

// ─── Streaming variant (C-4) ────────────────────────────────────────

import { runReActStreaming } from '../../../agents/ReAct/ReActEngine';
import type { ChatCompletionDelta } from '../../../llm';

/**
 * Build an async generator that yields scripted deltas for one
 * streaming turn. Mirrors the wire shape produced by Provider.streamChatCompletion.
 */
function streamFromDeltas(deltas: ChatCompletionDelta[]): AsyncIterable<ChatCompletionDelta> {
    return (async function* () {
        for (const d of deltas) yield d;
    })();
}

/**
 * Script a sequence of streaming responses. Each entry is the delta
 * list for one turn of the loop.
 */
function scriptStreamResponses(turnDeltaLists: ChatCompletionDelta[][]): void {
    let idx = 0;
    mockProvider.streamChatCompletion.mockImplementation(async () => {
        if (idx >= turnDeltaLists.length) {
            throw new Error(
                `Mock streamChatCompletion ran out of scripted responses (idx=${idx})`
            );
        }
        return streamFromDeltas(turnDeltaLists[idx++]!);
    });
}

describe('runReActStreaming — basic loop semantics', () => {
    test('streams text deltas to the streamCallback as they arrive', async () => {
        scriptStreamResponses([[
            { kind: 'text', content: 'Hello ' },
            { kind: 'text', content: 'world. ' },
            { kind: 'text', content: 'DONE' },
            { kind: 'finish', reason: 'stop' }
        ]]);

        const tokens: string[] = [];
        const result = await runReActStreaming(makeConfig({
            streamCallback: (t) => tokens.push(t)
        }));

        expect(tokens).toEqual(['Hello ', 'world. ', 'DONE']);
        expect(result.completedNormally).toBe(true);
        expect(result.finalContent).toBe('Hello world. DONE');
    });

    test('accumulates full text content even when streamCallback is undefined', async () => {
        // Test/CLI contexts may want streaming semantics without a UI
        // surface. The accumulator should still produce the full
        // assistant message correctly.
        scriptStreamResponses([[
            { kind: 'text', content: 'partial ' },
            { kind: 'text', content: 'reply DONE' },
            { kind: 'finish', reason: 'stop' }
        ]]);

        const result = await runReActStreaming(makeConfig());
        expect(result.finalContent).toBe('partial reply DONE');
    });

    test('dispatches tool calls received as stream deltas, then continues', async () => {
        const toolCall = {
            id: 'c1', type: 'function' as const,
            function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
        };
        scriptStreamResponses([
            // Turn 1: model emits tool call (no text content), finishes with tool_calls.
            [
                { kind: 'tool_call', toolCall },
                { kind: 'finish', reason: 'tool_calls' }
            ],
            // Turn 2: model produces final text, finishes with stop.
            [
                { kind: 'text', content: 'Read complete. DONE.' },
                { kind: 'finish', reason: 'stop' }
            ]
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'file contents here',
            uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: 'X' }
        });

        const result = await runReActStreaming(makeConfig());

        expect(result.completedNormally).toBe(true);
        expect(result.totalToolCalls).toBe(1);
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('returns best-effort content with completedNormally=false on length finish', async () => {
        // Model hit token limit mid-output. Treat as soft completion.
        scriptStreamResponses([[
            { kind: 'text', content: 'This is partial output that got cut' },
            { kind: 'finish', reason: 'length' }
        ]]);

        const result = await runReActStreaming(makeConfig());
        expect(result.completedNormally).toBe(false);
        expect(result.finalContent).toContain('partial');
    });

    test('returns best-effort with warning on unexpected finish reason', async () => {
        // Provider emitted some finish reason we don't specifically
        // handle (e.g., 'content_filter'). Should log + return rather
        // than throw.
        scriptStreamResponses([[
            { kind: 'text', content: 'cut off' },
            { kind: 'finish', reason: 'content_filter' }
        ]]);

        const logs: string[] = [];
        const result = await runReActStreaming(makeConfig({
            log: (msg) => logs.push(msg)
        }));

        expect(result.completedNormally).toBe(false);
        expect(logs.some(l => l.includes('content_filter'))).toBe(true);
    });
});

describe('runReActStreaming — shared semantics with non-streaming', () => {
    test('respects maxSteps cap (best-effort return at last step)', async () => {
        const toolCall = (id: string, fp: string) => ({
            id, type: 'function' as const,
            function: { name: 'read_file', arguments: `{"filepath":"${fp}"}` }
        });
        scriptStreamResponses([
            [{ kind: 'tool_call', toolCall: toolCall('c1', 'a.ts') }, { kind: 'finish', reason: 'tool_calls' }],
            [{ kind: 'tool_call', toolCall: toolCall('c2', 'b.ts') }, { kind: 'finish', reason: 'tool_calls' }],
            // 3rd turn: non-tool, non-done → step === maxSteps - 1 → best-effort.
            [{ kind: 'text', content: 'still investigating' }, { kind: 'finish', reason: 'stop' }]
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'x', contents: '' }
        });

        const result = await runReActStreaming(makeConfig({ maxSteps: 3 }));

        expect(result.completedNormally).toBe(false);
        expect(result.totalSteps).toBe(3);
    });

    test('dedup cache works the same way as in non-streaming runReAct', async () => {
        const sameCall = (id: string) => ({
            id, type: 'function' as const,
            function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
        });
        scriptStreamResponses([
            [{ kind: 'tool_call', toolCall: sameCall('c1') }, { kind: 'finish', reason: 'tool_calls' }],
            [{ kind: 'tool_call', toolCall: sameCall('c2') }, { kind: 'finish', reason: 'tool_calls' }],
            [{ kind: 'text', content: 'DONE' }, { kind: 'finish', reason: 'stop' }]
        ]);
        mockDispatchWithEvents.mockResolvedValue({
            llmContent: 'data', uiPayload: { kind: 'file_contents', filepath: 'a.ts', contents: '' }
        });

        const result = await runReActStreaming(makeConfig({
            hardening: { enableDedupCache: true }
        }));

        expect(result.completedNormally).toBe(true);
        // First call dispatched, second call deduped.
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });

    test('forwards tools and toolChoice to streamChatCompletion', async () => {
        scriptStreamResponses([[
            { kind: 'text', content: 'DONE' },
            { kind: 'finish', reason: 'stop' }
        ]]);

        await runReActStreaming(makeConfig());

        expect(mockProvider.streamChatCompletion).toHaveBeenCalledTimes(1);
        const opts = mockProvider.streamChatCompletion.mock.calls[0]![1];
        expect(opts.tools).toBeDefined();
        expect(opts.toolChoice).toBe('auto');
    });

    test('forwards abort signal to streamChatCompletion', async () => {
        scriptStreamResponses([[
            { kind: 'text', content: 'DONE' },
            { kind: 'finish', reason: 'stop' }
        ]]);

        const ctrl = new AbortController();
        await runReActStreaming(makeConfig({ abortSignal: ctrl.signal }));

        const opts = mockProvider.streamChatCompletion.mock.calls[0]![1];
        expect(opts.signal).toBe(ctrl.signal);
    });

    test('rejects misconfiguration the same way as runReAct (maxSteps <= 0)', async () => {
        await expect(runReActStreaming(makeConfig({ maxSteps: 0 })))
            .rejects.toThrow(/maxSteps must be > 0/);
    });

    test('rejects emitter without taskId', async () => {
        const fakeEmitter = { emit: jest.fn() } as unknown as import('../../../agents/toolEventEmitter').ToolEventEmitter;
        await expect(runReActStreaming(makeConfig({
            emitter: fakeEmitter
        }))).rejects.toThrow(/taskId/);
    });
});