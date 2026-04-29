// src/test/unit/planAgent.test.ts
//
// Mock-Provider tests for planAgent's ReAct loop (Component 2A, Q6b lock).
//
// What we test:
//   - The loop calls executeAgentTool with the tool calls the model emits
//   - Messages accumulate correctly: assistant message → tool result(s) → next assistant
//   - Loop terminates when the model produces final XML content
//   - MAX_STEPS guard fires when the model loops indefinitely
//   - Empty content + no tool_calls triggers a re-prompt
//
// What we DON'T test:
//   - The actual tool execution (read_file etc) — that's executeAgentTool's
//     responsibility, separately covered (or not — it's currently untested
//     and that's a separate gap)
//   - The HTTP wire format — that's covered by the OpenAICompatibleProvider
//     tests in provider.test.ts
//   - The system prompt content — verifying its exact wording is brittle
//     and not what these tests are protecting
//
// Why these tests exist (paranoia mode per Q6b):
// The migration from inline `resilientFetch + manual response.json()` to
// `provider.chatCompletion` could introduce subtle accumulation bugs
// (wrong message order, dropped tool results, stuck loop) that compile
// cleanly and run silently with degraded plan quality. These tests
// exercise the loop's state machine against a scripted Provider mock,
// catching any drift in loop semantics.

// Component 2B-3b migration: planAgent now uses dispatchWithEvents
// (not the legacy executeAgentTool shim). Mock that module + the
// registry's getToolDefinitions. The behavior we want to verify is
// unchanged: ReAct loop, message accumulation, MAX_STEPS guard.
//
// vscode itself uses the shared mock at __mocks__/vscode.ts.

const mockDispatchWithEvents = jest.fn();
jest.mock('../../agents/toolDispatchWithEvents', () => ({
    dispatchWithEvents: mockDispatchWithEvents
}));

jest.mock('../../agents/toolRegistry', () => ({
    getToolDefinitions: (_names: string[]) => [
        {
            type: 'function',
            function: { name: 'read_file', description: 'r', parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } }
        },
        {
            type: 'function',
            function: { name: 'list_directory', description: 'l', parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] } }
        }
    ]
}));

// Stub the tools barrel so its registerTool side effects don't fire
// at import time (we don't use the registry in tests; we mock it).
jest.mock('../../agents/tools', () => ({}));

// Stub securityHook (planAgent uses allowAllHook).
jest.mock('../../agents/securityHook', () => ({
    allowAllHook: async () => ({ blocked: false })
}));

// Mock the Provider factory so planAgent gets our scripted MockProvider.
const mockProvider = {
    name: 'mock',
    endpoint: 'http://mock',
    model: 'mock',
    chatCompletion: jest.fn(),
    streamCompletion: jest.fn(),
    completion: jest.fn(),
    jsonCompletion: jest.fn(),
    listModels: jest.fn(),
};
jest.mock('../../llm', () => ({
    getProvider: async () => mockProvider
}));

// Import under test AFTER mocks are wired.
import { runPlannerAgent } from '../../agents/planAgent';
import type { AssistantMessage } from '../../llm';

describe('planAgent — ReAct loop (Component 2A)', () => {
    let logCalls: Array<{ msg: string; stepType?: string; details?: string }>;
    const log = (msg: string, stepType?: string, details?: string) => {
        const entry: { msg: string; stepType?: string; details?: string } = { msg };
        if (stepType !== undefined) entry.stepType = stepType;
        if (details !== undefined) entry.details = details;
        logCalls.push(entry);
    };

    beforeEach(() => {
        logCalls = [];
        capturedSnapshots = [];
        mockProvider.chatCompletion.mockReset();
        mockDispatchWithEvents.mockReset();
    });

    /**
     * Helper: scripted assistant responses played in order. Each call
     * to provider.chatCompletion pulls the next response off this list.
     *
     * Important: we deep-clone the messages array on each call. Jest's
     * mock argument capture stores a reference, but planAgent mutates
     * the messages array between calls (push assistant response, push
     * tool results). Without a snapshot, every test that inspects
     * `mock.calls[N][0]` sees the FINAL state of the array, not the
     * state at call N. Cloning at capture time gives us correct
     * per-call snapshots.
     */
    function scriptResponses(responses: AssistantMessage[]): void {
        let idx = 0;
        mockProvider.chatCompletion.mockImplementation(async (messages: SnapshotMessage[]) => {
            // Snapshot the messages array as-of THIS call, not whenever
            // the test inspects mock.calls.
            capturedSnapshots.push(JSON.parse(JSON.stringify(messages)));
            if (idx >= responses.length) {
                throw new Error(`planAgent called provider.chatCompletion more than ${responses.length} times — script exhausted`);
            }
            const r = responses[idx++];
            return r;
        });
    }

    /**
     * Loose shape covering all the messages that flow through planAgent's
     * loop. Tests inspect specific fields based on the role; this union
     * lets TypeScript narrow correctly when we check `.role` first.
     */
    interface SnapshotMessage {
        role: 'system' | 'user' | 'assistant' | 'tool';
        content?: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
    }
    let capturedSnapshots: SnapshotMessage[][];

    test('returns final content when model emits XML plan immediately (no tools)', async () => {
        scriptResponses([
            {
                role: 'assistant',
                content: '<analysis>direct</analysis><files_to_modify><file>x.ts</file></files_to_modify><execution_plan>do thing</execution_plan><verification_rules>- works</verification_rules>'
            }
        ]);

        const result = await runPlannerAgent(
            'add a feature', '/repo', 'hint', '', '', '', '', log
        );

        expect(result).toContain('<execution_plan>');
        expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(1);
        expect(mockDispatchWithEvents).not.toHaveBeenCalled();
    });

    test('executes tool calls and accumulates results before final plan', async () => {
        // Scripted three-call sequence:
        //   1. Model calls read_file
        //   2. Model calls list_directory (after seeing read_file's result)
        //   3. Model emits final plan
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"filepath":"src/foo.ts"}' }
                }]
            },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_2',
                    type: 'function',
                    function: { name: 'list_directory', arguments: '{"dirpath":"src"}' }
                }]
            },
            {
                role: 'assistant',
                content: '<analysis>...</analysis><execution_plan>plan</execution_plan>'
            }
        ]);
        mockDispatchWithEvents
            .mockResolvedValueOnce({ llmContent: 'contents of foo.ts', uiPayload: { kind: 'string', content: 'contents of foo.ts' } })
            .mockResolvedValueOnce({ llmContent: 'files: foo.ts, bar.ts', uiPayload: { kind: 'string', content: 'files: foo.ts, bar.ts' } });

        const result = await runPlannerAgent(
            'something', '/repo', '', '', '', '', '', log
        );

        expect(result).toContain('<execution_plan>');
        expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(3);
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(2);

        // Verify message accumulation: each chatCompletion call should
        // have received an extended messages array.
        const firstMessages = capturedSnapshots[0]!;
        const secondMessages = capturedSnapshots[1]!;
        const thirdMessages = capturedSnapshots[2]!;

        // First call: just system + user
        expect(firstMessages).toHaveLength(2);
        expect(firstMessages[0]!.role).toBe('system');
        expect(firstMessages[1]!.role).toBe('user');

        // Second call: system + user + assistant(tool_call_1) + tool_result_1
        expect(secondMessages).toHaveLength(4);
        expect(secondMessages[2]!.role).toBe('assistant');
        expect(secondMessages[2]!.tool_calls?.[0]?.id).toBe('call_1');
        expect(secondMessages[3]!.role).toBe('tool');
        expect(secondMessages[3]!.tool_call_id).toBe('call_1');
        expect(secondMessages[3]!.content).toBe('contents of foo.ts');

        // Third call: + assistant(tool_call_2) + tool_result_2
        expect(thirdMessages).toHaveLength(6);
        expect(thirdMessages[4]!.role).toBe('assistant');
        expect(thirdMessages[4]!.tool_calls?.[0]?.id).toBe('call_2');
        expect(thirdMessages[5]!.role).toBe('tool');
        expect(thirdMessages[5]!.tool_call_id).toBe('call_2');
    });

    test('handles multiple tool calls in a single assistant message', async () => {
        // Some models emit multiple tool_calls in one turn (parallel
        // tool use). The loop should execute all and append all
        // results before the next assistant turn.
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'parallel_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"filepath":"a.ts"}' }
                    },
                    {
                        id: 'parallel_2',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"filepath":"b.ts"}' }
                    }
                ]
            },
            {
                role: 'assistant',
                content: '<execution_plan>...</execution_plan>'
            }
        ]);
        mockDispatchWithEvents
            .mockResolvedValueOnce({ llmContent: 'a.ts contents', uiPayload: { kind: 'string', content: 'a.ts contents' } })
            .mockResolvedValueOnce({ llmContent: 'b.ts contents', uiPayload: { kind: 'string', content: 'b.ts contents' } });

        await runPlannerAgent('x', '/repo', '', '', '', '', '', log);

        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(2);
        // Second chatCompletion call: should see system, user, assistant
        // (with 2 tool_calls), tool_result_1, tool_result_2 — five messages.
        const secondCallMessages = capturedSnapshots[1]!;
        expect(secondCallMessages).toHaveLength(5);
        expect(secondCallMessages[3]!.role).toBe('tool');
        expect(secondCallMessages[3]!.tool_call_id).toBe('parallel_1');
        expect(secondCallMessages[4]!.role).toBe('tool');
        expect(secondCallMessages[4]!.tool_call_id).toBe('parallel_2');
    });

    test('re-prompts when assistant produces neither tools nor final plan', async () => {
        // Model produces "I'll think about it" — no tools, no XML.
        // Loop should re-prompt with stricter instructions.
        scriptResponses([
            {
                role: 'assistant',
                content: 'I will think about it carefully'
            },
            {
                role: 'assistant',
                content: '<execution_plan>now I have it</execution_plan>'
            }
        ]);

        const result = await runPlannerAgent('x', '/repo', '', '', '', '', '', log);

        expect(result).toContain('<execution_plan>');
        // First chat call: 2 messages (system + user)
        // Second chat call: should have 4 messages (orig 2 + assistant non-plan + re-prompt)
        const secondCallMessages = capturedSnapshots[1]!;
        expect(secondCallMessages).toHaveLength(4);
        expect(secondCallMessages[2]!.role).toBe('assistant');
        expect(secondCallMessages[2]!.content).toBe('I will think about it carefully');
        expect(secondCallMessages[3]!.role).toBe('user');
        expect(secondCallMessages[3]!.content).toContain('emit the final plan');
    });

    test('returns best-effort content when MAX_STEPS reached', async () => {
        // Model never emits the XML plan — keeps producing prose.
        // Loop should hit MAX_STEPS (8) and return the last content.
        const wanderingResponses: AssistantMessage[] = [];
        for (let i = 0; i < 8; i++) {
            wanderingResponses.push({
                role: 'assistant',
                content: `step ${i}: still thinking`
            });
        }
        scriptResponses(wanderingResponses);

        const result = await runPlannerAgent('x', '/repo', '', '', '', '', '', log);

        // Should return the LAST message's content
        expect(result).toBe('step 7: still thinking');
        expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(8);
        // Should have logged a step-limit warning
        const warningLog = logCalls.find(c => c.stepType === 'warning');
        expect(warningLog?.msg).toContain('Step limit reached');
    });

    test('passes tools and toolChoice through to chatCompletion options', async () => {
        scriptResponses([
            { role: 'assistant', content: '<execution_plan>done</execution_plan>' }
        ]);

        await runPlannerAgent('x', '/repo', '', '', '', '', '', log);

        expect(mockProvider.chatCompletion).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
                tools: expect.any(Array),
                toolChoice: 'auto',
                temperature: 0.2
            })
        );
        // Verify the tools array carries the correct names
        const opts = mockProvider.chatCompletion.mock.calls[0][1];
        const toolNames = opts.tools.map((t: { function: { name: string } }) => t.function.name);
        expect(toolNames).toContain('read_file');
        expect(toolNames).toContain('list_directory');
    });

    test('tolerates malformed tool_call arguments (still executes, still loops)', async () => {
        // Model emits a tool_call with malformed JSON arguments. The
        // loop should still attempt execution (executeAgentTool has
        // its own JSON parsing tolerance) and continue.
        scriptResponses([
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'malformed',
                    type: 'function',
                    function: { name: 'read_file', arguments: 'not valid json {' }
                }]
            },
            {
                role: 'assistant',
                content: '<execution_plan>recovered</execution_plan>'
            }
        ]);
        mockDispatchWithEvents.mockResolvedValueOnce({ llmContent: 'error: malformed args', uiPayload: { kind: 'error', message: 'malformed args' } });

        const result = await runPlannerAgent('x', '/repo', '', '', '', '', '', log);

        expect(result).toContain('<execution_plan>');
        // Should still have called executeAgentTool — that's where the
        // parse happens, and it has its own error handling.
        expect(mockDispatchWithEvents).toHaveBeenCalledTimes(1);
    });
});