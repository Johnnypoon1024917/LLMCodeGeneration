"use strict";
// src/adapters/CliConfigSource.ts
//
// `ConfigSource` implementation for the CLI runtime.
//
// What it reads:
//   Flags > env vars > .nexus/cli.json    (highest priority first)
//
// Why each layer exists:
//   - Flags: explicit per-invocation override. `nexuscode chat -m other-model`
//     should beat anything else.
//   - Env vars: standard CI override pattern. `NEXUSCODE_API_KEY` from a
//     vault-mounted env in CI, without committing it anywhere.
//   - File: project-level defaults that get checked in alongside the code,
//     so `nexuscode chat` "just works" inside a configured project.
//
// What it does NOT support:
//   - `update()` is intentionally NOT implemented. The CLI has no obvious
//     place to write config back to (which file? user-global? project?).
//     Callers that need to update — like the legacy api-key migration in
//     `getLLMConfig` — must handle the missing-update case (`config.update`
//     is `undefined`, so they short-circuit).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliConfigSource = void 0;
exports.loadCliJson = loadCliJson;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
/**
 * The keys getLLMConfig actually reads. If you add a new config key in
 * llmService.ts, add a mapping here too — otherwise the CLI will silently
 * see `undefined` for that key.
 */
const KEY_MAPPINGS = {
    apiEndpoint: { primary: 'endpoint', env: 'NEXUSCODE_API_ENDPOINT' },
    model: { primary: 'model', env: 'NEXUSCODE_MODEL' },
    apiKey: { primary: 'apiKey', env: 'NEXUSCODE_API_KEY' },
    enableTools: { primary: 'enableTools', env: 'NEXUSCODE_ENABLE_TOOLS', coerce: 'boolean' },
    maxTokens: { primary: 'maxTokens', env: 'NEXUSCODE_MAX_TOKENS', coerce: 'number' }
};
class CliConfigSource {
    inputs;
    constructor(inputs) {
        this.inputs = inputs;
    }
    get(key, defaultValue) {
        const mapping = KEY_MAPPINGS[key];
        // Unmapped key: behave like an absent setting. Don't blow up — many
        // callers ask for keys this CLI doesn't care about.
        if (!mapping) {
            return defaultValue;
        }
        // Layer 1: flags (highest priority)
        const fromFlags = this.inputs.flags[mapping.primary];
        if (fromFlags !== undefined && fromFlags !== null) {
            return coerce(fromFlags, mapping.coerce);
        }
        // Layer 2: env vars
        if (mapping.env) {
            const fromEnv = process.env[mapping.env];
            if (fromEnv !== undefined && fromEnv !== '') {
                return coerce(fromEnv, mapping.coerce);
            }
        }
        // Layer 3: file
        const fromFile = this.inputs.file[mapping.primary];
        if (fromFile !== undefined && fromFile !== null) {
            return coerce(fromFile, mapping.coerce);
        }
        return defaultValue;
    }
}
exports.CliConfigSource = CliConfigSource;
/**
 * Coerce a raw config value to the requested target type. Values from
 * env vars are always strings, so we have to convert them; values from
 * flags or the JSON file may already be the right type.
 */
function coerce(value, target) {
    if (target === 'number') {
        const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        return (Number.isNaN(n) ? undefined : n);
    }
    if (target === 'boolean') {
        if (typeof value === 'boolean')
            return value;
        const s = String(value).toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes')
            return true;
        if (s === 'false' || s === '0' || s === 'no')
            return false;
        return undefined;
    }
    return value;
}
/**
 * Convenience: load `.nexus/cli.json` from a workspace root, returning
 * an empty object if missing or malformed. Non-fatal — config layering
 * just falls through to env/defaults.
 */
async function loadCliJson(workspaceRoot) {
    const cliJsonPath = path.join(workspaceRoot, '.nexus', 'cli.json');
    try {
        const raw = await fs.readFile(cliJsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=CliConfigSource.js.map