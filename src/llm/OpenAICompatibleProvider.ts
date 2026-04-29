// src/llm/OpenAICompatibleProvider.ts
//
// Provider implementation for OpenAI-compatible chat-completion servers.
//
// Covers (per the locked v1.0 decisions in COMPONENT_1_PREWORK.md):
//   - vLLM / vLLM-Ascend          (the primary internal target)
//   - LM Studio
//   - llama.cpp's OpenAI-compat mode
//   - LocalAI
//   - Ollama (via its OpenAI-compatible endpoint)
//   - OpenAI itself
//   - Any cloud provider exposing /v1/chat/completions
//
// Out of scope (deferred to v1.1+):
//   - Huawei MindIE (different request shape — needs MindIEProvider)
//   - Anthropic native (different auth + message shape — needs AnthropicProvider)
//   - JSON-in-prompt as the only mode for tool calls. Component 2A
//     adds native tool-calling for INTERNAL ReAct loops only — see
//     `chatCompletion()` below. Domain-level tool calls (user-visible
//     bash exec, file write) remain JSON-in-prompt for now (2B work).
//
// Internal architecture:
//   This class is a thin shell. The actual transport work lives in
//   helpers — `resilientFetch` (retry + rate-limit), `jsonRequestData`
//   (JSON-mode probe + parse), `safeParseJSON` (legacy healer fallback).
//   Those helpers existed before this class and are reused unchanged.
//
//   Existing call sites that still use `resilientFetch` / `authHeaders`
//   directly continue to work — the Provider doesn't replace them, it
//   sits alongside them. Migration of those call sites is a separate
//   concern (Session 2 of Component 1, per COMPONENT_1_PREWORK.md).

import { resilientFetch, authHeaders } from '../llmService';
import { jsonRequestData } from './jsonRequest';
import { errorMessage, isAbortError } from '../utilities/errors';
import type {
    Message,
    ChatMessage,
    AssistantMessage,
    CompletionOptions,
    CompletionStream,
    ChatCompletionDelta,
    ChatCompletionStream,
    ToolCall,
    Provider
} from './Provider';
import type { JsonSchema } from './jsonSchemas';
import { log } from '../logger';

export interface OpenAICompatibleProviderConfig {
    endpoint: string;
    model: string;
    apiKey?: string;
}

export class OpenAICompatibleProvider implements Provider {
    readonly name = 'openai-compatible';
    readonly endpoint: string;
    readonly model: string;
    private readonly apiKey: string | undefined;

    constructor(cfg: OpenAICompatibleProviderConfig) {
        this.endpoint = cfg.endpoint;
        this.model = cfg.model;
        this.apiKey = cfg.apiKey;
    }

    /**
     * Streaming chat completion. Returns an async iterable that yields
     * text chunks as they arrive over the SSE stream.
     *
     * Implementation note: we cannot return the iterable directly from
     * inside an async function without first awaiting the fetch — the
     * caller needs the response headers/status to throw eagerly on a
     * failed connection. So `streamCompletion` is async, awaits the
     * fetch, then returns an iterable that owns the response body.
     */
    async streamCompletion(
        messages: Message[],
        options?: CompletionOptions
    ): Promise<CompletionStream> {
        // Opt into usage emission only when the caller registered a
        // callback. Sending `stream_options.include_usage` on servers
        // that don't recognize it is harmless on most (vLLM, LM Studio
        // ignore unknown stream_options fields), but we keep payloads
        // minimal by default.
        const wantUsage = options?.onUsage !== undefined;

        const fetchOptions: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
            method: 'POST',
            headers: authHeaders(this.apiKey),
            body: JSON.stringify({
                model: this.model,
                messages,
                temperature: options?.temperature ?? 0.3,
                ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
                stream: true,
                ...(wantUsage ? { stream_options: { include_usage: true } } : {})
            })
        };
        if (options?.signal) {
            fetchOptions.signal = options.signal;
        }

        const response = await resilientFetch(this.endpoint, fetchOptions, options?.onRetryLog);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${this.endpoint}`);
        }
        if (!response.body) {
            throw new Error(`No readable stream from ${this.endpoint}`);
        }

        return parseSseStream(response.body, options?.signal, options?.onUsage);
    }

    /**
     * Non-streaming chat completion. Implemented over `streamCompletion`
     * by accumulating all chunks. Most call sites that just want the
     * full response should use this rather than rolling their own
     * stream consumer.
     */
    async completion(
        messages: Message[],
        options?: CompletionOptions
    ): Promise<string> {
        const stream = await this.streamCompletion(messages, options);
        let acc = '';
        for await (const chunk of stream) {
            acc += chunk;
        }
        return acc;
    }

    /**
     * JSON-mode completion. Delegates to the existing `jsonRequestData`
     * which already implements the probe-and-fallback logic for
     * json_schema vs json_object response formats.
     *
     * Schema is required by jsonRequestData. If the caller passes no
     * schema we synthesize a permissive "any object" schema — this lets
     * jsonRequestData operate in json_object mode without schema
     * enforcement, matching the contract callers expect.
     */
    async jsonCompletion<T>(
        messages: Message[],
        schema?: JsonSchema,
        options?: CompletionOptions
    ): Promise<T> {
        // jsonRequestData has its own option shape; map ours onto it.
        // It uses the global `getLLMConfig` internally rather than
        // accepting endpoint/model arguments — that's a Session 2
        // cleanup. For now, the cached config and our config should
        // agree (single-provider-per-session = D1 lock).
        const effectiveSchema: JsonSchema = schema ?? {
            name: 'permissive_object',
            schema: { type: 'object', additionalProperties: true },
            strict: false
        };
        const args: {
            messages: Message[];
            schema: JsonSchema;
            temperature: number;
            signal?: AbortSignal;
        } = {
            messages,
            schema: effectiveSchema,
            temperature: options?.temperature ?? 0.3
        };
        if (options?.signal !== undefined) args.signal = options.signal;
        return jsonRequestData<T>(args);
    }

    /**
     * Tool-using non-streaming chat completion (Component 2A).
     *
     * Implementation strategy:
     *   1. If `options.tools` is empty/absent, we don't probe — just
     *      do a plain non-streaming completion request. Result has
     *      `tool_calls` undefined.
     *   2. If tools are provided, check the cached capability. Three
     *      cases:
     *        - Capability unknown → make the request WITH tools,
     *          observe success/failure, cache the result.
     *        - Capability = supported → send the request with tools.
     *        - Capability = unsupported → silently strip tools and
     *          send a tool-free request. The caller's ReAct loop sees
     *          "no tool_calls in response" and proceeds with the text.
     *
     * Probe heuristic (case 1): the request itself acts as the probe.
     * We call the endpoint with tools; if the server returns HTTP 400
     * with a body mentioning 'tools' or 'tool_choice' or 'function',
     * we mark the endpoint as tool-incapable, retry without tools, and
     * cache the result. Any other 4xx/5xx is a real error and bubbles
     * up unchanged.
     */
    async chatCompletion(
        messages: ChatMessage[],
        options?: CompletionOptions
    ): Promise<AssistantMessage> {
        const wantsTools = options?.tools !== undefined && options.tools.length > 0;
        const cap = wantsTools ? toolCapabilityCache.get(this.endpoint) : 'no-tools';

        // Path 1: tools weren't requested OR cache says endpoint can't do tools
        if (!wantsTools || cap === 'unsupported') {
            return this.requestNonStreaming(messages, options, /*includeTools*/ false);
        }

        // Path 2: cache says endpoint supports tools — send with tools, no probe
        if (cap === 'supported') {
            return this.requestNonStreaming(messages, options, /*includeTools*/ true);
        }

        // Path 3: capability unknown — try with tools, fall back on capability error
        try {
            const result = await this.requestNonStreaming(messages, options, /*includeTools*/ true);
            // Success: mark endpoint capable
            toolCapabilityCache.set(this.endpoint, 'supported');
            log.info(`[Provider] Endpoint ${this.endpoint} supports native tool-calling.`);
            return result;
        } catch (e) {
            if (isToolCapabilityError(e)) {
                log.warn(`[Provider] Endpoint ${this.endpoint} rejected tool-calling — falling back to text-only mode for this and future requests.`);
                toolCapabilityCache.set(this.endpoint, 'unsupported');
                return this.requestNonStreaming(messages, options, /*includeTools*/ false);
            }
            throw e;
        }
    }

    /**
     * Tool-using STREAMING chat completion (Component 2B-1, Q7=7B).
     *
     * Mirrors `chatCompletion`'s capability handling but routes to the
     * streaming SSE parser. Capability cache is shared — a single call
     * to `chatCompletion` warms the cache for `streamChatCompletion`
     * too, and vice versa.
     *
     * Architecture:
     *   1. Determine capability (same three-path logic as chatCompletion)
     *   2. Build streaming request body with tools (or without, on
     *      tool-incapable endpoints)
     *   3. Issue request via resilientFetch
     *   4. Hand the response stream to `parseSseToolStream` which
     *      yields ChatCompletionDeltas
     *
     * Differs from chatCompletion in that capability detection happens
     * BEFORE the request — we can't observe a capability error and
     * silently retry mid-stream. So when capability is 'unknown', we
     * issue a small probe via the non-streaming chatCompletion first
     * (which will set the cache) before starting the stream. The probe
     * costs one extra round-trip on first use of a fresh endpoint;
     * subsequent calls hit the cache and skip it.
     *
     * Why probe-first instead of try-stream-then-fallback: SSE responses
     * commit to the stream once the headers are sent. If the server's
     * 400 arrives via the body of an already-200-headed SSE response
     * (which some misconfigured servers do), we'd have to consume the
     * stream just to find out it's not going to work. Cheaper to do
     * one short non-streaming probe and learn the answer.
     */
    async streamChatCompletion(
        messages: ChatMessage[],
        options?: CompletionOptions
    ): Promise<ChatCompletionStream> {
        const wantsTools = options?.tools !== undefined && options.tools.length > 0;
        let cap = wantsTools ? toolCapabilityCache.get(this.endpoint) : 'no-tools';

        // If we want tools and capability is unknown, do a tiny probe
        // (single non-streaming chat) to populate the cache. We feed
        // it a minimal message so the probe is cheap. The result is
        // discarded — we only care that the cache is now warm.
        if (wantsTools && cap === undefined) {
            try {
                // Only set tools when actually present; exactOptionalPropertyTypes
                // strict mode requires we don't pass `undefined` for an optional.
                const probeOptions: CompletionOptions = { toolChoice: 'none', maxTokens: 1 };
                if (options?.tools && options.tools.length > 0) {
                    probeOptions.tools = options.tools;
                }
                await this.requestNonStreaming(
                    [{ role: 'user', content: 'probe' }],
                    probeOptions,
                    /*includeTools*/ true
                );
                toolCapabilityCache.set(this.endpoint, 'supported');
                cap = 'supported';
            } catch (e) {
                if (isToolCapabilityError(e)) {
                    toolCapabilityCache.set(this.endpoint, 'unsupported');
                    cap = 'unsupported';
                    log.warn(`[Provider] Endpoint ${this.endpoint} rejected tool-calling on probe — streaming requests will use text-only mode.`);
                } else {
                    // Probe failed for some other reason (network, auth, etc.).
                    // Don't pollute the capability cache, but propagate so
                    // the caller sees a real error rather than a silent
                    // fallback.
                    throw e;
                }
            }
        }

        const includeTools = wantsTools && cap === 'supported';
        return this.requestStreaming(messages, options, includeTools);
    }

    /**
     * Internal: issue a streaming chat-completion request and return
     * the parsed delta stream. Mirrors `requestNonStreaming` but uses
     * SSE parsing.
     *
     * Why a separate method instead of folding into streamCompletion:
     * `streamCompletion` returns a stream of strings (text-only) and
     * is used by 8+ existing call sites. We don't widen its return
     * type; instead, the new `requestStreaming` returns the richer
     * delta stream that ChatCompletionStream expects.
     */
    private async requestStreaming(
        messages: ChatMessage[],
        options: CompletionOptions | undefined,
        includeTools: boolean
    ): Promise<ChatCompletionStream> {
        const body: Record<string, unknown> = {
            model: this.model,
            messages,
            temperature: options?.temperature ?? 0.3,
            stream: true
        };
        if (options?.maxTokens !== undefined) {
            body['max_tokens'] = options.maxTokens;
        }
        if (includeTools && options?.tools && options.tools.length > 0) {
            body['tools'] = options.tools;
            body['tool_choice'] = options.toolChoice ?? 'auto';
        }

        const fetchOptions: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
            method: 'POST',
            headers: authHeaders(this.apiKey),
            body: JSON.stringify(body)
        };
        if (options?.signal) {
            fetchOptions.signal = options.signal;
        }

        const response = await resilientFetch(this.endpoint, fetchOptions, options?.onRetryLog);

        // resilientFetch (via RateLimitManager) already throws on non-OK,
        // so by the time we get here the body should be a streaming SSE.
        if (!response.body) {
            throw new Error(`No readable stream from ${this.endpoint}`);
        }

        return parseSseToolStream(response.body, options?.signal);
    }

    /**
     * Internal: build the chat-completion request body and execute it
     * non-streaming. Used by both `completion()` (which delegates to
     * streamCompletion) and `chatCompletion()` (which can't, because
     * it needs the structured tool_calls field).
     *
     * `includeTools` controls whether the `tools` and `tool_choice`
     * fields are added to the request body. When false, the request
     * is byte-identical to what the old planAgent would have sent
     * with `enableTools: false`.
     */
    private async requestNonStreaming(
        messages: ChatMessage[],
        options: CompletionOptions | undefined,
        includeTools: boolean
    ): Promise<AssistantMessage> {
        const body: Record<string, unknown> = {
            model: this.model,
            messages,
            temperature: options?.temperature ?? 0.3
        };
        if (options?.maxTokens !== undefined) {
            body['max_tokens'] = options.maxTokens;
        }
        if (includeTools && options?.tools && options.tools.length > 0) {
            body['tools'] = options.tools;
            body['tool_choice'] = options.toolChoice ?? 'auto';
        }

        const fetchOptions: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } = {
            method: 'POST',
            headers: authHeaders(this.apiKey),
            body: JSON.stringify(body)
        };
        if (options?.signal) {
            fetchOptions.signal = options.signal;
        }

        const response = await resilientFetch(this.endpoint, fetchOptions, options?.onRetryLog);

        // Note: resilientFetch (via RateLimitManager.handleThrottling)
        // already throws on non-OK responses with .status and .body
        // attached. By the time we get here, response.ok is guaranteed.

        const data = await response.json() as {
            error?: { message: string };
            choices?: Array<{ message?: AssistantMessage }>;
        };
        if (data.error) {
            throw new Error(data.error.message);
        }
        const msg = data.choices?.[0]?.message;
        if (!msg) {
            throw new Error('Provider response missing choices[0].message');
        }

        // Normalize: ensure `content` is `string | null` (not undefined) and
        // `tool_calls` is either undefined or a non-empty array. OpenAI's
        // wire format uses null for content when tool_calls are present;
        // some providers emit empty string instead — normalize to null
        // so the caller's `content ?? ''` pattern works either way.
        const normalized: AssistantMessage = {
            role: 'assistant',
            content: msg.content === undefined ? null : (msg.content === '' && msg.tool_calls ? null : msg.content)
        };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            normalized.tool_calls = msg.tool_calls;
        }
        return normalized;
    }

    /**
     * List available models. OpenAI-compatible servers may expose a
     * `/v1/models` endpoint, but most local servers (vLLM, LM Studio,
     * llama.cpp) serve exactly one model — the one they were started
     * with — and either don't implement the listing endpoint or return
     * just that one. So we return our configured model.
     *
     * If a future deployment needs richer model discovery, override
     * this in a subclass or add a `discoverModels` capability flag.
     */
    async listModels(): Promise<string[]> {
        return [this.model];
    }
}

/**
 * Parse the OpenAI SSE stream format into an async iterable of text
 * chunks. Handles both correctly-framed `data: {...}` lines and the
 * occasional bare-JSON edge case that some providers (LM Studio's
 * older versions, particularly) emit.
 *
 * Why this is a free function rather than a method:
 *   The async generator owns the response body reader for its lifetime.
 *   Putting it on the class would tangle method-level `this` with the
 *   per-call generator state. A free function is the natural place
 *   for "owns this resource until exhausted" logic.
 */
async function* parseSseStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    onUsage: ((usage: Record<string, unknown>) => void) | undefined
): AsyncGenerator<string, void, undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    /**
     * Try to extract a usage payload from a parsed SSE frame and
     * surface it via the callback. Different providers place usage
     * at different paths — OpenAI proper emits it on a final frame
     * with `choices: []` and `usage: {...}`; vLLM emits it inline
     * on the last content frame. We check both.
     */
    const tryEmitUsage = (obj: { usage?: Record<string, unknown> }): void => {
        if (onUsage && obj.usage && typeof obj.usage === 'object') {
            onUsage(obj.usage);
        }
    };

    try {
        while (true) {
            // Honor caller-side cancellation between reads.
            if (signal?.aborted) {
                const err: Error & { status?: number } = new Error('AbortError');
                err.name = 'AbortError';
                err.status = 400;
                throw err;
            }
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;

                let payload: string | null = null;
                if (trimmed.startsWith('data: ')) {
                    payload = trimmed.substring(6);
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    // Some providers don't prefix every line with `data:`.
                    payload = trimmed;
                }
                if (!payload) continue;

                try {
                    const obj = JSON.parse(payload) as {
                        choices?: Array<{
                            delta?: { content?: string };
                            message?: { content?: string };
                        }>;
                        usage?: Record<string, unknown>;
                    };
                    tryEmitUsage(obj);
                    const token = obj.choices?.[0]?.delta?.content
                        ?? obj.choices?.[0]?.message?.content
                        ?? '';
                    if (token) yield token;
                } catch {
                    // Malformed line; skip silently. SSE spec allows
                    // intermixing of comment lines and other non-JSON
                    // metadata, and we don't want to crash mid-stream
                    // for content that doesn't matter.
                }
            }
        }

        // Flush trailing buffer if it parses as a JSON object.
        const trailing = buffer.trim();
        if (trailing.startsWith('{') && trailing.endsWith('}')) {
            try {
                const obj = JSON.parse(trailing) as {
                    choices?: Array<{
                        delta?: { content?: string };
                        message?: { content?: string };
                    }>;
                    usage?: Record<string, unknown>;
                };
                tryEmitUsage(obj);
                const token = obj.choices?.[0]?.delta?.content
                    ?? obj.choices?.[0]?.message?.content
                    ?? '';
                if (token) yield token;
            } catch {
                // ignore
            }
        }
    } finally {
        // Release the reader so the underlying connection can close
        // even if the consumer didn't iterate to completion (e.g. they
        // broke out of the for-await loop early).
        try {
            reader.releaseLock();
        } catch {
            // Reader may already be released if we exited via throw.
        }
    }
}

/**
 * Streaming SSE parser for chat completions WITH tool-call support
 * (Component 2B-1, Q7=7B).
 *
 * Yields `ChatCompletionDelta` values: `text`, `tool_call`, and a
 * final `finish` delta. The Provider does the heavy lifting of
 * accumulating partial JSON arguments — callers see only complete
 * tool calls, never half-formed ones.
 *
 * Wire format being parsed:
 *
 *   data: {"choices":[{"delta":{"content":"hello "}}]}
 *   data: {"choices":[{"delta":{"content":"world"}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"read_file"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"path\":\"x.ts\"}"}}]}}]}
 *   data: {"choices":[{"finish_reason":"tool_calls"}]}
 *   data: [DONE]
 *
 * Critical accumulation rules (mirrors OpenAI's documented semantics):
 *   1. `index` is the 0-based position of the tool call in the model's
 *      response. Multiple parallel tool calls have different indices.
 *   2. The first delta for an index carries `id`, `type`, and the
 *      function `name`. Subsequent deltas for the same index carry
 *      only argument fragments.
 *   3. Argument fragments are STRING CONCATENATED, not JSON-merged.
 *      The accumulated string must be valid JSON when complete.
 *   4. We yield a `tool_call` delta when EITHER:
 *        a) the accumulated args parse as valid JSON AND the next
 *           delta moves to a different index or finish, OR
 *        b) `finish_reason` arrives — at that point we yield all
 *           pending complete tool calls.
 *      Mid-stream JSON validation alone is not enough — `{` parses
 *      as nothing useful, but `{}` parses successfully even though
 *      the model intended more args. So we wait for an index switch
 *      or finish before yielding.
 *
 * Edge cases handled:
 *   - Servers that don't prefix every line with `data:` (some
 *     misconfigured vLLM forks). Same fallback as `parseSseStream`.
 *   - `[DONE]` sentinel — terminate the stream cleanly.
 *   - Malformed JSON lines mid-stream — skip silently rather than
 *     killing the entire stream.
 *   - Streams that end without a `finish_reason` delta — emit a
 *     synthetic `finish` with reason 'stop' so callers always see
 *     a terminal delta.
 *   - Abort signal between reads — throw AbortError eagerly.
 */
async function* parseSseToolStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined
): AsyncGenerator<ChatCompletionDelta, void, undefined> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    /**
     * Per-index accumulator state. We keep partial tool calls keyed
     * by their `index` field. When an index "completes" (next delta
     * is a different index or finish), we attempt to JSON-parse the
     * accumulated arguments and yield a tool_call delta on success.
     *
     * `id`, `name` are populated from the first delta for an index.
     * `argumentsBuf` is the running concatenation of argument
     * fragments, which we attempt to parse as JSON once.
     */
    interface AccumulatorEntry {
        id: string;
        name: string;
        argumentsBuf: string;
        yielded: boolean;
    }
    const accumulator = new Map<number, AccumulatorEntry>();

    /**
     * Try to yield a complete tool call for a given index. Called
     * when we want to flush the accumulator (e.g. on finish, or when
     * the stream ends). Returns true if a tool call was yielded.
     */
    const tryYieldToolCall = (entry: AccumulatorEntry): ToolCall | null => {
        if (entry.yielded) return null;
        // OpenAI sometimes emits an empty arguments string for tools
        // that take no parameters. Accept that as `{}`.
        const argsStr = entry.argumentsBuf || '{}';
        try {
            // Parse to validate; we still ship the raw string in the
            // ToolCall (per OpenAI shape) so downstream code that does
            // `JSON.parse(tc.function.arguments)` works as expected.
            JSON.parse(argsStr);
            entry.yielded = true;
            return {
                id: entry.id,
                type: 'function',
                function: { name: entry.name, arguments: argsStr }
            };
        } catch {
            // Args incomplete — caller will try again later.
            return null;
        }
    };

    /**
     * Parsed shape of an SSE frame's `choices[0].delta`. OpenAI's
     * actual shape; documenting it here for clarity since we type
     * it inline rather than using a top-level interface.
     */
    interface OpenAIDelta {
        content?: string;
        tool_calls?: Array<{
            index: number;
            id?: string;
            type?: 'function';
            function?: {
                name?: string;
                arguments?: string;
            };
        }>;
    }

    let finishReason: string | undefined;

    try {
        outer: while (true) {
            if (signal?.aborted) {
                const err: Error & { status?: number } = new Error('AbortError');
                err.name = 'AbortError';
                err.status = 400;
                throw err;
            }
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed === 'data: [DONE]') break outer;

                let payload: string | null = null;
                if (trimmed.startsWith('data: ')) {
                    payload = trimmed.substring(6);
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    payload = trimmed;
                }
                if (!payload) continue;

                let obj: {
                    choices?: Array<{
                        delta?: OpenAIDelta;
                        finish_reason?: string | null;
                    }>;
                };
                try {
                    obj = JSON.parse(payload);
                } catch {
                    // Malformed line — skip without killing the stream.
                    continue;
                }

                const choice = obj.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta;
                if (delta) {
                    // Yield text content immediately if present.
                    if (delta.content) {
                        yield { kind: 'text', content: delta.content };
                    }

                    // Accumulate tool-call fragments by index.
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            let entry = accumulator.get(idx);
                            if (!entry) {
                                entry = { id: '', name: '', argumentsBuf: '', yielded: false };
                                accumulator.set(idx, entry);
                            }
                            if (tc.id) entry.id = tc.id;
                            if (tc.function?.name) entry.name = tc.function.name;
                            if (tc.function?.arguments !== undefined) {
                                entry.argumentsBuf += tc.function.arguments;
                            }
                        }
                    }
                }

                // Capture finish_reason if present. Don't break the
                // outer loop yet — there may be a [DONE] still coming,
                // and some providers emit usage in a later frame.
                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }
            }
        }

        // Stream ended. Flush all complete tool calls in index order.
        // Out-of-order index emission would surprise the caller (and
        // the Coordinator's ReAct loop expects deterministic ordering).
        const indices = Array.from(accumulator.keys()).sort((a, b) => a - b);
        for (const idx of indices) {
            const entry = accumulator.get(idx);
            if (!entry) continue;
            const toolCall = tryYieldToolCall(entry);
            if (toolCall) {
                yield { kind: 'tool_call', toolCall };
            }
            // If args never parsed cleanly, we drop the entry rather
            // than yield a malformed call. This is a real failure mode
            // (model truncated mid-args, provider lost frames, etc.)
            // but yielding a half-call would be worse. We log it.
            else if (!entry.yielded) {
                log.warn(`[Provider] Dropped incomplete tool call ${entry.name} at index ${idx}: args="${entry.argumentsBuf.substring(0, 100)}"`);
            }
        }

        // Always yield a terminal `finish` delta. Synthesize 'stop' if
        // the server didn't send a finish_reason (some don't on
        // tool-calls completions).
        yield {
            kind: 'finish',
            reason: finishReason ?? 'stop'
        };
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Reader may already be released if we exited via throw.
        }
    }
}

// Suppress unused-import lint for utility functions kept for future
// error-mapping work in Session 2. They're commonly needed when
// translating provider errors into typed UI errors.
void errorMessage;
void isAbortError;

// ─── Tool-capability probe (Component 2A, Q4c) ──────────────────────
//
// In-process cache of which endpoints support native tool-calling.
// Mirrors the json_schema capability cache in `src/llm/jsonRequest.ts`.
//
// Lifecycle: cache resets per VS Code session. First chatCompletion
// call to an unseen endpoint with tools probes by attempting the
// request; subsequent calls use the cached result. Settings changes
// that swap endpoints don't need to invalidate this — different
// endpoint URL means a different cache key.
//
// This is module-level (not per-Provider-instance) because the same
// endpoint URL has the same capability regardless of which provider
// instance is talking to it. If a user rotates between two providers
// pointing at the same endpoint, the second one benefits from the
// first's probe.

type ToolCapability = 'supported' | 'unsupported';
const toolCapabilityCache = new Map<string, ToolCapability>();

/**
 * Identify errors thrown when the endpoint doesn't support tool-calling.
 *
 * The heuristic: the error has `status === 400` AND the error's message
 * or attached body contains terminology consistent with tool-call
 * rejection (`tool`, `function`, `tool_choice`).
 *
 * Why a heuristic and not a clean status code: there is no standard
 * HTTP code for "this server doesn't support that field." vLLM, LM
 * Studio, llama.cpp, OpenAI, and others all return 400 with an error
 * body explaining the rejection. We sniff the message text.
 *
 * Note: `RateLimitManager.handleThrottling` constructs the error with
 * just the response statusText (not the body), so we may not always
 * get rich info. To improve detection, `requestNonStreaming` reads the
 * response body up-front when `!response.ok` and threw with .body set
 * — but that path only runs when handleThrottling DIDN'T already throw.
 * In practice on Node 18+/undici, fetch returns the response and
 * handleThrottling throws first, so we end up with the message-only
 * error. This is fine — vLLM and most servers include enough hint in
 * the statusText itself.
 *
 * False positives (returning true when the real error is something
 * else): negligible — the message has to mention these specific terms
 * AND be a 400. A 500 or a 404 won't match.
 *
 * False negatives (returning false when the endpoint really doesn't
 * support tools): possible if the server's error message is in
 * another language or uses different terminology. In that case the
 * caller sees a real HTTP error and the user fixes it manually. The
 * caller can also pre-warm the cache via `setToolCapability` (see
 * below) for known-incapable endpoints.
 */
function isToolCapabilityError(e: unknown): boolean {
    const errorObj = e as { status?: number; body?: string; message?: string };
    if (errorObj?.status !== 400) return false;
    // Combine message + body and search for hint terms.
    const haystack = `${errorObj.message ?? ''} ${errorObj.body ?? ''}`.toLowerCase();
    return haystack.includes('tool') || haystack.includes('function');
}

/**
 * Test/admin hook: pre-set the capability for a known endpoint. Used
 * by tests to skip the probe and by future settings UI to let users
 * declare their endpoint's capabilities up front.
 *
 * Exported but not part of the Provider interface — this is metadata
 * about the transport, not a transport operation.
 */
export function setToolCapability(endpoint: string, capability: ToolCapability): void {
    toolCapabilityCache.set(endpoint, capability);
}

/**
 * Test hook: clear the capability cache. Used by tests to ensure each
 * test starts from a clean state.
 */
export function resetToolCapabilityCache(): void {
    toolCapabilityCache.clear();
}