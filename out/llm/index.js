"use strict";
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
//
// C1 (per-agent model routing) note:
//   getProvider accepts an AgentRole. When set, the role is passed to
//   getLLMConfig which resolves the role-specific model identifier
//   (nexuscode.modelPlanner / modelCoder / modelVerifier) with fallback
//   to the global nexuscode.model. The cache key includes the role so
//   different roles get distinct cached provider instances.
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetToolCapabilityCache = exports.setToolCapability = exports.OpenAICompatibleProvider = void 0;
exports.getProvider = getProvider;
exports.resetProviderCache = resetProviderCache;
const llmService_1 = require("../llmService");
const OpenAICompatibleProvider_1 = require("./OpenAICompatibleProvider");
var OpenAICompatibleProvider_2 = require("./OpenAICompatibleProvider");
Object.defineProperty(exports, "OpenAICompatibleProvider", { enumerable: true, get: function () { return OpenAICompatibleProvider_2.OpenAICompatibleProvider; } });
Object.defineProperty(exports, "setToolCapability", { enumerable: true, get: function () { return OpenAICompatibleProvider_2.setToolCapability; } });
Object.defineProperty(exports, "resetToolCapabilityCache", { enumerable: true, get: function () { return OpenAICompatibleProvider_2.resetToolCapabilityCache; } });
/**
 * Cached provider instances, keyed by role + the concatenation of
 * config fields that affect provider identity. When the user changes
 * `nexuscode.model` or any per-role model, the next `getProvider()`
 * call detects the cache key mismatch and constructs a fresh provider.
 *
 * Why a Map instead of a single var: per-agent model routing means
 * we may have up to 4 distinct providers in the cache simultaneously
 * (one per role). The map is small and lookups are O(1).
 *
 * The cache key deliberately excludes the apiKey — rotating keys
 * shouldn't force a new provider object since the auth header is
 * computed per-request via `authHeaders`. (This will matter once we
 * stop reading apiKey out of `LLMConfig` directly. For now the
 * provider stores apiKey at construction time, so rotating the key
 * means stale auth — flagged for Session 2 cleanup.)
 */
const _providerCache = new Map();
/**
 * Return the configured Provider for a given agent role. Constructs
 * and caches on first call per (role, config-key) pair; returns the
 * cached instance on subsequent calls if config hasn't changed.
 *
 * Without a role argument, returns the default provider (uses the
 * global `nexuscode.model`). Equivalent to pre-routing behavior.
 *
 * This is async because `getLLMConfig` is async (it reads
 * SecretStorage for the apiKey). Once cached, repeat calls still pay
 * one config-read on each call to detect changes — that's by design
 * and cheap enough.
 */
async function getProvider(role = 'default') {
    const cfg = await (0, llmService_1.getLLMConfig)(role);
    const key = `${role}|${cfg.endpoint}|${cfg.model}`;
    const cached = _providerCache.get(key);
    if (cached) {
        return cached;
    }
    // For v1.0 only one provider shape. Adding a switch here is the
    // extension point for v1.1+ when MindIEProvider etc. arrive.
    const providerCfg = {
        endpoint: cfg.endpoint,
        model: cfg.model
    };
    if (cfg.apiKey !== undefined)
        providerCfg.apiKey = cfg.apiKey;
    const provider = new OpenAICompatibleProvider_1.OpenAICompatibleProvider(providerCfg);
    _providerCache.set(key, provider);
    return provider;
}
/**
 * Reset the cached providers. Used by tests that need to force re-
 * construction with different config, or by the IDE if a settings-
 * change event indicates the user updated any model/endpoint.
 *
 * Production code shouldn't normally need to call this — `getProvider`
 * detects config changes via the cache key.
 */
function resetProviderCache() {
    _providerCache.clear();
}
//# sourceMappingURL=index.js.map