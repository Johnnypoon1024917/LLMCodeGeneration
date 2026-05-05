// src/llm/Provider.ts
//
// Provider interface — the LLM transport abstraction.
//
// Architecture (three layers, outside-in):
//
//   1. Orchestration layer  — `llmService.ts`'s exported functions.
//      Build prompts, manage history, emit audit records, decode
//      domain-specific JSON. Calls into the Provider for raw transport.
//
//   2. Provider layer       — this interface and its implementations.
//      Speaks one specific wire protocol (currently OpenAI-compatible
//      chat completions). Does retry, rate limiting, JSON-mode probing,
//      streaming protocol parsing. Knows nothing about prompts.
//
//   3. Network layer        — `RetryManager` + `RateLimitManager` +
//      raw `fetch`. Thread-safe primitives the Provider implementation
//      composes.
//
// Why this split:
//   - Adding a new wire protocol (Huawei MindIE, Anthropic, etc.) means
//     writing one new file that implements `Provider`. No changes to
//     llmService.ts or the 22 functions that build prompts.
//   - Audit emission stays in the orchestration layer. The Provider
//     doesn't carry IDE-specific concerns.
//   - Tests can inject a mock Provider without touching prompt
//     construction logic.
//
// Locked design decisions (per COMPONENT_1_PREWORK.md and COMPONENT_2A_PREWORK.md):
//   - A1: OpenAI-compatible only for v1.0
//   - B1: JSON-in-prompt for tool calls is the DOMAIN convention (no native
//         tool-call branch in user-facing flows). Component 2A relaxes this
//         specifically for INTERNAL ReAct loops (planAgent,
//         runAgenticExploration) — see chatCompletion() below.
//   - C1: SSE streaming required (every Provider must implement streamCompletion)
//   - D1: Single provider/model per session (factory returns one Provider)

import type { JsonSchema } from './jsonSchemas';

/**
 * One message in a chat completion request. Matches OpenAI's wire
 * shape; future providers translate to/from this canonical form.
 *
 * Stays narrow on purpose — only system/user/assistant text. The
 * tool-using methods (`chatCompletion` introduced in Component 2A)
 * accept a wider `ChatMessage` union that includes `ToolMessage` and
 * the structured `AssistantMessage` (with optional `tool_calls`).
 *
 * Existing callers of `streamCompletion`, `completion`, `jsonCompletion`
 * continue to use this narrow type — no migration churn for the 8
 * call sites already on Provider.
 */
export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * A tool call the model wants the host to execute. Shape mirrors the
 * OpenAI wire format exactly (Q3 lock — no canonicalization for v1.0).
 *
 * `arguments` is a JSON-encoded string (NOT a parsed object). Callers
 * that need the parsed args do `JSON.parse(toolCall.function.arguments)`.
 * This shape is what comes off the wire; preserving it as-is means
 * future MindIE/Anthropic providers translate to this shape, not a
 * canonical Nexus shape.
 */
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        /** JSON-encoded string of the tool arguments. */
        arguments: string;
    };
}

/**
 * The full assistant message, including optional tool_calls.
 *
 * `content` is `string | null` — null when the model returned ONLY
 * tool_calls and no accompanying text. Don't normalize null to empty
 * string; the null carries meaning ("model deliberately produced no
 * text"). Callers wanting a string default via `content ?? ''`.
 *
 * V2.0: `reasoning_content` carries the model's chain-of-thought when
 * the endpoint is a thinking-mode model (Qwen 3.6, DeepSeek R1, etc.).
 * MUST be passed back into subsequent requests as part of the messages
 * array for Thinking Preservation to work — Qwen issue #26 documented
 * that dropping `reasoning_content` from history causes reasoning to
 * leak into `content` on the next turn (visible `</think>` tags). Our
 * Provider layer normalizes the field; the agent loop's
 * `messages.push(aiMessage)` carries it forward via standard
 * JSON.stringify behavior.
 *
 * Returned from `chatCompletion()` — Component 2A's new method.
 */
export interface AssistantMessage {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
    /**
     * Model's chain-of-thought (Qwen 3.6 / DeepSeek R1 / etc.) when
     * the endpoint runs in thinking mode. Optional — non-thinking
     * models and older endpoints never set it.
     *
     * Whether or not callers display this field, it MUST be preserved
     * across conversation turns — see the docstring above.
     */
    reasoning_content?: string;
}

/**
 * Tool result message. Sent back to the model after executing a tool
 * the model requested. The `tool_call_id` MUST match the `id` of one
 * of the `tool_calls` in the immediately-prior assistant message.
 *
 * Content is plain string. Encoding richer payloads (file contents,
 * structured tables) is deferred to Component 2B — for 2A, all tool
 * results are stringified (which is fine for read_file output and
 * directory listings).
 */
export interface ToolMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
}

/**
 * Union covering ALL message shapes that may appear in a tool-using
 * chat completion request. `chatCompletion()` accepts arrays of this.
 *
 * Why a union instead of widening `Message`: only `chatCompletion`
 * callers need to handle the wider shape. Keeping `Message` narrow
 * means the existing 8 call sites of `streamCompletion / completion /
 * jsonCompletion` don't have to change to accommodate a feature they
 * don't use.
 */
export type ChatMessage = Message | AssistantMessage | ToolMessage;

/**
 * OpenAI tool definition shape. Q3 lock: keep the OpenAI shape
 * unchanged. `agentToolDefinitions` in `src/agentTools.ts` already
 * uses this shape; passing it directly avoids any migration churn.
 *
 * Future providers that don't speak OpenAI natively (MindIE, Anthropic)
 * accept this shape and translate to their wire format internally.
 */
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/**
 * Tool selection mode. Mirrors OpenAI's tool_choice parameter.
 *
 *   - 'auto'     — model decides whether to call tools (most common)
 *   - 'none'     — force model to not call tools
 *   - 'required' — force model to call at least one tool
 *   - { type: 'function', function: { name } } — force model to call
 *     a specific tool by name
 */
export type ToolChoice =
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } };

/**
 * Per-call options. Each is optional and providers must apply sensible
 * defaults when absent. None of these correspond to provider-specific
 * features — they're the common subset across OpenAI-compatible servers.
 */
export interface CompletionOptions {
    /** Sampling temperature. 0 = deterministic, 1 = creative. */
    temperature?: number;
    /** Maximum tokens in the completion. */
    maxTokens?: number;
    /** Caller-controlled abort signal. Provider must honor it. */
    signal?: AbortSignal;
    /**
     * Optional logger for retry/rate-limit messages. Used by Coordinator
     * to surface "API hiccup, retrying..." to the user. If absent the
     * provider logs to the extension's logger silently.
     */
    onRetryLog?: (message: string) => void;
    /**
     * Optional callback for token-usage metadata. OpenAI-compatible
     * streaming responses include a final `usage` payload (when the
     * server is configured for it via `stream_options.include_usage`).
     * Provider implementations that surface usage data invoke this
     * callback once the metadata arrives. Most callers don't need it;
     * the Coordinator uses it to track per-task token budgets.
     *
     * Shape is provider-specific (not normalized to a canonical form
     * yet) — typically `{ prompt_tokens, completion_tokens, total_tokens }`
     * for OpenAI-compatible servers. Callers that consume this should
     * tolerate missing fields.
     */
    onUsage?: (usage: Record<string, unknown>) => void;
    /**
     * Tool definitions the model may call. Component 2A. When provided,
     * `chatCompletion` includes these in the request body so the model
     * can emit `tool_calls` in its response.
     *
     * Only meaningful for `chatCompletion`. Passing tools to
     * `streamCompletion` / `completion` / `jsonCompletion` is silently
     * ignored — those methods don't return structured tool calls.
     *
     * If the endpoint doesn't support tool-calling, `chatCompletion`
     * uses a probe-and-cache mechanism (Q4c) to detect this and falls
     * back gracefully — the request is retried without tools and the
     * model produces a degraded but functional response.
     */
    tools?: ToolDefinition[];
    /**
     * Tool selection mode (Component 2A). Mirrors OpenAI's tool_choice.
     * Defaults to 'auto' when tools are provided. Ignored when tools
     * is absent or empty.
     */
    toolChoice?: ToolChoice;
    /**
     * V2.0: enable thinking mode on Qwen 3.6 / DeepSeek R1 / similar.
     * Routed via `extra_body.chat_template_kwargs.enable_thinking` in
     * the request body when set; non-Qwen endpoints ignore the field
     * (it sits inside `extra_body` which is opaque to OpenAI's spec).
     *
     * When undefined, no `enable_thinking` flag is emitted — the
     * endpoint's default applies (Qwen 3.6 defaults to `true`, older
     * models ignore the flag entirely).
     */
    enableThinking?: boolean;
    /**
     * V2.0: enable Thinking Preservation on Qwen 3.6. Routed via
     * `extra_body.chat_template_kwargs.preserve_thinking`. When true,
     * the inference server keeps reasoning context across turns —
     * critical for long autonomous sessions because it (a) reduces
     * redundant reasoning on every turn, (b) improves KV cache reuse,
     * (c) gives the agent consistency across multi-step tool loops.
     *
     * REQUIRES that callers pass `reasoning_content` from previous
     * AssistantMessage responses back into the messages array. The
     * Provider layer surfaces `reasoning_content` on AssistantMessage
     * (see Provider.ts); the agent loop's `messages.push(aiMessage)`
     * pattern carries it forward automatically.
     */
    preserveThinking?: boolean;
    /**
     * V2.0: nucleus sampling cutoff. Qwen 3.6 thinking mode wants
     * top_p=0.95; non-thinking wants 0.8. Older callers can ignore.
     */
    topP?: number;
    /**
     * V2.0: top-k sampling. Qwen 3.6 recommends top_k=20 in thinking
     * mode. Routed via `extra_body.top_k` because it's not in the
     * OpenAI spec.
     */
    topK?: number;
    /**
     * V2.0: presence penalty. Qwen 3.6 recommends 0.0 in thinking
     * mode and 1.5 in non-thinking mode (the latter prevents
     * repetitive output on shorter answers).
     */
    presencePenalty?: number;
}

/**
 * Token-by-token streaming result. Yields incremental text chunks
 * as they arrive over SSE. Iteration completes when the provider
 * signals end-of-stream.
 *
 * Errors mid-stream throw from the iterator's `next()` — callers
 * who care about partial output should accumulate as they go and
 * inspect the accumulator in catch blocks.
 */
export type CompletionStream = AsyncIterable<string>;

// ─── Streaming tool-call types (Component 2B-1, Q7=7B) ──────────────

/**
 * One delta yielded by `streamChatCompletion`. The iterator interleaves
 * text chunks (model thinking out loud) with completed tool calls.
 *
 * Why two delta kinds and not three (started/output/completed):
 * the Provider's job is to translate the wire format into a clean
 * stream. OpenAI's wire format streams tool-call args one JSON
 * fragment at a time; the Provider accumulates fragments internally
 * and yields a `tool_call` delta ONLY when the call is syntactically
 * complete (function name known + arguments parseable as JSON, or
 * finish_reason='tool_calls' arrived).
 *
 * This means callers (the Coordinator's ReAct loop) see:
 *   - `text` deltas as the model produces visible reasoning
 *   - `tool_call` deltas as fully-formed tool requests
 * and never have to worry about partial JSON args.
 *
 * The lifecycle events in `src/agents/toolProtocol.ts` (started/
 * output/completed) are a SEPARATE concern at the agent layer —
 * those wrap actual TOOL EXECUTION (when the host runs the tool),
 * not LLM output. Two distinct streams:
 *
 *   LLM wire → Provider → ChatCompletionDelta stream (this file)
 *   Tool execution → Coordinator → ToolLifecycleEvent stream (toolProtocol.ts)
 */
export type ChatCompletionDelta =
    | { kind: 'text'; content: string }
    | { kind: 'tool_call'; toolCall: ToolCall }
    | { kind: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string };

/**
 * Async iterable of completion deltas. Iteration completes when the
 * provider signals end-of-stream (after a `finish` delta).
 *
 * The final `finish` delta is always yielded — callers can use it
 * to distinguish "model stopped naturally" from "model got cut off
 * by token limit." For most callers, the `finish` delta is just a
 * signal that the stream is wrapping up; they accumulate text +
 * tool calls and don't need to inspect `reason` directly.
 */
export type ChatCompletionStream = AsyncIterable<ChatCompletionDelta>;

/**
 * The Provider contract.
 *
 * Implementations must be safe to share across the entire process —
 * the factory returns a singleton and call sites use it concurrently.
 * Per-call state lives in the call's local variables (or in the
 * AbortSignal); the Provider object itself holds only configuration.
 */
export interface Provider {
    /** Human-readable provider name. Used in logs and audit records. */
    readonly name: string;

    /** The endpoint URL the provider is configured to talk to. */
    readonly endpoint: string;

    /** The model the provider is configured to request. */
    readonly model: string;

    /**
     * Streaming chat completion.
     *
     * Returns an async iterable that yields text chunks as they arrive.
     * The full assistant response is the concatenation of all yielded
     * chunks. Implementations MUST honor `options.signal` — when aborted,
     * the iterator stops yielding and throws an AbortError on next pull.
     *
     * Concurrent calls on the same Provider are safe — each gets its
     * own underlying fetch + reader.
     */
    streamCompletion(
        messages: Message[],
        options?: CompletionOptions
    ): Promise<CompletionStream>;

    /**
     * Non-streaming chat completion. Resolves with the full text
     * response once the provider returns it.
     *
     * Implemented as a convenience over `streamCompletion` for callers
     * that want the whole response at once. Concrete providers may
     * optimize by setting `stream: false` on the wire if useful.
     */
    completion(
        messages: Message[],
        options?: CompletionOptions
    ): Promise<string>;

    /**
     * JSON-mode completion. The model is instructed to return JSON
     * matching the optional schema; the response is parsed and returned
     * as the typed value.
     *
     * Implementations should:
     *   - Probe endpoint capability for `response_format: json_schema`
     *     and use it when supported (constrains decode-time output).
     *   - Fall back to `json_object` mode + tolerant parsing when not.
     *   - Throw a clear error if the response can't be coerced to JSON,
     *     after a reasonable number of fallback attempts.
     *
     * The current code already has `jsonRequest` doing exactly this;
     * the OpenAICompatibleProvider wraps it as `jsonCompletion`.
     */
    jsonCompletion<T>(
        messages: Message[],
        schema?: JsonSchema,
        options?: CompletionOptions
    ): Promise<T>;

    /**
     * Tool-using non-streaming chat completion (Component 2A).
     *
     * Sends a chat completion request with optional `tools` available
     * to the model. Returns the full assistant message — the only
     * Provider method that returns the structured `AssistantMessage`
     * shape rather than a string or typed value.
     *
     * Use cases:
     *   - Internal ReAct loops (planAgent, runAgenticExploration)
     *     where the agent needs the model to invoke `read_file`,
     *     `list_directory`, etc. before producing a final answer.
     *   - Future Coordinator paths that want native tool-calling
     *     instead of parsing SEARCH/REPLACE blocks (deferred to 2B).
     *
     * Accepts the wider `ChatMessage[]` shape so callers can include
     * prior `AssistantMessage` (with tool_calls) and `ToolMessage`
     * (with tool_call_id) in the conversation history. The narrow
     * `Message[]` from existing methods is a subset and works too.
     *
     * Capability handling: when `options.tools` is present, the
     * provider probes the endpoint once per session and caches the
     * result. Tool-incapable endpoints get a fallback path: the
     * request is retried without `tools`, and the response carries
     * `content` only (no `tool_calls`). The caller's ReAct loop
     * sees this as "the model didn't call any tools" and proceeds
     * to use the text response directly.
     *
     * Non-streaming: returns once the full response arrives. For
     * streaming tool-call deltas (live arg display, output streaming),
     * use `streamChatCompletion` (Component 2B-1).
     */
    chatCompletion(
        messages: ChatMessage[],
        options?: CompletionOptions
    ): Promise<AssistantMessage>;

    /**
     * Tool-using STREAMING chat completion (Component 2B-1, Q7=7B).
     *
     * Yields a stream of `ChatCompletionDelta` values:
     *   - `text` deltas as the model emits visible content
     *   - `tool_call` deltas as the model emits complete tool calls
     *   - one final `finish` delta when the response ends
     *
     * The Provider handles all the wire-format complexity of OpenAI's
     * streaming tool-call protocol — partial argument JSON, indexed
     * tool calls, finish reasons. Callers see clean deltas, never
     * partial JSON.
     *
     * Capability handling: same as `chatCompletion`. The endpoint
     * probe is shared across both methods (one cache keyed on URL).
     * Tool-incapable endpoints get a fallback to a tool-free streaming
     * request — the resulting stream contains only `text` deltas and
     * a final `finish`.
     *
     * Abort handling: `options.signal` propagates through the SSE
     * reader. Aborted streams throw an `AbortError` from the next
     * iterator pull. Partial tool calls accumulated up to the abort
     * point are NOT yielded — only complete tool calls reach the
     * caller.
     *
     * Concurrent calls on the same Provider are safe.
     */
    streamChatCompletion(
        messages: ChatMessage[],
        options?: CompletionOptions
    ): Promise<ChatCompletionStream>;

    /**
     * List available models. Many providers don't expose this (vLLM
     * serves a single configured model; LM Studio loads one at a time);
     * for those the implementation returns `[this.model]`.
     *
     * Used by the IDE settings UI for autocompleting the `model` field.
     */
    listModels(): Promise<string[]>;
}