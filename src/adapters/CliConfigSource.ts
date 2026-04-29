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

import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigSource } from '../container';

/**
 * Mapping from `nexuscode.*` config key (the namespace getLLMConfig uses)
 * to the corresponding CLI input source.
 *
 * The "primary" name is what's used in flags and the JSON file. The "env"
 * name is what's read from process.env. We split the two because env-var
 * conventions differ from config-key conventions (UPPER_SNAKE_CASE vs camelCase).
 */
interface KeyMapping {
    /** flag/file key, e.g. "apiEndpoint" */
    primary: string;
    /** env var name, e.g. "NEXUSCODE_API_ENDPOINT" */
    env?: string;
    /** Whether to coerce the value to a number. Default: keep as string/boolean. */
    coerce?: 'number' | 'boolean';
}

/**
 * The keys getLLMConfig actually reads. If you add a new config key in
 * llmService.ts, add a mapping here too — otherwise the CLI will silently
 * see `undefined` for that key.
 */
const KEY_MAPPINGS: Record<string, KeyMapping> = {
    apiEndpoint: { primary: 'endpoint',  env: 'NEXUSCODE_API_ENDPOINT' },
    model:       { primary: 'model',     env: 'NEXUSCODE_MODEL' },
    apiKey:      { primary: 'apiKey',    env: 'NEXUSCODE_API_KEY' },
    enableTools: { primary: 'enableTools', env: 'NEXUSCODE_ENABLE_TOOLS', coerce: 'boolean' },
    maxTokens:   { primary: 'maxTokens', env: 'NEXUSCODE_MAX_TOKENS',     coerce: 'number' }
};

/**
 * Construction args for `CliConfigSource`. The CLI passes already-merged
 * flag values + the discovered file contents; the source just resolves
 * key lookups against those plus `process.env`.
 *
 * Why pre-merged: keeping the flag-parsing in cli.ts (which knows about
 * commander's argument shape) is cleaner than coupling this adapter to
 * the parser. The adapter only needs to know about config KEYS, not how
 * they were collected.
 */
export interface CliConfigInputs {
    /** Already-parsed CLI flags (from `commander`). Top priority. */
    flags: Record<string, unknown>;
    /** Parsed `.nexus/cli.json`. Lowest priority. May be empty `{}`. */
    file: Record<string, unknown>;
}

export class CliConfigSource implements ConfigSource {
    constructor(private readonly inputs: CliConfigInputs) {}

    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const mapping = KEY_MAPPINGS[key];

        // Unmapped key: behave like an absent setting. Don't blow up — many
        // callers ask for keys this CLI doesn't care about.
        if (!mapping) {
            return defaultValue;
        }

        // Layer 1: flags (highest priority)
        const fromFlags = this.inputs.flags[mapping.primary];
        if (fromFlags !== undefined && fromFlags !== null) {
            return coerce<T>(fromFlags, mapping.coerce);
        }

        // Layer 2: env vars
        if (mapping.env) {
            const fromEnv = process.env[mapping.env];
            if (fromEnv !== undefined && fromEnv !== '') {
                return coerce<T>(fromEnv, mapping.coerce);
            }
        }

        // Layer 3: file
        const fromFile = this.inputs.file[mapping.primary];
        if (fromFile !== undefined && fromFile !== null) {
            return coerce<T>(fromFile, mapping.coerce);
        }

        return defaultValue;
    }

    // NOTE: `update` is intentionally not implemented. See file header.
}

/**
 * Coerce a raw config value to the requested target type. Values from
 * env vars are always strings, so we have to convert them; values from
 * flags or the JSON file may already be the right type.
 */
function coerce<T>(value: unknown, target: KeyMapping['coerce']): T {
    if (target === 'number') {
        const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
        return (Number.isNaN(n) ? undefined : n) as T;
    }
    if (target === 'boolean') {
        if (typeof value === 'boolean') return value as T;
        const s = String(value).toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') return true as T;
        if (s === 'false' || s === '0' || s === 'no') return false as T;
        return undefined as T;
    }
    return value as T;
}

/**
 * Convenience: load `.nexus/cli.json` from a workspace root, returning
 * an empty object if missing or malformed. Non-fatal — config layering
 * just falls through to env/defaults.
 */
export async function loadCliJson(workspaceRoot: string): Promise<Record<string, unknown>> {
    const cliJsonPath = path.join(workspaceRoot, '.nexus', 'cli.json');
    try {
        const raw = await fs.readFile(cliJsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return {};
    } catch {
        return {};
    }
}