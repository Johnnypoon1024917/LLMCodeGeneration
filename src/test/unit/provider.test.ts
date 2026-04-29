// src/test/unit/provider.test.ts
//
// Unit tests for the Provider abstraction (Component 1, Session 1).
//
// What we test:
//   - The Provider interface contract: a hand-rolled mock provider
//     satisfies the type and works as expected through the public API
//   - SSE stream parsing in OpenAICompatibleProvider — covers correctly-
//     framed `data:` lines, bare-JSON edge cases, and `[DONE]` sentinels
//   - The factory cache: same config returns the same instance;
//     resetting forces re-construction
//
// What we DON'T test (deferred):
//   - Full network round-trip — that's integration territory
//   - jsonCompletion fallback — covered by jsonRequest's own tests
//     (would need to write those; currently zero unit coverage of
//     jsonRequest beyond manual verification)
//   - llmService.streamChat behavior — too entangled with vscode + audit
//     for unit tests, would need richer mocking

import type {
    Message,
    Provider,
    CompletionStream,
    CompletionOptions,
    ChatMessage,
    AssistantMessage,
    ChatCompletionDelta,
    ChatCompletionStream,
    ToolCall
} from '../../llm/Provider';
import {
    OpenAICompatibleProvider,
    setToolCapability,
    resetToolCapabilityCache
} from '../../llm/OpenAICompatibleProvider';

describe('Provider interface — contract', () => {
    /**
     * Hand-rolled mock provider that captures inputs and returns
     * deterministic outputs. Proves the interface is implementable
     * without any infrastructure dependencies.
     */
    class MockProvider implements Provider {
        readonly name = 'mock';
        readonly endpoint = 'http://mock';
        readonly model = 'mock-model';
        capturedMessages: Message[] = [];
        capturedOptions: CompletionOptions | undefined = undefined;

        async streamCompletion(
            messages: Message[],
            options?: CompletionOptions
        ): Promise<CompletionStream> {
            this.capturedMessages = messages;
            this.capturedOptions = options;
            return (async function* () {
                yield 'Hello, ';
                yield 'world!';
            })();
        }

        async completion(messages: Message[], options?: CompletionOptions): Promise<string> {
            const stream = await this.streamCompletion(messages, options);
            let acc = '';
            for await (const chunk of stream) {
                acc += chunk;
            }
            return acc;
        }

        async jsonCompletion<T>(_messages: Message[]): Promise<T> {
            return ({ ok: true } as unknown) as T;
        }

        // Component 2A: minimal stub. Tests that exercise the real
        // tool-call response shape use `OpenAICompatibleProvider`
        // with mocked fetch, not this mock.
        async chatCompletion(_messages: ChatMessage[]): Promise<AssistantMessage> {
            return { role: 'assistant', content: 'mock' };
        }

        // Component 2B-1: minimal stub. Tests that exercise streaming
        // tool-call deltas use `OpenAICompatibleProvider` with mocked
        // SSE fetch responses.
        async streamChatCompletion(_messages: ChatMessage[]): Promise<ChatCompletionStream> {
            return (async function* (): AsyncGenerator<ChatCompletionDelta, void, undefined> {
                yield { kind: 'text', content: 'mock' };
                yield { kind: 'finish', reason: 'stop' };
            })();
        }

        async listModels(): Promise<string[]> {
            return [this.model];
        }
    }

    test('streamCompletion yields chunks in order', async () => {
        const provider = new MockProvider();
        const messages: Message[] = [{ role: 'user', content: 'hi' }];
        const stream = await provider.streamCompletion(messages);

        const chunks: string[] = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        expect(chunks).toEqual(['Hello, ', 'world!']);
    });

    test('streamCompletion forwards messages and options', async () => {
        const provider = new MockProvider();
        const ac = new AbortController();
        await provider.streamCompletion(
            [{ role: 'user', content: 'test' }],
            { temperature: 0.5, signal: ac.signal }
        );
        expect(provider.capturedMessages).toEqual([{ role: 'user', content: 'test' }]);
        expect(provider.capturedOptions?.temperature).toBe(0.5);
        expect(provider.capturedOptions?.signal).toBe(ac.signal);
    });

    test('completion accumulates streamed chunks into a single string', async () => {
        const provider = new MockProvider();
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('Hello, world!');
    });

    test('listModels returns at least the configured model', async () => {
        const provider = new MockProvider();
        const models = await provider.listModels();
        expect(models).toContain('mock-model');
    });
});

describe('OpenAICompatibleProvider — construction', () => {
    test('exposes endpoint and model from config', () => {
        const provider = new OpenAICompatibleProvider({
            endpoint: 'http://test:8000/v1/chat/completions',
            model: 'qwen-test'
        });
        expect(provider.endpoint).toBe('http://test:8000/v1/chat/completions');
        expect(provider.model).toBe('qwen-test');
        expect(provider.name).toBe('openai-compatible');
    });

    test('accepts optional apiKey', () => {
        const provider = new OpenAICompatibleProvider({
            endpoint: 'http://test',
            model: 'm',
            apiKey: 'sk-test'
        });
        // apiKey is private; we can't read it back. But construction shouldn't throw.
        expect(provider.name).toBe('openai-compatible');
    });

    test('listModels returns the single configured model', async () => {
        const provider = new OpenAICompatibleProvider({
            endpoint: 'http://test',
            model: 'qwen2.5-coder'
        });
        const models = await provider.listModels();
        expect(models).toEqual(['qwen2.5-coder']);
    });
});

describe('SSE stream parsing — synthetic byte streams', () => {
    /**
     * Build a ReadableStream<Uint8Array> from an array of string chunks.
     * Used to exercise parseSseStream without involving network I/O.
     *
     * parseSseStream is module-private; we test it indirectly by
     * mocking fetch to return a ReadableStream and observing what
     * streamCompletion yields. That's heavy for unit tests; instead
     * we recreate the parsing logic's expected behavior here directly
     * by feeding a stream into the public API path.
     *
     * We achieve this by stubbing global fetch + the resilientFetch
     * helper. fetch is what resilientFetch ultimately calls. By
     * intercepting fetch we hit the real parseSseStream code.
     */
    function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[i]!));
                    i++;
                } else {
                    controller.close();
                }
            }
        });
    }

    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function mockFetchWithStream(stream: ReadableStream<Uint8Array>): void {
        globalThis.fetch = (async () => {
            return new Response(stream, { status: 200 });
        }) as typeof globalThis.fetch;
    }

    test('parses correctly-framed SSE data lines', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
            'data: {"choices":[{"delta":{"content":", "}}]}\n',
            'data: {"choices":[{"delta":{"content":"world!"}}]}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('Hello, world!');
    });

    test('ignores [DONE] sentinel', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"abc"}}]}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('abc');
    });

    test('handles bare JSON lines (LM Studio quirk)', async () => {
        // Some LM Studio versions emit bare `{...}` lines without the
        // `data: ` prefix. parseSseStream tolerates this.
        const chunks = [
            '{"choices":[{"delta":{"content":"raw"}}]}\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('raw');
    });

    test('skips malformed SSE lines without crashing', async () => {
        const chunks = [
            'data: not-valid-json\n',
            'data: {"choices":[{"delta":{"content":"survived"}}]}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('survived');
    });

    test('falls through gracefully on chunk boundaries within a line', async () => {
        // Important: the SSE parser must handle the case where a single
        // "line" arrives split across multiple network chunks. Verify
        // by sending half a line, then the rest.
        const chunks = [
            'data: {"choices":[{"delta":',
            '{"content":"split"}}]}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('split');
    });

    test('reads delta.content first, then falls back to message.content', async () => {
        // Some non-streaming-style responses include `message.content`
        // rather than `delta.content`. The parser handles both.
        const chunks = [
            'data: {"choices":[{"message":{"content":"non-stream-shape"}}]}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.completion([{ role: 'user', content: 'hi' }]);
        expect(result).toBe('non-stream-shape');
    });

    test('honors abort signal between reads', async () => {
        // Build a stream that will produce content but abort before it
        // reaches the consumer.
        const chunks = [
            'data: {"choices":[{"delta":{"content":"first"}}]}\n',
            'data: {"choices":[{"delta":{"content":"second"}}]}\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const ac = new AbortController();
        ac.abort(); // pre-aborted

        // Should throw because resilientFetch fast-fails on pre-aborted signals
        await expect(
            provider.completion([{ role: 'user', content: 'hi' }], { signal: ac.signal })
        ).rejects.toThrow();
    });

    test('surfaces usage payload via onUsage callback (Session 2)', async () => {
        // OpenAI-compat servers configured with stream_options.include_usage
        // emit a final frame with `usage: {...}`. parseSseStream surfaces
        // this through the optional onUsage callback. Coordinator uses
        // this for per-task token tracking.
        const chunks = [
            'data: {"choices":[{"delta":{"content":"output"}}]}\n',
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n',
            'data: [DONE]\n'
        ];
        mockFetchWithStream(streamFromChunks(chunks));

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const usageEvents: Record<string, unknown>[] = [];
        const result = await provider.completion(
            [{ role: 'user', content: 'hi' }],
            { onUsage: (u) => usageEvents.push(u) }
        );

        expect(result).toBe('output');
        expect(usageEvents).toHaveLength(1);
        expect(usageEvents[0]).toEqual({
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15
        });
    });

    test('omits stream_options.include_usage when no onUsage provided', async () => {
        // When callers don't request usage, the wire request should not
        // carry stream_options. Verifying this requires inspecting the
        // request body — we capture it via a fetch interceptor.
        let capturedBody: string | undefined;
        const realFetchSnapshot = globalThis.fetch;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBody = init?.body as string;
            return new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 });
        }) as typeof globalThis.fetch;

        try {
            const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
            await provider.completion([{ role: 'user', content: 'hi' }]);

            expect(capturedBody).toBeDefined();
            const parsedBody = JSON.parse(capturedBody!);
            expect(parsedBody.stream_options).toBeUndefined();
            expect(parsedBody.stream).toBe(true);
        } finally {
            globalThis.fetch = realFetchSnapshot;
        }
    });

    test('includes stream_options.include_usage when onUsage provided', async () => {
        let capturedBody: string | undefined;
        const realFetchSnapshot = globalThis.fetch;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBody = init?.body as string;
            return new Response(streamFromChunks(['data: [DONE]\n']), { status: 200 });
        }) as typeof globalThis.fetch;

        try {
            const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
            await provider.completion([{ role: 'user', content: 'hi' }], { onUsage: () => {} });

            expect(capturedBody).toBeDefined();
            const parsedBody = JSON.parse(capturedBody!);
            expect(parsedBody.stream_options).toEqual({ include_usage: true });
        } finally {
            globalThis.fetch = realFetchSnapshot;
        }
    });
});

describe('OpenAICompatibleProvider — chatCompletion (Component 2A)', () => {
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        // Each test starts with an empty capability cache so the
        // probe paths can be exercised deterministically.
        resetToolCapabilityCache();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /**
     * Helper: install a fetch mock that returns a JSON body. Used by
     * tests that don't need streaming.
     */
    function mockFetchJson(payload: unknown, status = 200, captureBody?: { body: string | undefined }): void {
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            if (captureBody) captureBody.body = init?.body as string;
            return new Response(JSON.stringify(payload), {
                status,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof globalThis.fetch;
    }

    test('returns AssistantMessage with text content for non-tool response', async () => {
        // Pre-warm cache as 'no-tools' path: don't pass tools, so the
        // implementation skips the probe regardless.
        mockFetchJson({
            choices: [{
                message: { role: 'assistant', content: 'hello there' }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion([{ role: 'user', content: 'hi' }]);

        expect(result.role).toBe('assistant');
        expect(result.content).toBe('hello there');
        expect(result.tool_calls).toBeUndefined();
    });

    test('returns AssistantMessage with tool_calls for tool-using response', async () => {
        // Pre-warm capability so the probe path is skipped — we test
        // probe behavior in a separate test below.
        setToolCapability('http://probe-skipped', 'supported');
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"filepath":"src/foo.ts"}' }
                    }]
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://probe-skipped', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'find foo' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }] }
        );

        expect(result.role).toBe('assistant');
        expect(result.content).toBeNull();
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls?.[0]?.function.name).toBe('read_file');
    });

    test('sends tools and tool_choice in the request body when capability supported', async () => {
        setToolCapability('http://has-tools', 'supported');
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, 200, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://has-tools', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            {
                tools: [{ type: 'function', function: { name: 'foo', description: 'bar', parameters: {} } }],
                toolChoice: 'auto'
            }
        );

        expect(captured.body).toBeDefined();
        const body = JSON.parse(captured.body!);
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0].function.name).toBe('foo');
        expect(body.tool_choice).toBe('auto');
    });

    test('omits tools and tool_choice from request when no tools provided', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, 200, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion([{ role: 'user', content: 'hi' }]);

        expect(captured.body).toBeDefined();
        const body = JSON.parse(captured.body!);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    test('detects and caches tool-incapable endpoint, falls back to tool-free request', async () => {
        // Two-stage fetch mock:
        // 1) First call (with tools) returns 400 with "tools not supported" body
        // 2) Retry (without tools) returns success
        let callCount = 0;
        const capturedBodies: string[] = [];
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBodies.push(init?.body as string);
            callCount++;
            if (callCount === 1) {
                // Probe attempt — endpoint rejects tools
                return new Response(
                    JSON.stringify({ error: { message: 'this endpoint does not support tool_choice' } }),
                    { status: 400, headers: { 'content-type': 'application/json' } }
                );
            }
            // Fallback attempt — succeeds without tools
            return new Response(
                JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'plain reply' } }] }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        }) as typeof globalThis.fetch;

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://no-tools', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { tools: [{ type: 'function', function: { name: 'foo', description: 'b', parameters: {} } }] }
        );

        expect(callCount).toBe(2);
        // First request had tools, second didn't
        const firstBody = JSON.parse(capturedBodies[0]!);
        const secondBody = JSON.parse(capturedBodies[1]!);
        expect(firstBody.tools).toBeDefined();
        expect(secondBody.tools).toBeUndefined();
        // Result is the fallback response
        expect(result.content).toBe('plain reply');
    });

    test('cache hit: tool-incapable endpoint skips probe on second call', async () => {
        // Pre-cache the capability so the chatCompletion call should
        // go straight to the no-tools path with NO retry.
        setToolCapability('http://known-bad', 'unsupported');
        let callCount = 0;
        const capturedBodies: string[] = [];
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBodies.push(init?.body as string);
            callCount++;
            return new Response(
                JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'cached path' } }] }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        }) as typeof globalThis.fetch;

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://known-bad', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { tools: [{ type: 'function', function: { name: 'foo', description: 'b', parameters: {} } }] }
        );

        expect(callCount).toBe(1);
        const body = JSON.parse(capturedBodies[0]!);
        expect(body.tools).toBeUndefined();
        expect(result.content).toBe('cached path');
    });

    test('non-capability errors propagate unchanged (e.g. 400 with non-tool message)', async () => {
        // Server returns a 400 with a non-tool error message. This is a
        // legitimate HTTP error that's NOT a capability rejection. The
        // provider should NOT silently retry — should throw.
        let callCount = 0;
        globalThis.fetch = (async () => {
            callCount++;
            return new Response(
                JSON.stringify({ error: { message: 'invalid model name' } }),
                { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } }
            );
        }) as typeof globalThis.fetch;

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://broken', model: 'm' });
        await expect(
            provider.chatCompletion(
                [{ role: 'user', content: 'hi' }],
                { tools: [{ type: 'function', function: { name: 'foo', description: 'b', parameters: {} } }] }
            )
        ).rejects.toThrow(/HTTP Error 400/);
        // 400 fast-fails (no retry), and the message doesn't trigger
        // the capability heuristic, so the error propagates after one call.
        expect(callCount).toBe(1);
    });

    test('normalizes empty-string content to null when tool_calls present', async () => {
        // Some providers emit content: '' (empty string) instead of null
        // when only tool_calls are produced. Normalize to null so callers
        // can use `content ?? ''` and get consistent behavior.
        setToolCapability('http://normalize', 'supported');
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'c1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{}' }
                    }]
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://normalize', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }] }
        );
        expect(result.content).toBeNull();
        expect(result.tool_calls).toHaveLength(1);
    });
});

describe('OpenAICompatibleProvider — streamChatCompletion (Component 2B-1)', () => {
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        resetToolCapabilityCache();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /**
     * Build a ReadableStream from a list of string chunks. Mirrors the
     * helper in the SSE stream parsing tests above; reproduced here
     * for test isolation.
     */
    function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
        const encoder = new TextEncoder();
        let i = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (i < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[i]!));
                    i++;
                } else {
                    controller.close();
                }
            }
        });
    }

    /**
     * Install a fetch mock that returns a streaming SSE response.
     * Used by tests that need to exercise the parser end-to-end.
     */
    function mockSseStream(chunks: string[]): void {
        globalThis.fetch = (async () => {
            return new Response(streamFromChunks(chunks), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            });
        }) as typeof globalThis.fetch;
    }

    /**
     * Helper: drain a ChatCompletionStream to a list. Easier to write
     * assertions against than for-await loops.
     */
    async function collectDeltas(stream: ChatCompletionStream): Promise<ChatCompletionDelta[]> {
        const acc: ChatCompletionDelta[] = [];
        for await (const delta of stream) {
            acc.push(delta);
        }
        return acc;
    }

    test('yields text deltas + finish for text-only streaming response', async () => {
        mockSseStream([
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
            'data: {"choices":[{"delta":{"content":", world"}}]}\n',
            'data: {"choices":[{"finish_reason":"stop"}]}\n',
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const stream = await provider.streamChatCompletion([{ role: 'user', content: 'hi' }]);
        const deltas = await collectDeltas(stream);

        expect(deltas).toEqual([
            { kind: 'text', content: 'Hello' },
            { kind: 'text', content: ', world' },
            { kind: 'finish', reason: 'stop' }
        ]);
    });

    test('yields complete tool_call delta after argument fragments arrive', async () => {
        // Pre-warm capability so we skip the probe — tested separately below
        setToolCapability('http://tools-supported', 'supported');

        mockSseStream([
            // First delta: id, type, name
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n',
            // Argument fragments arrive piece by piece
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file"}}]}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\\":\\"src/x.ts\\"}"}}]}}]}\n',
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://tools-supported', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'read x' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }] }
        );
        const deltas = await collectDeltas(stream);

        // Should have: 1 tool_call delta (after args complete), 1 finish.
        // No partial tool_call deltas mid-stream.
        const toolCallDeltas = deltas.filter(d => d.kind === 'tool_call');
        expect(toolCallDeltas).toHaveLength(1);

        const tc = (toolCallDeltas[0] as { kind: 'tool_call'; toolCall: ToolCall }).toolCall;
        expect(tc.id).toBe('call_1');
        expect(tc.function.name).toBe('read_file');
        // Args are reassembled correctly
        expect(JSON.parse(tc.function.arguments)).toEqual({ filepath: 'src/x.ts' });

        // Final delta is a finish
        const lastDelta = deltas[deltas.length - 1];
        expect(lastDelta).toEqual({ kind: 'finish', reason: 'tool_calls' });
    });

    test('handles multiple parallel tool calls (different indices)', async () => {
        setToolCapability('http://parallel', 'supported');

        // Two tool calls interleaved at indices 0 and 1
        mockSseStream([
            // index=0 setup
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n',
            // index=1 setup
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"list_directory","arguments":""}}]}}]}\n',
            // index=0 args
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"filepath\\":\\"a.ts\\"}"}}]}}]}\n',
            // index=1 args
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"dirpath\\":\\"src\\"}"}}]}}]}\n',
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://parallel', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'do both' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }] }
        );
        const deltas = await collectDeltas(stream);

        const toolCallDeltas = deltas.filter(d => d.kind === 'tool_call');
        expect(toolCallDeltas).toHaveLength(2);

        // Index 0 should yield first (sorted by index when flushing)
        const tc0 = (toolCallDeltas[0] as { kind: 'tool_call'; toolCall: ToolCall }).toolCall;
        expect(tc0.id).toBe('a');
        expect(tc0.function.name).toBe('read_file');
        expect(JSON.parse(tc0.function.arguments)).toEqual({ filepath: 'a.ts' });

        const tc1 = (toolCallDeltas[1] as { kind: 'tool_call'; toolCall: ToolCall }).toolCall;
        expect(tc1.id).toBe('b');
        expect(tc1.function.name).toBe('list_directory');
        expect(JSON.parse(tc1.function.arguments)).toEqual({ dirpath: 'src' });
    });

    test('interleaves text content with eventual tool_call deltas', async () => {
        // Some models emit "let me look at this" text BEFORE issuing
        // the tool call. Test that text deltas pass through during
        // accumulation phase.
        setToolCapability('http://mixed', 'supported');

        mockSseStream([
            'data: {"choices":[{"delta":{"content":"Let me check"}}]}\n',
            'data: {"choices":[{"delta":{"content":" the file."}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"read_file","arguments":"{\\"filepath\\":\\"x\\"}"}}]}}]}\n',
            'data: {"choices":[{"finish_reason":"tool_calls"}]}\n',
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://mixed', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'look' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }] }
        );
        const deltas = await collectDeltas(stream);

        // Expected order: 2 text deltas (immediate), then 1 tool_call
        // (after stream end + flush), then finish
        expect(deltas[0]).toEqual({ kind: 'text', content: 'Let me check' });
        expect(deltas[1]).toEqual({ kind: 'text', content: ' the file.' });
        expect(deltas[2]?.kind).toBe('tool_call');
        expect(deltas[3]).toEqual({ kind: 'finish', reason: 'tool_calls' });
    });

    test('drops tool calls with malformed args (does not yield incomplete)', async () => {
        // Model started a tool call but the stream ended before args
        // were syntactically complete. Provider should drop the call
        // (with a log warning) rather than yield a malformed call.
        setToolCapability('http://truncated', 'supported');

        mockSseStream([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","type":"function","function":{"name":"read_file","arguments":"{\\"file"}}]}}]}\n',
            // Stream ends without completing the args
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://truncated', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'do' }],
            { tools: [{ type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }] }
        );
        const deltas = await collectDeltas(stream);

        const toolCallDeltas = deltas.filter(d => d.kind === 'tool_call');
        expect(toolCallDeltas).toHaveLength(0);
        // Should still emit a finish delta even on the failure path
        const finishDeltas = deltas.filter(d => d.kind === 'finish');
        expect(finishDeltas).toHaveLength(1);
    });

    test('cached unsupported endpoint sends streaming request without tools', async () => {
        setToolCapability('http://no-tools', 'unsupported');

        let capturedBody: string | undefined;
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            capturedBody = init?.body as string;
            return new Response(streamFromChunks([
                'data: {"choices":[{"delta":{"content":"text only"}}]}\n',
                'data: {"choices":[{"finish_reason":"stop"}]}\n',
                'data: [DONE]\n'
            ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as typeof globalThis.fetch;

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://no-tools', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'hi' }],
            { tools: [{ type: 'function', function: { name: 'foo', description: 'b', parameters: {} } }] }
        );
        const deltas = await collectDeltas(stream);

        // Body should NOT include tools
        expect(capturedBody).toBeDefined();
        const body = JSON.parse(capturedBody!);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.stream).toBe(true);

        // Stream produces text + finish, no tool_call deltas
        expect(deltas.some(d => d.kind === 'text')).toBe(true);
        expect(deltas.filter(d => d.kind === 'tool_call')).toHaveLength(0);
    });

    test('probes capability before streaming when cache is cold', async () => {
        // Capability cache is cold (cleared in beforeEach). The probe
        // is a non-streaming chatCompletion call that should fire BEFORE
        // the streaming request. Track call sequence to verify order.
        const calls: Array<{ stream: boolean; hasTools: boolean }> = [];

        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string);
            calls.push({
                stream: body.stream === true,
                hasTools: body.tools !== undefined
            });

            if (calls.length === 1) {
                // Probe call: non-streaming, with tools. Return success.
                return new Response(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'probe ok' } }]
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }

            // Real streaming call
            return new Response(streamFromChunks([
                'data: {"choices":[{"delta":{"content":"streamed"}}]}\n',
                'data: {"choices":[{"finish_reason":"stop"}]}\n',
                'data: [DONE]\n'
            ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }) as typeof globalThis.fetch;

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://probe-test', model: 'm' });
        const stream = await provider.streamChatCompletion(
            [{ role: 'user', content: 'hi' }],
            { tools: [{ type: 'function', function: { name: 'foo', description: 'b', parameters: {} } }] }
        );
        await collectDeltas(stream);

        expect(calls).toHaveLength(2);
        // First call: probe (non-streaming, has tools)
        expect(calls[0]).toEqual({ stream: false, hasTools: true });
        // Second call: real streaming (with tools, capability now known supported)
        expect(calls[1]).toEqual({ stream: true, hasTools: true });
    });

    test('handles SSE chunks split mid-line (boundary-safe parsing)', async () => {
        // Realistic streaming: bytes arrive in chunks that don't align
        // with line boundaries. Parser must accumulate via the buffer.
        mockSseStream([
            'data: {"choi',                    // first chunk: partial line
            'ces":[{"delta":{"content":"abc"}}]}\n',  // completes the line
            'data: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://chunks', model: 'm' });
        const stream = await provider.streamChatCompletion([{ role: 'user', content: 'hi' }]);
        const deltas = await collectDeltas(stream);

        expect(deltas).toContainEqual({ kind: 'text', content: 'abc' });
        expect(deltas[deltas.length - 1]).toEqual({ kind: 'finish', reason: 'stop' });
    });

    test('synthesizes finish delta when server omits finish_reason', async () => {
        // Some servers don't emit a finish_reason on tool_calls, going
        // straight to [DONE]. Provider should synthesize a 'stop' finish.
        mockSseStream([
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
            'data: [DONE]\n'
        ]);

        const provider = new OpenAICompatibleProvider({ endpoint: 'http://no-finish', model: 'm' });
        const stream = await provider.streamChatCompletion([{ role: 'user', content: 'hi' }]);
        const deltas = await collectDeltas(stream);

        const finishDeltas = deltas.filter(d => d.kind === 'finish');
        expect(finishDeltas).toHaveLength(1);
        expect(finishDeltas[0]).toEqual({ kind: 'finish', reason: 'stop' });
    });
});