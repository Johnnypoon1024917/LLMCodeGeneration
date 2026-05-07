// src/llm/jsonRequest.ts
//
// One-stop helper for JSON-mode LLM calls.
//
// What this replaces:
//   Before: every call site duplicated the fetch/parse/heal dance, with
//   a fragile 200-line state-machine healer (`safeParseJSON`) papering over
//   malformed model output. The healer worked but was opaque, slow on
//   large outputs, and produced silent corruptions when output drifted
//   too far from valid JSON.
//
//   Now: callers pass a JSON schema; we send `response_format: {type:
//   "json_schema", json_schema: {...}}` when the endpoint supports it,
//   constraining decode-time output so JSON literally cannot come back
//   malformed. On endpoints that don't support it we fall back to
//   `json_object` mode + the legacy healer — see probe logic below.
//
// Why probe-and-fallback:
//   The codebase targets multiple endpoints: OpenAI, vLLM, Ollama, LM
//   Studio. json_schema support landed in different versions: vLLM 0.6+,
//   LM Studio 0.3+, recent Ollama. Hard-requiring it would break older
//   installs. Probing once per endpoint and caching the result is a small
//   amount of code that buys universal compatibility.
//
// C1 (per-agent model routing) note:
//   `JsonRequestOptions.role` lets callers route the request to a role-
//   specific model (nexuscode.modelPlanner / modelCoder / modelVerifier)
//   with fallback to the global nexuscode.model. When omitted, behavior
//   matches pre-routing (uses the global default).

import { resilientFetch, getLLMConfig, authHeaders, safeParseJSON, truncateContextForChat, CHAT_CONTEXT_CHAR_BUDGET, type AgentRole } from '../llmService';
import { errorMessage } from '../utilities/errors';
import { EmptyCompletionError } from './errors';
import type { JsonSchema } from './jsonSchemas';
import { log } from '../logger';

/**
 * Capability cache keyed by endpoint URL. Avoids re-probing on every
 * request. The first call to `jsonRequest` against a new endpoint blocks
 * on the probe; subsequent calls reuse the cached result.
 *
 * Cache lifetime is the extension's lifetime — restarting VS Code re-probes,
 * which is desirable in case the user upgraded their inference server.
 *
 * Note: cache is keyed by endpoint, NOT by role+endpoint+model. Capability
 * (json_schema vs json_object support) is a property of the inference
 * server, not of a particular model — different roles routed to the same
 * endpoint share probe results. If per-role endpoints arrive in v1.1
 * (currently all roles share `nexuscode.apiEndpoint`), this cache key
 * may need to expand to include endpoint URL per role.
 */
const capabilityCache = new Map<string, EndpointCapabilities>();

interface EndpointCapabilities {
    /** Honors `response_format: { type: "json_schema" }` end-to-end. */
    jsonSchema: boolean;
    /** Honors `response_format: { type: "json_object" }` (most providers do). */
    jsonObject: boolean;
}

/**
 * Probe an endpoint for json_schema support.
 *
 * Sends a tiny test request with response_format: json_schema. If it returns
 * a valid response that parses against the test schema, json_schema is
 * supported. If we get an HTTP 400 (most common rejection mode for unknown
 * response_format types), or the body parses but has the wrong shape, we
 * fall back to json_object.
 *
 * The probe uses ~30 tokens of input + ~10 tokens of output. Cheap.
 */
async function probeCapabilities(
    endpoint: string,
    model: string,
    apiKey: string | undefined
): Promise<EndpointCapabilities> {
    const probeSchema = {
        name: "probe",
        strict: true,
        schema: {
            type: "object",
            additionalProperties: false,
            properties: { ok: { type: "boolean" } },
            required: ["ok"]
        }
    };

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: authHeaders(apiKey),
            body: JSON.stringify({
                model,
                messages: [
                    { role: "user", content: 'Reply with {"ok": true}' }
                ],
                temperature: 0,
                max_tokens: 20,
                response_format: {
                    type: "json_schema",
                    json_schema: probeSchema
                }
            })
        });

        if (response.ok) {
            const data = await response.json() as { choices?: { message?: { content?: string } }[] };
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content === 'string') {
                try {
                    const parsed = JSON.parse(content);
                    if (parsed && typeof parsed.ok === 'boolean') {
                        return { jsonSchema: true, jsonObject: true };
                    }
                } catch {
                    // body parsed via .json() but content not valid JSON — schema not honored
                }
            }
        }
    } catch (e: unknown) {
        // Network error or fetch threw — treat as "no schema support" rather than failing.
        log.warn(`[jsonRequest] Capability probe failed for ${endpoint}: ${errorMessage(e)}`);
    }

    // Schema unsupported. Assume json_object works (it's nearly universal among
    // OpenAI-compatible servers); the call site falls back to the healer either way.
    return { jsonSchema: false, jsonObject: true };
}

async function getCapabilities(
    endpoint: string,
    model: string,
    apiKey: string | undefined
): Promise<EndpointCapabilities> {
    const cached = capabilityCache.get(endpoint);
    if (cached) {
        return cached;
    }
    const probed = await probeCapabilities(endpoint, model, apiKey);
    capabilityCache.set(endpoint, probed);
    if (probed.jsonSchema) {
        log.info(`[jsonRequest] Endpoint ${endpoint} supports json_schema — using strict mode.`);
    } else {
        log.info(`[jsonRequest] Endpoint ${endpoint} does not support json_schema — falling back to json_object + healer.`);
    }
    return probed;
}

/** Resets the capability cache. Useful for tests or after the user changes endpoints. */
export function resetJsonRequestCache(): void {
    capabilityCache.clear();
}

export interface JsonRequestOptions {
    /** Messages array — same shape as the OpenAI chat API. */
    messages: { role: string; content: string }[];
    /** Schema describing the expected response shape. */
    schema: JsonSchema;
    /** Sampling temperature (default 0.1 for deterministic structured output). */
    temperature?: number;
    /** Optional max_tokens cap. */
    maxTokens?: number;
    /** Optional AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Optional log callback for streaming progress messages back to the UI. */
    logCallback?: (msg: string) => void;
    /**
     * Per-agent role for model routing (C1). When set, the request is
     * routed to the role-specific model (nexuscode.modelPlanner,
     * modelCoder, or modelVerifier) with fallback to the global
     * nexuscode.model. When omitted or 'default', uses the global model.
     *
     * Used by: verifyAgainstSpec → 'verifier'. Other JSON-mode call
     * sites can opt in as needed.
     */
    role?: AgentRole;
}

export interface JsonRequestResult<T> {
    data: T;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    /** Whether json_schema mode was used (for diagnostics). */
    schemaMode: boolean;
}

/**
 * Send a JSON-mode request to the configured LLM endpoint and return the
 * parsed result typed as T.
 *
 * Uses json_schema mode when the endpoint supports it (constrained decoding,
 * cannot return malformed JSON). Falls back to json_object mode + the legacy
 * healer for older endpoints.
 *
 * Throws if the response cannot be parsed even with the healer.
 */
export async function jsonRequest<T>(opts: JsonRequestOptions): Promise<JsonRequestResult<T>> {
    // C1: route to the role-specific model when opts.role is set.
    // Falls back to the global default ('default' role) otherwise.
    const { endpoint, model, apiKey } = await getLLMConfig(opts.role ?? 'default');
    const caps = await getCapabilities(endpoint, model, apiKey);

    // Build response_format. json_schema if supported, else json_object.
    const responseFormat = caps.jsonSchema
        ? {
            type: "json_schema",
            json_schema: {
                name: opts.schema.name,
                strict: opts.schema.strict ?? false,
                schema: opts.schema.schema
            }
        }
        : { type: "json_object" };

    // V2.1.2 fix: truncate any oversize message content before send.
    // PRD/Design/Tasks generation can attach long spec docs via `data.context`;
    // when that pushes prompt + history past Qwen 3.6's 32K window, the
    // endpoint silently returns 200 + empty content rather than 400. Without
    // this guard, jsonRequest then throws a confusing JSON-parse error
    // ("Unexpected end of JSON input") instead of something the user can act on.
    //
    // We mutate a copy of opts.messages — never the caller's array. The
    // truncation marker is visible to the model so it knows context was cut
    // (helps it produce honest "based on a partial view" answers instead of
    // confidently hallucinating).
    const truncatedMessages = opts.messages.map(msg => {
        if (typeof msg.content === 'string' && msg.content.length > CHAT_CONTEXT_CHAR_BUDGET) {
            return { ...msg, content: truncateContextForChat(msg.content) };
        }
        return msg;
    });

    const body: Record<string, unknown> = {
        model,
        messages: truncatedMessages,
        temperature: opts.temperature ?? 0.1,
        response_format: responseFormat
    };
    if (opts.maxTokens !== undefined) {
        body['max_tokens'] = opts.maxTokens;
    }

    const fetchOptions: RequestInit = {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify(body)
    };
    if (opts.signal) {
        fetchOptions.signal = opts.signal;
    }

    const response = await resilientFetch(endpoint, fetchOptions, opts.logCallback);

    if (!response.ok) {
        // Specific signal: the server rejected our response_format. Drop the cached
        // capability so the next request re-probes — handles upgrade/downgrade flips.
        if (response.status === 400 && caps.jsonSchema) {
            log.warn(`[jsonRequest] Endpoint ${endpoint} returned 400 on json_schema — invalidating cache.`);
            capabilityCache.delete(endpoint);
        }
        const errorText = await response.text().catch(() => "(no body)");
        throw new Error(`LLM endpoint ${response.status}: ${errorText.substring(0, 500)}`);
    }

    const data = await response.json() as {
        error?: { message: string },
        choices: { message: { content: string } }[],
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    };

    if (data.error) {
        throw new Error(data.error.message);
    }

    const firstChoice = data.choices[0];
    if (firstChoice === undefined) {
        throw new Error("LLM response missing choices");
    }
    const content = firstChoice.message.content;

    // V2.1.2 fix: detect empty completion BEFORE parsing. Qwen 3.6 27B
    // at the lab endpoint (32K context cap) returns 200 OK + empty
    // content on context overflow rather than a clean 400. Without this
    // check, the JSON.parse below throws "Unexpected end of JSON input"
    // and bubbles up as a confusing error in the spec UI. Throwing the
    // shared EmptyCompletionError lets the SidebarProvider catch handler
    // show a meaningful message ("prompt too long, attach fewer docs")
    // instead of a parser stack trace.
    if (typeof content !== 'string' || content.length === 0) {
        throw new EmptyCompletionError(
            'The LLM returned an empty response. This usually means the prompt + attached context exceeded the model\'s context window, ' +
            'or the model declined to answer for safety reasons. Try a shorter prompt, fewer attached files, or breaking the request into smaller parts.'
        );
    }

    let parsed: T;
    if (caps.jsonSchema) {
        // In schema mode the content MUST be valid JSON matching the schema.
        // Parse directly; any failure is a real bug in either the endpoint or
        // the schema, and we want it to surface, not get healed silently.
        try {
            parsed = JSON.parse(content) as T;
        } catch (e: unknown) {
            throw new Error(
                `Endpoint ${endpoint} claimed json_schema support but returned non-JSON: ${errorMessage(e)}.\n` +
                `Content (first 500 chars): ${content.substring(0, 500)}`
            );
        }
    } else {
        // Fallback: legacy healer. Same behavior as the old code paths.
        parsed = safeParseJSON<T>(content);
    }

    const result: JsonRequestResult<T> = {
        data: parsed,
        schemaMode: caps.jsonSchema
    };
    if (data.usage) {
        result.usage = data.usage;
    }
    return result;
}

/**
 * Convenience: same as jsonRequest but returns just the data, dropping usage
 * metadata. For call sites that don't care about token tracking.
 */
export async function jsonRequestData<T>(opts: JsonRequestOptions): Promise<T> {
    const result = await jsonRequest<T>(opts);
    return result.data;
}