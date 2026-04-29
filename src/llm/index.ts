// src/llm/index.ts
//
// Provider factory and barrel exports.
//
// `getProvider()` is the single entry point for getting an LLM provider.
// It reads `LLMConfig` (via `llmService.getLLMConfig`) and returns the
// provider implementation matching the configured shape.
//
// For v1.0 the only shape is OpenAI-compatible — there's no `provider`
// config key to switch on. Future v1.1+ work adds a discriminator:
//
//   if (config.provider === 'mindie') return new MindIEProvider(...)
//
// at which point this file gets a small switch statement.
//
// Caching: providers are stateless modulo their config, but constructing
// one is non-trivial (config read, secret retrieval). We cache the
// returned Provider keyed by its config triple and invalidate when the
// underlying config changes. The cache lives for the process lifetime.

import { getLLMConfig } from '../llmService';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import type { Provider } from './Provider';

export type {
    Provider,
    Message,
    ChatMessage,
    AssistantMessage,
    ToolCall,
    ToolMessage,
    ToolDefinition,
    ToolChoice,
    ChatCompletionDelta,
    ChatCompletionStream,
    CompletionOptions,
    CompletionStream
} from './Provider';
export {
    OpenAICompatibleProvider,
    setToolCapability,
    resetToolCapabilityCache
} from './OpenAICompatibleProvider';

/**
 * Cached provider instance. Keyed by the concatenation of config fields
 * that affect provider identity. When the user changes `nexuscode.model`
 * in settings, the next `getProvider()` call detects the cache key
 * mismatch and constructs a fresh provider.
 *
 * The cache key deliberately excludes the apiKey — rotating keys
 * shouldn't force a new provider object since the auth header is
 * computed per-request via `authHeaders`. (This will matter once we
 * stop reading apiKey out of `LLMConfig` directly. For now the
 * provider stores apiKey at construction time, so rotating the key
 * means stale auth — flagged for Session 2 cleanup.)
 */
let _cachedProvider: Provider | undefined;
let _cachedKey: string | undefined;

/**
 * Return the configured Provider. Constructs and caches on first call;
 * returns the cached instance on subsequent calls if config hasn't
 * changed.
 *
 * This is async because `getLLMConfig` is async (it reads SecretStorage
 * for the apiKey). Once provider is cached, repeat calls still pay one
 * config-read on each call to detect changes — that's by design and
 * cheap enough.
 */
export async function getProvider(): Promise<Provider> {
    const cfg = await getLLMConfig();
    const key = `${cfg.endpoint}|${cfg.model}`;

    if (_cachedProvider && _cachedKey === key) {
        return _cachedProvider;
    }

    // For v1.0 only one provider shape. Adding a switch here is the
    // extension point for v1.1+ when MindIEProvider etc. arrive.
    const providerCfg: { endpoint: string; model: string; apiKey?: string } = {
        endpoint: cfg.endpoint,
        model: cfg.model
    };
    if (cfg.apiKey !== undefined) providerCfg.apiKey = cfg.apiKey;
    const provider = new OpenAICompatibleProvider(providerCfg);

    _cachedProvider = provider;
    _cachedKey = key;
    return provider;
}

/**
 * Reset the cached provider. Used by tests that need to force re-
 * construction with different config, or by the IDE if a settings-change
 * event indicates the user updated the model/endpoint.
 *
 * Production code shouldn't normally need to call this — `getProvider`
 * detects config changes via the cache key.
 */
export function resetProviderCache(): void {
    _cachedProvider = undefined;
    _cachedKey = undefined;
}