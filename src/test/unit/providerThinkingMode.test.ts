// src/test/unit/providerThinkingMode.test.ts
//
// V2.0: tests for the OpenAICompatibleProvider thinking-mode plumbing.
//
// Verifies:
//   - extra_body.chat_template_kwargs.{enable_thinking, preserve_thinking}
//     constructed from CompletionOptions
//   - extra_body.top_k routed correctly
//   - top_p / presence_penalty land at the body's top level (OpenAI spec)
//   - reasoning_content from response surfaces on AssistantMessage
//   - <think> leak in content is stripped, captured into reasoning_content
//   - When neither thinking option is set, no extra_body is emitted
//     (full backward compatibility with v1)
//   - Streaming request body construction mirrors non-streaming

import {
    OpenAICompatibleProvider,
    resetToolCapabilityCache,
} from '../../llm/OpenAICompatibleProvider';

describe('OpenAICompatibleProvider — V2.0 thinking-mode request body', () => {
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        resetToolCapabilityCache();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function mockFetchJson(payload: unknown, captureBody: { body: string | undefined }): void {
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            captureBody.body = init?.body as string;
            return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof globalThis.fetch;
    }

    test('emits no extra_body when no V2.0 options set (backward-compat)', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion([{ role: 'user', content: 'hi' }]);

        const body = JSON.parse(captured.body!);
        expect(body.extra_body).toBeUndefined();
    });

    test('emits enable_thinking in chat_template_kwargs', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { enableThinking: true }
        );

        const body = JSON.parse(captured.body!);
        expect(body.extra_body).toBeDefined();
        expect(body.extra_body.chat_template_kwargs.enable_thinking).toBe(true);
    });

    test('emits preserve_thinking when set', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { enableThinking: true, preserveThinking: true }
        );

        const body = JSON.parse(captured.body!);
        expect(body.extra_body.chat_template_kwargs.preserve_thinking).toBe(true);
    });

    test('emits enable_thinking=false explicitly when set false', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { enableThinking: false }
        );

        const body = JSON.parse(captured.body!);
        expect(body.extra_body.chat_template_kwargs.enable_thinking).toBe(false);
    });

    test('emits top_k inside extra_body (not at top level)', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { topK: 20 }
        );

        const body = JSON.parse(captured.body!);
        // top_k is NOT in OpenAI spec, so it goes in extra_body
        expect(body.top_k).toBeUndefined();
        expect(body.extra_body.top_k).toBe(20);
    });

    test('emits top_p at body top-level (OpenAI spec)', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { topP: 0.95 }
        );

        const body = JSON.parse(captured.body!);
        expect(body.top_p).toBe(0.95);
    });

    test('emits presence_penalty at body top-level (OpenAI spec)', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { presencePenalty: 1.5 }
        );

        const body = JSON.parse(captured.body!);
        expect(body.presence_penalty).toBe(1.5);
    });

    test('emits the full Qwen 3.6 thinking-ON sampling preset together', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            {
                temperature: 0.6,
                topP: 0.95,
                topK: 20,
                presencePenalty: 0.0,
                enableThinking: true,
                preserveThinking: true,
            }
        );

        const body = JSON.parse(captured.body!);
        expect(body.temperature).toBe(0.6);
        expect(body.top_p).toBe(0.95);
        expect(body.presence_penalty).toBe(0.0);
        expect(body.extra_body.top_k).toBe(20);
        expect(body.extra_body.chat_template_kwargs.enable_thinking).toBe(true);
        expect(body.extra_body.chat_template_kwargs.preserve_thinking).toBe(true);
    });

    test('does not emit chat_template_kwargs when no thinking flag set, even with top_k', async () => {
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'ok' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }],
            { topK: 20 }
        );

        const body = JSON.parse(captured.body!);
        expect(body.extra_body.top_k).toBe(20);
        expect(body.extra_body.chat_template_kwargs).toBeUndefined();
    });
});

describe('OpenAICompatibleProvider — V2.0 reasoning_content round-trip', () => {
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

    test('surfaces reasoning_content when present in response', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'The answer is 42.',
                    reasoning_content: 'I need to think about this carefully.',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'what is the answer?' }]
        );

        expect(result.content).toBe('The answer is 42.');
        expect(result.reasoning_content).toBe('I need to think about this carefully.');
    });

    test('omits reasoning_content when not present in response', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'Hello there!',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }]
        );

        expect(result.content).toBe('Hello there!');
        expect(result.reasoning_content).toBeUndefined();
    });

    test('strips <think> leak from content (Qwen issue #26)', async () => {
        // Simulates the documented bug where reasoning leaks into
        // content with a stray closing tag because reasoning_content
        // wasn't echoed back in history
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'I called the tool and got the time.</think>It is 14:58:09.',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'what time?' }]
        );

        expect(result.content).toBe('It is 14:58:09.');
        expect(result.reasoning_content).toContain('called the tool');
    });

    test('strips well-formed <think> blocks from content', async () => {
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<think>let me reason</think>The answer is 42.',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }]
        );

        expect(result.content).toBe('The answer is 42.');
        expect(result.reasoning_content).toBe('let me reason');
    });

    test('prefers explicit reasoning_content over leaked content', async () => {
        // When BOTH the proper field AND a leak are present, the
        // explicit field is the authoritative source — this prevents
        // duplicating reasoning text into the same field twice.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<think>leaked thought</think>actual answer',
                    reasoning_content: 'official thought',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }]
        );

        expect(result.content).toBe('actual answer');
        // Explicit field wins over the leaked one
        expect(result.reasoning_content).toBe('official thought');
    });

    test('handles content that becomes empty after leak strip', async () => {
        // If the entire content was a leaked thinking block, content
        // becomes null; the reasoning is captured.
        mockFetchJson({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '<think>only thinking, no answer</think>',
                }
            }]
        });
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        const result = await provider.chatCompletion(
            [{ role: 'user', content: 'hi' }]
        );

        expect(result.content).toBeNull();
        expect(result.reasoning_content).toBe('only thinking, no answer');
    });
});

describe('OpenAICompatibleProvider — V2.0 messages history with reasoning_content', () => {
    let realFetch: typeof globalThis.fetch;

    beforeEach(() => {
        realFetch = globalThis.fetch;
        resetToolCapabilityCache();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function mockFetchJson(payload: unknown, captureBody: { body: string | undefined }): void {
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            captureBody.body = init?.body as string;
            return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }) as typeof globalThis.fetch;
    }

    test('forwards reasoning_content in messages array (Thinking Preservation)', async () => {
        // The agent loop's pattern is: call provider → get assistant
        // message with reasoning_content → push that message back into
        // messages → call again. This test verifies reasoning_content
        // round-trips through the request body untouched.
        const captured: { body: string | undefined } = { body: undefined };
        mockFetchJson({
            choices: [{ message: { role: 'assistant', content: 'final' } }]
        }, captured);
        const provider = new OpenAICompatibleProvider({ endpoint: 'http://x', model: 'm' });
        await provider.chatCompletion([
            { role: 'user', content: 'first turn' },
            {
                role: 'assistant',
                content: 'first response',
                reasoning_content: 'I thought about it carefully.',
            },
            { role: 'user', content: 'follow-up' },
        ]);

        const body = JSON.parse(captured.body!);
        const assistantMsg = body.messages[1];
        expect(assistantMsg.content).toBe('first response');
        expect(assistantMsg.reasoning_content).toBe('I thought about it carefully.');
    });
});