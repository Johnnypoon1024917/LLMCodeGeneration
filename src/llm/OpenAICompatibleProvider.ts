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
import { extractThinkingFromContent } from './thinkingParser';
import { extractFallbackToolCalls } from './toolCallFallback';
import { appendToolSchemasToSystemPrompt } from './toolSchemaInjection';

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

        return parseSseStream(response.body, options?.signal, options?.onUsage, options?.excludeReasoning ?? false);
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
        if (options?.signal !== undefined) { args.signal = options.signal; }
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
            return this.requestNonStreaming(messages, options, /*includeTools*/ false, /*injectSchemasAsText*/ false);
        }

        // Path 2a: cache says endpoint supports tools — send with native tools, no probe
        if (cap === 'supported') {
            return this.requestNonStreaming(messages, options, /*includeTools*/ true, /*injectSchemasAsText*/ false);
        }

        // Path 2b: degraded — endpoint accepts tools field but model
        // doesn't use it. Skip the wire field (avoids wasted bytes)
        // and inject schemas into the system prompt as text. The
        // response-side fallback parser (extractFallbackToolCalls in
        // requestNonStreaming) handles `<tool_call>...</tool_call>`
        // text-mode responses.
        if (cap === 'degraded') {
            return this.requestNonStreaming(messages, options, /*includeTools*/ false, /*injectSchemasAsText*/ true);
        }

        // Path 3: capability unknown — try with tools, fall back on capability error
        try {
            const result = await this.requestNonStreaming(messages, options, /*includeTools*/ true, /*injectSchemasAsText*/ false);
            // Success: mark endpoint capable. (requestNonStreaming
            // also records the native tool-call result for capability
            // tracking — one nuance: the very first probe-via-real-
            // -request response counts toward the degraded threshold
            // if it came back empty, which is what we want.)
            toolCapabilityCache.set(this.endpoint, 'supported');
            log.info(`[Provider] Endpoint ${this.endpoint} supports native tool-calling.`);
            return result;
        } catch (e) {
            if (isToolCapabilityError(e)) {
                log.warn(`[Provider] Endpoint ${this.endpoint} rejected tool-calling — falling back to text-only mode for this and future requests.`);
                toolCapabilityCache.set(this.endpoint, 'unsupported');
                return this.requestNonStreaming(messages, options, /*includeTools*/ false, /*injectSchemasAsText*/ false);
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
                    /*includeTools*/ true,
                    /*injectSchemasAsText*/ false
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
        const injectSchemasAsText = wantsTools && cap === 'degraded';
        return this.requestStreaming(messages, options, includeTools, injectSchemasAsText);
    }

    /**
     * Apply tool-schema text injection to the messages array if enabled.
     * Returns a new array (does not mutate the caller's). When the
     * messages already contain a system message, the schemas are
     * appended to its content. When there's no system message, a new
     * one is prepended carrying just the schemas.
     *
     * Pure function (well, allocates arrays — pure semantically): the
     * caller passes messages in, gets a transformed copy back. No
     * side effects on the cache or the network.
     */
    private maybeInjectToolSchemas(
        messages: ChatMessage[],
        options: CompletionOptions | undefined,
        injectSchemasAsText: boolean
    ): ChatMessage[] {
        if (!injectSchemasAsText) { return messages; }
        if (!options?.tools || options.tools.length === 0) { return messages; }

        // Find the existing system message (if any). The OpenAI spec
        // doesn't require a system message at index 0 specifically, but
        // it's the universal convention; we walk to find it just to
        // be defensive.
        const systemIndex = messages.findIndex((m) => m.role === 'system');
        if (systemIndex >= 0) {
            const existing = messages[systemIndex]!;
            const updatedContent = appendToolSchemasToSystemPrompt(
                typeof existing.content === 'string' ? existing.content : '',
                options.tools
            );
            const out = messages.slice();
            out[systemIndex] = { ...existing, content: updatedContent };
            return out;
        }

        // No system message → prepend one carrying just the schemas.
        const rendered = appendToolSchemasToSystemPrompt('', options.tools);
        if (rendered.length === 0) { return messages; }
        return [{ role: 'system', content: rendered }, ...messages];
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
        includeTools: boolean,
        injectSchemasAsText: boolean
    ): Promise<ChatCompletionStream> {
        const effectiveMessages = this.maybeInjectToolSchemas(messages, options, injectSchemasAsText);
        // V2.2 hotfix #6: pre-dispatch context-budget check. Production
        // logs showed Qwen 27B (32K context) failing with HTTP 400
        // "input_tokens=28673" mid-task. The bloat came from accumulated
        // tool_result messages (full file contents from read_file etc.)
        // piling up across the agent loop. Pre-trim here: estimate
        // input tokens, subtract the output reservation, and if we'd
        // overflow, drop oldest tool messages until we fit.
        let reservedOutput: number;
        if (options?.maxTokens !== undefined) {
            reservedOutput = options.maxTokens;
        } else if (includeTools || injectSchemasAsText) {
            reservedOutput = DEFAULT_MAX_TOKENS_WITH_TOOLS;
        } else {
            reservedOutput = 1024;
        }
        const trimmedMessages = trimToContextBudget(effectiveMessages, reservedOutput);

        const body: Record<string, unknown> = {
            model: this.model,
            messages: trimmedMessages,
            temperature: options?.temperature ?? 0.3,
            stream: true
        };
        if (options?.maxTokens !== undefined) {
            body['max_tokens'] = options.maxTokens;
        } else if (includeTools || injectSchemasAsText) {
            // When tools are in play and the caller didn't specify a
            // limit, force a sensible floor. Some inference servers
            // (vLLM in some configs, llama.cpp under default settings)
            // apply tiny defaults like 16 or 256 tokens when the
            // request omits max_tokens. That cap deterministically
            // truncates write_file calls mid-arguments JSON, producing
            // "[Provider] Dropped incomplete tool call write_file at
            // index 0: args=..." warnings even when the model and
            // chat template are otherwise fine. 4096 is generous
            // enough for write_file with ~3KB content plus reasoning,
            // and small enough to not bump model context limits.
            body['max_tokens'] = DEFAULT_MAX_TOKENS_WITH_TOOLS;
        }
        if (options?.topP !== undefined) {
            body['top_p'] = options.topP;
        }
        if (options?.presencePenalty !== undefined) {
            body['presence_penalty'] = options.presencePenalty;
        }
        if (includeTools && options?.tools && options.tools.length > 0) {
            body['tools'] = options.tools;
            body['tool_choice'] = options.toolChoice ?? 'auto';
        }

        // V2.0: forward extra_body to streaming requests too, mirroring
        // requestNonStreaming. Note that the SSE parser (parseSseToolStream
        // below) doesn't currently surface `delta.reasoning_content` to
        // consumers — when enableThinking is true the model may emit
        // reasoning that's silently dropped from the stream. The visible
        // text in `delta.content` still arrives intact; thinking-mode
        // streaming display is a separate PR. Sending the flags is safe
        // because non-Qwen servers ignore extra_body.
        const extraBody: Record<string, unknown> = {};
        if (options?.topK !== undefined) {
            extraBody['top_k'] = options.topK;
        }
        const chatTemplateKwargs: Record<string, unknown> = {};
        if (options?.enableThinking !== undefined) {
            chatTemplateKwargs['enable_thinking'] = options.enableThinking;
        }
        if (options?.preserveThinking !== undefined) {
            chatTemplateKwargs['preserve_thinking'] = options.preserveThinking;
        }
        if (Object.keys(chatTemplateKwargs).length > 0) {
            extraBody['chat_template_kwargs'] = chatTemplateKwargs;
        }
        if (Object.keys(extraBody).length > 0) {
            body['extra_body'] = extraBody;
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
        includeTools: boolean,
        injectSchemasAsText: boolean
    ): Promise<AssistantMessage> {
        const effectiveMessages = this.maybeInjectToolSchemas(messages, options, injectSchemasAsText);
        // V2.2 hotfix #6: same context-budget trim as requestStreaming.
        let reservedOutputNs: number;
        if (options?.maxTokens !== undefined) {
            reservedOutputNs = options.maxTokens;
        } else if (includeTools || injectSchemasAsText) {
            reservedOutputNs = DEFAULT_MAX_TOKENS_WITH_TOOLS;
        } else {
            reservedOutputNs = 1024;
        }
        const trimmedMessagesNs = trimToContextBudget(effectiveMessages, reservedOutputNs);
        const body: Record<string, unknown> = {
            model: this.model,
            messages: trimmedMessagesNs,
            temperature: options?.temperature ?? 0.3
        };
        if (options?.maxTokens !== undefined) {
            body['max_tokens'] = options.maxTokens;
        } else if (includeTools || injectSchemasAsText) {
            // See requestStreaming for the rationale — same truncation
            // failure mode applies to non-streaming tool-using requests.
            body['max_tokens'] = DEFAULT_MAX_TOKENS_WITH_TOOLS;
        }
        if (options?.topP !== undefined) {
            body['top_p'] = options.topP;
        }
        if (options?.presencePenalty !== undefined) {
            body['presence_penalty'] = options.presencePenalty;
        }
        if (includeTools && options?.tools && options.tools.length > 0) {
            body['tools'] = options.tools;
            body['tool_choice'] = options.toolChoice ?? 'auto';
        }

        // V2.0: extra_body carries Qwen 3.6 / DeepSeek R1 thinking-mode
        // controls + top_k. The shape exactly matches what's documented
        // in the Qwen 3.6 README (see HF model card). Non-Qwen servers
        // (vLLM, SGLang, LM Studio) treat extra_body as opaque pass-
        // through; OpenAI's spec calls it "additional fields ignored
        // by unknown servers." Either way it's safe to send.
        const extraBody: Record<string, unknown> = {};
        if (options?.topK !== undefined) {
            extraBody['top_k'] = options.topK;
        }
        const chatTemplateKwargs: Record<string, unknown> = {};
        if (options?.enableThinking !== undefined) {
            chatTemplateKwargs['enable_thinking'] = options.enableThinking;
        }
        if (options?.preserveThinking !== undefined) {
            chatTemplateKwargs['preserve_thinking'] = options.preserveThinking;
        }
        if (Object.keys(chatTemplateKwargs).length > 0) {
            extraBody['chat_template_kwargs'] = chatTemplateKwargs;
        }
        if (Object.keys(extraBody).length > 0) {
            body['extra_body'] = extraBody;
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
            choices?: Array<{ message?: AssistantMessage & {
                reasoning_content?: string;
                /**
                 * Qwen 3.6 native field name. Per the ASL Lab Qwen 3.6
                 * deployment, the response uses `reasoning` rather than
                 * `reasoning_content`, and the value may include literal
                 * `<think>...</think>` tags inline. We accept both
                 * field names and strip the tags defensively.
                 */
                reasoning?: string;
            } }>;
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
        let rawContent: string | null = msg.content === undefined
            ? null
            : (msg.content === '' && msg.tool_calls ? null : msg.content);

        // V2.0: defensively strip thinking-block leaks from content
        // AND from the reasoning field. Two known endpoint variants:
        //
        //   1. vLLM with `--reasoning-parser qwen3`:
        //      emits `reasoning_content` cleanly (no tags inside).
        //
        //   2. ASL Lab Qwen 3.6 deployment (this codebase's V2.0
        //      target): emits `reasoning` with literal `<think>...</think>`
        //      tags inline. We strip the tags before surfacing.
        //
        // Plus the leak case (Qwen issue #26 / #89): when reasoning_content
        // isn't echoed back in history or when tools are active, the
        // model can leak `<think>...</think>` blocks into `content`. We
        // strip those and merge into the reasoning surface so downstream
        // JSON parsers don't choke on stray tags.
        const rawReasoning: string | undefined =
            (typeof msg.reasoning === 'string' && msg.reasoning !== '')
                ? msg.reasoning
                : (typeof msg.reasoning_content === 'string' && msg.reasoning_content !== ''
                    ? msg.reasoning_content
                    : undefined);
        let surfacedReasoning: string | undefined;
        if (rawReasoning !== undefined) {
            // The reasoning field may contain inline <think>...</think>
            // tags (Qwen 3.6 ASL Lab variant). Run it through the same
            // extractor we use for content — if tags are found, the
            // extracted text is the actual reasoning; if no tags, the
            // whole field is the reasoning.
            const parsed = extractThinkingFromContent(rawReasoning);
            surfacedReasoning = parsed.extracted !== '' ? parsed.extracted : rawReasoning;
        }
        if (rawContent !== null && rawContent.length > 0) {
            const parsed = extractThinkingFromContent(rawContent);
            if (parsed.extracted !== '') {
                if (surfacedReasoning === undefined) {
                    surfacedReasoning = parsed.extracted;
                } else {
                    // Both present — keep the explicit one but log so
                    // we can see how often the leak happens
                    log.warn('[Provider] reasoning field present AND <think> leaked into content; using explicit reasoning field.');
                }
                rawContent = parsed.clean.length > 0 ? parsed.clean : null;
            }
        }

        const normalized: AssistantMessage = {
            role: 'assistant',
            content: rawContent
        };
        // Track whether the SERVER's native tool-calling channel
        // produced calls. We record this BEFORE the fallback parser
        // runs, because fallback recovery is itself a sign the
        // endpoint is degraded — counting it as success would mask
        // the problem.
        const nativeToolCallCount = (msg.tool_calls?.length ?? 0);
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            normalized.tool_calls = msg.tool_calls;
        } else if (rawContent !== null && rawContent.length > 0) {
            // V2.0 follow-up: client-side fallback for inference servers
            // that didn't surface tool calls in the native field. Triggered
            // only when (a) the server returned no native tool_calls, and
            // (b) there's content to inspect. The fallback parser handles
            // 5 known formats — see toolCallFallback.ts. Empty result is
            // the common case (model genuinely produced just text); when
            // we DO recover calls, we log a warn so this can be tracked
            // by compliance review of the audit log.
            const fallback = extractFallbackToolCalls(rawContent);
            if (fallback.toolCalls.length > 0) {
                normalized.tool_calls = fallback.toolCalls;
                // Replace content with the cleaned version (tool-call
                // blocks removed). The narrative prose around the calls
                // is preserved so the agent's reasoning is still visible.
                normalized.content = fallback.cleanContent.length > 0
                    ? fallback.cleanContent
                    : null;
                log.warn(
                    `[Provider] Fallback tool-call parser recovered ${fallback.toolCalls.length} call(s) ` +
                    `from format(s): ${fallback.formatsDetected.join(', ')}. ` +
                    `Inference server's --tool-call-parser is likely misconfigured for this model.`
                );
            }
        }
        if (surfacedReasoning !== undefined) {
            normalized.reasoning_content = surfacedReasoning;
        }
        // Capability tracking: only meaningful when we actually
        // requested tools. If `includeTools` was false the model had
        // no opportunity to call anything, so this response carries
        // zero information about endpoint capability.
        const wantsTools = options?.tools !== undefined && options.tools.length > 0;
        if (wantsTools && includeTools) {
            try {
                recordToolUsageResult(this.endpoint, nativeToolCallCount > 0);
            } catch {
                // Defensive: tracking is observability, not load-bearing.
            }
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
    onUsage: ((usage: Record<string, unknown>) => void) | undefined,
    excludeReasoning: boolean
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

    /**
     * Extract a token from a parsed SSE frame.
     *
     * Default mode (excludeReasoning=false): reads BOTH
     * `delta.reasoning_content` and `delta.content` and concatenates
     * them. Reasoning precedes content, matching Qwen's chat template.
     * This is the historical behavior — necessary because some Qwen
     * builds with `--reasoning-parser qwen3` route ALL output through
     * `reasoning_content`, including the actual answer (Qwen issue
     * #903). Without this, the user sees no output at all.
     *
     * V2.1.2 spec-fix-15 mode (excludeReasoning=true): returns ONLY
     * `content`. The chain-of-thought (`reasoning_content` /
     * `reasoning`) is dropped entirely — never reaches the chat
     * stream, never gets stored in message history. Used by chat-style
     * callers that want a clean answer.
     *
     * Caveat for excludeReasoning mode: if the model puts the actual
     * answer in `reasoning_content` instead of `content`, the chat
     * appears empty. The streamChat caller detects this via the
     * existing `sawAnyTokenContent` guard and throws
     * EmptyCompletionError, surfacing a clear message rather than
     * silent failure. That's the correct tradeoff: a transient empty-
     * response error is much better UX than dumping 4KB of internal
     * chain-of-thought into every chat message.
     */
    const extractToken = (frame: {
        choices?: Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string };
            message?: { content?: string; reasoning_content?: string; reasoning?: string };
        }>;
    }): string => {
        const choice = frame.choices?.[0];
        if (!choice) { return ''; }
        const content = choice.delta?.content
            ?? choice.message?.content
            ?? '';
        if (excludeReasoning) {
            // Drop reasoning entirely. Caller asked for clean content.
            return content;
        }
        // Read reasoning from BOTH possible field names. ASL Lab Qwen 3.6
        // uses `reasoning`; vLLM with `--reasoning-parser qwen3` uses
        // `reasoning_content`. Either may carry the chain-of-thought.
        // Field-name precedence is symmetric (whichever is present wins);
        // both never appear together in practice.
        const reasoning = choice.delta?.reasoning
            ?? choice.delta?.reasoning_content
            ?? choice.message?.reasoning
            ?? choice.message?.reasoning_content
            ?? '';
        // Defensively strip stray <think> tags from reasoning. Some
        // endpoints (Qwen 3.6 ASL Lab variant) emit them inline. The
        // tags would render as plain text in the reasoning panel
        // otherwise. See parseSseToolStream main-loop block for the
        // mirror of this stripping in the tool-stream path.
        const strippedReasoning = reasoning
            .replace(/<think>/gi, '')
            .replace(/<\/think>/gi, '');
        return strippedReasoning + content;
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
            if (done) { break; }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') { continue; }

                let payload: string | null = null;
                if (trimmed.startsWith('data: ')) {
                    payload = trimmed.substring(6);
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    // Some providers don't prefix every line with `data:`.
                    payload = trimmed;
                }
                if (!payload) { continue; }

                try {
                    const obj = JSON.parse(payload) as {
                        choices?: Array<{
                            delta?: { content?: string; reasoning_content?: string };
                            message?: { content?: string; reasoning_content?: string };
                        }>;
                        usage?: Record<string, unknown>;
                    };
                    tryEmitUsage(obj);
                    const token = extractToken(obj);
                    if (token) { yield token; }
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
                        delta?: { content?: string; reasoning_content?: string };
                        message?: { content?: string; reasoning_content?: string };
                    }>;
                    usage?: Record<string, unknown>;
                };
                tryEmitUsage(obj);
                const token = extractToken(obj);
                if (token) { yield token; }
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
        if (entry.yielded) { return null; }
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
        /**
         * V2.0 follow-up: reasoning channel for thinking-mode endpoints.
         * Two known field names:
         *
         *   - `reasoning_content` — emitted by vLLM with
         *     `--reasoning-parser qwen3` and similar configurations
         *
         *   - `reasoning` — emitted by ASL Lab Qwen 3.6 deployment
         *     (and possibly other deployments that don't run the
         *     OpenAI-style reasoning-parser). May contain inline
         *     `<think>...</think>` tags that need defensive stripping.
         *
         * We accept both. Field-name precedence is symmetric — whichever
         * is present wins. Streaming consumers see the output as
         * text-kind deltas. A future webview update can separate
         * reasoning into a collapsible "thinking..." block; for now,
         * both stream into the chat as text.
         */
        reasoning_content?: string;
        reasoning?: string;
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
            if (done) {
                // Flush residual content in the buffer before breaking.
                // SSE servers SHOULD send a trailing newline before
                // closing, but many don't (vLLM under load, abrupt
                // disconnects, max_tokens cutoff with no graceful
                // wind-down). Without this flush, the final
                // `data: {...}` frame — often the one carrying the
                // closing tool-call arguments fragment AND the
                // finish_reason — gets silently discarded, and the
                // tool-call accumulator ends up incomplete. Symptom
                // in production: "[Provider] Dropped incomplete tool
                // call write_file at index 0: args=..." with the
                // arguments JSON cut off mid-string.
                if (buffer.length > 0) {
                    const trimmed = buffer.trim();
                    buffer = '';
                    if (trimmed && trimmed !== 'data: [DONE]') {
                        let payload: string | null = null;
                        if (trimmed.startsWith('data: ')) {
                            payload = trimmed.substring(6);
                        } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                            payload = trimmed;
                        }
                        if (payload) {
                            try {
                                const obj = JSON.parse(payload) as {
                                    choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string | null }>;
                                };
                                const choice = obj.choices?.[0];
                                if (choice) {
                                    const delta = choice.delta;
                                    if (delta) {
                                        // Mirror the main-loop logic: read both
                                        // reasoning field names and strip stray
                                        // <think> tags. See main loop above for rationale.
                                        const reasoningChunk = delta.reasoning ?? delta.reasoning_content;
                                        if (reasoningChunk) {
                                            const stripped = reasoningChunk
                                                .replace(/<think>/gi, '')
                                                .replace(/<\/think>/gi, '');
                                            if (stripped.length > 0) {
                                                yield { kind: 'text', content: stripped };
                                            }
                                        }
                                        if (delta.content) {
                                            yield { kind: 'text', content: delta.content };
                                        }
                                        if (delta.tool_calls) {
                                            for (const tc of delta.tool_calls) {
                                                const idx = tc.index;
                                                let entry = accumulator.get(idx);
                                                if (!entry) {
                                                    entry = { id: '', name: '', argumentsBuf: '', yielded: false };
                                                    accumulator.set(idx, entry);
                                                }
                                                if (tc.id) { entry.id = tc.id; }
                                                if (tc.function?.name) { entry.name = tc.function.name; }
                                                if (tc.function?.arguments !== undefined) {
                                                    entry.argumentsBuf += tc.function.arguments;
                                                }
                                            }
                                        }
                                    }
                                    if (choice.finish_reason) {
                                        finishReason = choice.finish_reason;
                                    }
                                }
                            } catch {
                                // Residual was malformed — nothing we can do.
                            }
                        }
                    }
                }
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) { continue; }
                if (trimmed === 'data: [DONE]') { break outer; }

                let payload: string | null = null;
                if (trimmed.startsWith('data: ')) {
                    payload = trimmed.substring(6);
                } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    payload = trimmed;
                }
                if (!payload) { continue; }

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
                if (!choice) { continue; }

                const delta = choice.delta;
                if (delta) {
                    // Yield reasoning-channel text first if present
                    // (thinking-mode endpoints). Read from BOTH possible
                    // field names: `reasoning_content` (vLLM with
                    // --reasoning-parser qwen3) and `reasoning` (ASL Lab
                    // Qwen 3.6 deployment). For non-thinking endpoints
                    // both are undefined, so behavior is unchanged.
                    // See OpenAIDelta docstring.
                    const reasoningChunk = delta.reasoning ?? delta.reasoning_content;
                    if (reasoningChunk) {
                        // Defensively strip stray <think> / </think> tags
                        // that some endpoints emit inline within the
                        // reasoning field (Qwen 3.6 ASL Lab variant).
                        // Streaming-mode stripping is line-cheap because
                        // the tag text is always whole within a single
                        // chunk in practice. If we ever see partial
                        // tags spanning chunks the user sees a brief
                        // "<think" flash and then the rest — acceptable.
                        const stripped = reasoningChunk
                            .replace(/<think>/gi, '')
                            .replace(/<\/think>/gi, '');
                        if (stripped.length > 0) {
                            yield { kind: 'text', content: stripped };
                        }
                    }
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
                            if (tc.id) { entry.id = tc.id; }
                            if (tc.function?.name) { entry.name = tc.function.name; }
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
            if (!entry) { continue; }
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

// 'supported'  → endpoint accepts tools AND model uses them. Native
//                 OpenAI tool-calling works as documented.
// 'unsupported' → endpoint rejects the `tools` field outright with a
//                 400 error mentioning tool/function/tool_choice.
//                 We strip the field and skip tool calls entirely.
// 'degraded'   → endpoint accepts the `tools` field (no 400 error)
//                 but the model never produces actual tool_calls in
//                 response — instead emitting tutorial-prose content.
//                 Detected after N consecutive empty-tool_calls
//                 responses where the model wrote markdown about
//                 the tools instead of calling them.
//
//                 In degraded mode we render tool schemas into the
//                 system prompt as text and parse responses with
//                 extractFallbackToolCalls. This keeps the agent
//                 working for customers running misconfigured
//                 inference servers (most commonly Qwen 2.5 Coder
//                 on vLLM without --tool-call-parser hermes).
type ToolCapability = 'supported' | 'unsupported' | 'degraded';
const toolCapabilityCache = new Map<string, ToolCapability>();

// How many consecutive prose-instead-of-tools responses before we
// mark an endpoint as degraded. Three is a balance: one or two could
// be a model legitimately deciding the user wanted an explanation
// rather than an action, but three in a row when tools are in the
// request is a structural problem with the chat template.
const DEGRADED_DETECTION_THRESHOLD = 3;

// Per-endpoint counter of consecutive responses where we requested
// tools but got back empty tool_calls + non-empty content.
const consecutiveProseResponses = new Map<string, number>();

// Default max_tokens to send when the caller didn't specify one AND
// the request involves tool calls. Without this floor, some inference
// servers (vLLM with no max_tokens default, llama.cpp under default
// settings) truncate tool-call argument streams mid-JSON, producing
// "[Provider] Dropped incomplete tool call" warnings. 4096 was chosen
// to comfortably fit a write_file with ~3KB content plus surrounding
// reasoning/narrative, while staying well below typical 32K+ context
// limits. Customers who need larger writes should set the max
// explicitly via CompletionOptions.maxTokens — this is just a floor.
const DEFAULT_MAX_TOKENS_WITH_TOOLS = 4096;

// V2.2 hotfix #6: context-budget management.
//
// MODEL_CONTEXT_LIMIT is the assumed max input + output token capacity
// of the connected endpoint. Qwen 27B = 32768 in the ASL Lab config.
// We use 28000 as the budget ceiling — a 4-5K buffer below the hard
// limit accounts for:
//   - tokenizer differences (our char-based estimate is approximate)
//   - server-side prompt template additions (chat formatting, system
//     prefixes that vary by deployment)
//   - response output reservation (max_tokens is bounded against this
//     remaining budget)
//
// If we ship NexusCode with a 200K context model later, this becomes
// a config knob. For now, hardcoded to ASL's deployment.
const MODEL_CONTEXT_LIMIT = 32_000;
const SAFE_INPUT_BUDGET = 28_000;

/**
 * Estimate tokens in a JSON-ish string. Heuristic only — char count
 * divided by 4. Holds reasonably for English code (~3.5-4 chars/token
 * with the BPE tokenizers most LLMs use). Slightly conservative: we
 * over-estimate small messages slightly and under-estimate strings
 * with lots of whitespace, but in aggregate across many messages the
 * error averages out.
 *
 * Why not use a real tokenizer: shipping a tokenizer in a VS Code
 * extension means either bundling 100MB+ of weights (Qwen) or making
 * an HTTP call to count (latency on every request). Char-heuristic
 * with a 4-5K buffer below the cap is good enough for safety.
 */
function estimateTokens(s: string): number {
    return Math.ceil(s.length / 4);
}

/** Estimate tokens in a single message including role/tool metadata. */
function estimateMessageTokens(msg: ChatMessage): number {
    // Per-message overhead from chat templating: roles, separators,
    // tool_call_id wrapping, etc. ~10 tokens per message is typical
    // for OpenAI-style chat formats.
    let total = 10;
    const content = (msg as unknown as { content?: unknown }).content;
    if (typeof content === 'string') {
        total += estimateTokens(content);
    } else if (Array.isArray(content)) {
        // Multimodal content blocks (defensive — current ChatMessage
        // typing is string-only, but future expansion may add image
        // or document blocks). Each block with a text field gets its
        // text counted; non-text blocks get a flat per-block estimate.
        for (const block of content) {
            if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
                total += estimateTokens((block as { text: string }).text);
            } else {
                total += 50; // image/document placeholder cost
            }
        }
    }
    // Tool calls add their JSON arguments to the prompt.
    const maybeToolCalls = (msg as unknown as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(maybeToolCalls)) {
        for (const tc of maybeToolCalls) {
            if (tc && typeof tc === 'object' && 'function' in tc) {
                const fn = (tc as { function: { name?: string; arguments?: string } }).function;
                total += estimateTokens(fn.arguments || '');
                total += estimateTokens(fn.name || '');
            }
        }
    }
    return total;
}

/**
 * Trim the message history to fit within the input-token budget.
 *
 * Strategy:
 *   1. Always keep the system message (carries instructions + tool
 *      schemas). Without it the model loses its grounding.
 *   2. Always keep the last user message (the current task).
 *   3. Always keep the last assistant message + its tool_use children
 *      and the current tool_result follow-ups (the in-flight context).
 *   4. Drop oldest tool_result + their preceding tool_use pair-wise
 *      until we fit. Tool calls and their results are tightly coupled
 *      (the model expects a result for every call); dropping them in
 *      pairs preserves protocol consistency.
 *   5. If even the keep-set is too large, the function returns it
 *      unchanged and lets the API reject. We log a warning — there's
 *      no graceful fix when the FIRST user message alone overflows.
 *
 * Adds a synthetic system note when trimming actually happened so the
 * model knows context was truncated and can ask for re-reads if needed.
 */
function trimToContextBudget(
    messages: ChatMessage[],
    reservedOutput: number
): ChatMessage[] {
    const inputBudget = Math.min(SAFE_INPUT_BUDGET, MODEL_CONTEXT_LIMIT - reservedOutput);

    // Fast path: estimate total. If we fit, no work.
    let total = 0;
    for (const msg of messages) {
        total += estimateMessageTokens(msg);
    }
    if (total <= inputBudget) { return messages; }

    log.warn(`[Provider] Context budget overflow detected: ~${total} tokens for ${messages.length} messages, budget=${inputBudget}. Trimming oldest tool history.`);

    // Identify protected indices: system (first), and the tail.
    // We keep everything from the last user message onward.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    if (lastUserIdx === -1) {
        // No user message — unusual, can't trim safely. Return as-is.
        return messages;
    }
    const protectedIndices = new Set<number>();
    if (messages.length > 0 && messages[0]!.role === 'system') {
        protectedIndices.add(0);
    }
    for (let i = lastUserIdx; i < messages.length; i++) {
        protectedIndices.add(i);
    }

    // Walk from oldest non-protected message; mark as droppable.
    // Protocol-correctness: in OpenAI chat format, every tool_result
    // must have a preceding assistant message with a matching
    // tool_use. So we drop assistant+tool_result clusters together
    // when possible rather than orphaning a tool_result.
    const kept: ChatMessage[] = [];
    let droppedTokens = 0;
    let droppedCount = 0;
    for (let i = 0; i < messages.length; i++) {
        if (protectedIndices.has(i)) {
            kept.push(messages[i]!);
            continue;
        }
        const msgTokens = estimateMessageTokens(messages[i]!);
        // Drop only as much as needed to get under budget.
        if (total - droppedTokens > inputBudget) {
            droppedTokens += msgTokens;
            droppedCount++;
        } else {
            kept.push(messages[i]!);
        }
    }

    if (droppedCount === 0) { return messages; }

    // Insert a synthetic system note about the trim so the model
    // knows context was lost. Placed right after the system message
    // (or at index 0 if no system) so it sits at the start of the
    // model's "given" context.
    const trimNote: ChatMessage = {
        role: 'system',
        content: `[Earlier conversation was trimmed to fit the model's context window. ${droppedCount} older message${droppedCount === 1 ? '' : 's'} (~${droppedTokens} tokens) were dropped, including some tool call history. If you need information from earlier, ask the user or re-read the relevant files.]`
    };
    const insertAt = kept.length > 0 && kept[0]!.role === 'system' ? 1 : 0;
    kept.splice(insertAt, 0, trimNote);
    return kept;
}

/**
 * Record whether a tool-requesting response actually used tools.
 * Called by requestStreaming/requestNonStreaming after each response
 * where `tools` was in the request.
 *
 *   - usedTools=true  → reset the counter; the model is using tools.
 *   - usedTools=false → increment; if we hit threshold, mark degraded.
 *
 * If the endpoint is already marked unsupported, we don't touch
 * anything — that takes precedence and is a stronger signal.
 */
export function recordToolUsageResult(
    endpoint: string,
    usedTools: boolean
): void {
    const existing = toolCapabilityCache.get(endpoint);
    if (existing === 'unsupported') { return; }

    if (usedTools) {
        consecutiveProseResponses.delete(endpoint);
        // If the endpoint was previously marked degraded but the
        // model just used a tool, that's a strong "actually fine"
        // signal — promote to supported. Could happen if the
        // customer fixed their vLLM config mid-session.
        if (existing === 'degraded') {
            toolCapabilityCache.set(endpoint, 'supported');
            log.info(
                `[Provider] Endpoint ${endpoint} recovered to native ` +
                `tool-calling mode.`
            );
        }
        return;
    }

    const next = (consecutiveProseResponses.get(endpoint) ?? 0) + 1;
    consecutiveProseResponses.set(endpoint, next);

    if (next >= DEGRADED_DETECTION_THRESHOLD && existing !== 'degraded') {
        toolCapabilityCache.set(endpoint, 'degraded');
        log.warn(
            `[Provider] Endpoint ${endpoint} marked as degraded: ` +
            `${next} consecutive responses with empty tool_calls when ` +
            `tools were requested. Falling back to text-mode tool calling. ` +
            `This usually means the inference server's chat template is ` +
            `not configured for native tool-calling (e.g. vLLM needs ` +
            `--tool-call-parser hermes for Qwen). The agent will keep ` +
            `working via fallback parsing, but consider fixing the server ` +
            `config for better reliability.`
        );
    }
}

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
    if (errorObj?.status !== 400) { return false; }
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
 * Test hook: read the current capability for an endpoint. Returns
 * undefined if the endpoint hasn't been observed yet. Used by
 * unit tests to assert state transitions without round-tripping
 * through real HTTP requests.
 */
export function getToolCapability(endpoint: string): ToolCapability | undefined {
    return toolCapabilityCache.get(endpoint);
}

/**
 * Test hook: clear the capability cache. Used by tests to ensure each
 * test starts from a clean state.
 */
export function resetToolCapabilityCache(): void {
    toolCapabilityCache.clear();
    consecutiveProseResponses.clear();
}