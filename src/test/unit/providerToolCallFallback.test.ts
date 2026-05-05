// src/test/unit/providerToolCallFallback.test.ts
//
// V2.0 follow-up: integration tests for the client-side tool-call
// fallback parser at the Provider level.
//
// Verifies that when an inference server's --tool-call-parser is
// misconfigured (or absent), and the model emits tool calls in its
// native non-OpenAI format inside `content`, the Provider's
// chatCompletion still surfaces a proper AssistantMessage with
// tool_calls populated.
//
// This is the end-to-end test of the fix for the production bug
// where Qwen 2.5 Coder + vLLM with hermes parser failed to call
// write_file, even though the model intended to.

import {
    OpenAICompatibleProvider,
    resetToolCapabilityCache,
} from '../../llm/OpenAICompatibleProvider';

describe('OpenAICompatibleProvider — tool-call fallback integration', () => {
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        resetToolCapabilityCache();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function mockFetchJson(payload: unknown): void {
        globalThis.fetch = (async (_url: string | URL | Request) => {
            return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof globalThis.fetch;
    }

    test('happy path: native tool_calls passes through unchanged (no fallback fires)', async () => {
        // When the server is correctly configured, native tool_calls
        // are present and the fallback does NOT fire. This is the
        // common case and must not regress.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_real',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"x.ts"}' }
                    }]
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'read x' }]
        );
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]!.id).toBe('call_real');  // not synthetic
    });

    test('Qwen 2.5 Coder failure mode: <tools> block in content gets recovered', async () => {
        // The exact production failure: vLLM with --tool-call-parser
        // hermes against a Qwen 2.5 Coder model. The model emits
        // tool calls as <tools>{...}</tools> text, the server's
        // hermes parser doesn't recognize the format, the response
        // arrives with empty tool_calls and the call inside content.
        // Fallback must recover.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'Understood. I will write the file.\n\n<tools>{"name": "write_file", "arguments": {"path": "src/index.ts", "content": "console.log(\\"Hello\\");"}}</tools>',
                    // NOTE: no tool_calls field at all, OR empty array
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'write hello world' }]
        );

        // The fallback should have recovered the tool call
        expect(result.tool_calls).toBeDefined();
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]!.function.name).toBe('write_file');
        // Synthetic id contains 'fallback' prefix for compliance audit visibility
        expect(result.tool_calls![0]!.id).toContain('fallback');
        // Narrative prose preserved as content (without tool-call block)
        expect(result.content).toContain('Understood');
        expect(result.content).not.toContain('<tools>');
    });

    test('Qwen 3 Coder XML format gets recovered', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<function=read_file><parameter=path>src/foo.ts</parameter></function>',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'read foo' }]
        );
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]!.function.name).toBe('read_file');
    });

    test('Hermes <tool_call> block gets recovered', async () => {
        // Even though hermes is what vLLM is supposed to handle, some
        // misconfigurations cause it to leave the block in content.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<tool_call>{"name": "list_files", "arguments": {"path": "."}}</tool_call>',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'list' }]
        );
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]!.function.name).toBe('list_files');
    });

    test('JSON code block format gets recovered', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'Here\'s the call:\n```json\n{"name": "write_file", "arguments": {"path": "x.ts", "content": "ok"}}\n```',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'go' }]
        );
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls![0]!.function.name).toBe('write_file');
    });

    test('parallel tool calls in fallback format', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: `<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>
<tool_call>{"name": "read_file", "arguments": {"path": "b.ts"}}</tool_call>`,
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'read both' }]
        );
        expect(result.tool_calls).toHaveLength(2);
        // Distinct ids
        expect(result.tool_calls![0]!.id).not.toBe(result.tool_calls![1]!.id);
    });

    test('does not fire when content is plain prose (no false positive)', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'Hello! I am Nexus, an AI software architect. How can I help you today?',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'who are you' }]
        );
        expect(result.tool_calls).toBeUndefined();
        expect(result.content).toContain('Nexus');
    });

    test('combines with reasoning_content correctly (V2.0 + fallback together)', async () => {
        // Production scenario: thinking-mode model emits reasoning,
        // then a tool call in fallback format. Both V2.0 features
        // and the fallback need to coexist.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<tools>{"name": "read_file", "arguments": {"path": "x.ts"}}</tools>',
                    reasoning_content: 'I should read the file to understand its current state.',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'investigate x.ts' }]
        );
        expect(result.tool_calls).toHaveLength(1);
        expect(result.reasoning_content).toContain('should read');
    });
});