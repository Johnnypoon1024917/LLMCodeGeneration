// src/mcp/mcpConfig.ts
//
// PR P2.1: typed config schema for `.nexus/mcp-servers.json`.
//
// Shape mirrors Kiro's `.kiro/mcp.json` for portability — a project
// configured for Kiro can drop the same file at `.nexus/mcp-servers.json`
// (or vice versa) and most server entries Just Work.
//
// What this module does:
//   - Defines the runtime types (McpServerEntry, McpConfig)
//   - Exports a parseMcpConfig that turns raw JSON into a validated
//     McpConfig OR a structured McpConfigError describing what's wrong
//   - Exports envExpand for the limited variable substitution we
//     support in env values
//
// What this module does NOT do:
//   - FS reads (handled by McpManager — keeps this file pure for tests)
//   - Spawning processes / network / SDK lifecycle — see TODO(MCP-CLIENT)
//     in mcpManager.ts
//
// Design choices:
//   - Disabled servers are still parsed (they show in the UI, just
//     don't connect). This matches Kiro behavior — users can toggle
//     servers without deleting the entry.
//   - env supports a single substitution: `${env:VARNAME}` expands
//     from process.env. We do NOT support arbitrary shell expansion
//     because that's a security footgun, and Kiro doesn't either.

/** P2.1: one entry in the mcpServers map.
 *
 *  Tagged union: stdio servers (existing) spawn a subprocess; HTTP
 *  servers (P2.1 streamable-http extension, 2026-05) connect to a
 *  remote URL using the MCP Streamable HTTP transport.
 *
 *  Existing config files (with only `command` + `args` + `env`) parse
 *  cleanly into the stdio variant — the `transport` discriminator
 *  defaults to 'stdio' when only those fields are present. Authors
 *  opt into HTTP by setting `url` instead of `command`.
 */
export type McpServerEntry = McpStdioServerEntry | McpHttpServerEntry;

/** Stdio-transport server: NexusCode spawns a subprocess and speaks
 *  JSON-RPC over its stdin/stdout. The original P2.1 shape. */
export interface McpStdioServerEntry {
    transport: 'stdio';
    /** The server's identifier — the map key. */
    id: string;
    /** Executable to spawn (`npx`, `python`, `/usr/bin/myserver`). */
    command: string;
    /** Args passed to the executable. May be empty. */
    args: string[];
    /** Environment variables for the spawned process. May be empty.
     *  Values support `${env:NAME}` substitution; see envExpand. */
    env: Record<string, string>;
    /** When true, the manager records the entry but does NOT attempt
     *  to connect. Useful for keeping a server config around without
     *  paying its startup cost on every session. */
    disabled: boolean;
    /** Optional human-friendly description shown in the UI. */
    description?: string;
}

/** Streamable HTTP-transport server (P2.1 extension, 2026-05): the
 *  MCP server runs remotely; we connect via a single HTTPS endpoint
 *  using the Streamable HTTP transport from the official SDK.
 *
 *  Headers field is for static authentication (Bearer tokens, API
 *  keys). Full OAuth 2.1 is NOT implemented this turn — for OAuth
 *  servers, use a stdio MCP proxy that handles the auth flow locally.
 *  The roadmap defers OAuth to a follow-on bundle. */
export interface McpHttpServerEntry {
    transport: 'http';
    id: string;
    /** HTTP(S) URL of the MCP server. Must include scheme + host;
     *  port and path optional. */
    url: string;
    /** Static headers sent on every request. Useful for Bearer
     *  tokens / API keys. Values support `${env:VAR}` substitution
     *  (same as stdio's env field) so secrets don't have to live in
     *  the committed JSON. */
    headers: Record<string, string>;
    disabled: boolean;
    description?: string;
}

/** P2.1: validated MCP configuration. */
export interface McpConfig {
    servers: McpServerEntry[];
}

/** P2.1: a structured error describing why config parsing failed.
 *  More useful than a raw string because the UI wants to surface the
 *  failure cause, optionally with the offending server id. */
export interface McpConfigError {
    code: 'invalid_json' | 'wrong_shape' | 'invalid_server_entry';
    message: string;
    /** When code === 'invalid_server_entry', this is the offending
     *  server's id (so the UI can highlight it). */
    serverId?: string;
}

/**
 * Parse a raw config string into a validated McpConfig OR a structured
 * error. Pure function — caller (typically McpManager) handles the FS.
 *
 * Empty / missing input is a valid config with zero servers. The
 * caller treats that as "no MCP configured" and the manager simply
 * doesn't attempt any connections.
 */
export function parseMcpConfig(raw: string): McpConfig | McpConfigError {
    if (raw.trim() === '') { return { servers: [] }; }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            code: 'invalid_json',
            message: `Failed to parse mcp-servers.json: ${e instanceof Error ? e.message : String(e)}`
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            code: 'wrong_shape',
            message: 'Config root must be a JSON object with an `mcpServers` field'
        };
    }

    const root = parsed as Record<string, unknown>;
    // Permissive: missing mcpServers field = empty config (no servers).
    // Some users may keep the file as a placeholder with `{}`.
    if (!('mcpServers' in root) || root['mcpServers'] === undefined) {
        return { servers: [] };
    }

    if (!root['mcpServers'] || typeof root['mcpServers'] !== 'object' || Array.isArray(root['mcpServers'])) {
        return {
            code: 'wrong_shape',
            message: '`mcpServers` must be an object keyed by server id'
        };
    }

    const servers: McpServerEntry[] = [];
    const mcpServersMap = root['mcpServers'] as Record<string, unknown>;
    for (const [id, raw] of Object.entries(mcpServersMap)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {
                code: 'invalid_server_entry',
                serverId: id,
                message: `Server '${id}' entry must be a JSON object`
            };
        }
        const entry = raw as Record<string, unknown>;

        // P2.1 streamable-http extension (2026-05): detect transport.
        // - `url` field present → HTTP transport
        // - `command` field present → stdio transport
        // - both or neither → ambiguous, reject
        const hasUrl = typeof entry['url'] === 'string' && entry['url'].trim() !== '';
        const hasCommand = typeof entry['command'] === 'string' && entry['command'].trim() !== '';
        if (hasUrl && hasCommand) {
            return {
                code: 'invalid_server_entry',
                serverId: id,
                message: `Server '${id}' has both 'url' and 'command' — pick one (HTTP or stdio transport)`
            };
        }
        if (!hasUrl && !hasCommand) {
            return {
                code: 'invalid_server_entry',
                serverId: id,
                message: `Server '${id}' must specify either 'command' (stdio) or 'url' (HTTP)`
            };
        }

        // args: optional, defaults to []
        let args: string[] = [];
        if ('args' in entry && entry['args'] !== undefined) {
            if (!Array.isArray(entry['args'])) {
                return {
                    code: 'invalid_server_entry',
                    serverId: id,
                    message: `Server '${id}' field 'args' must be an array of strings`
                };
            }
            for (const a of entry['args']) {
                if (typeof a !== 'string') {
                    return {
                        code: 'invalid_server_entry',
                        serverId: id,
                        message: `Server '${id}' field 'args' contains a non-string value`
                    };
                }
                args.push(a);
            }
        }

        // env: optional, defaults to {}
        let env: Record<string, string> = {};
        if ('env' in entry && entry['env'] !== undefined) {
            if (!entry['env'] || typeof entry['env'] !== 'object' || Array.isArray(entry['env'])) {
                return {
                    code: 'invalid_server_entry',
                    serverId: id,
                    message: `Server '${id}' field 'env' must be an object of string-to-string pairs`
                };
            }
            for (const [k, v] of Object.entries(entry['env'] as Record<string, unknown>)) {
                if (typeof v !== 'string') {
                    return {
                        code: 'invalid_server_entry',
                        serverId: id,
                        message: `Server '${id}' env value for '${k}' must be a string`
                    };
                }
                env[k] = v;
            }
        }

        // disabled: optional, defaults to false
        let disabled = false;
        if ('disabled' in entry && entry['disabled'] !== undefined) {
            if (typeof entry['disabled'] !== 'boolean') {
                return {
                    code: 'invalid_server_entry',
                    serverId: id,
                    message: `Server '${id}' field 'disabled' must be a boolean`
                };
            }
            disabled = entry['disabled'];
        }

        let serverEntry: McpServerEntry;
        if (hasUrl) {
            // HTTP transport: parse `headers` (optional, defaults to {}).
            let headers: Record<string, string> = {};
            if ('headers' in entry && entry['headers'] !== undefined) {
                if (!entry['headers'] || typeof entry['headers'] !== 'object' || Array.isArray(entry['headers'])) {
                    return {
                        code: 'invalid_server_entry',
                        serverId: id,
                        message: `Server '${id}' field 'headers' must be an object of string-to-string pairs`
                    };
                }
                for (const [k, v] of Object.entries(entry['headers'] as Record<string, unknown>)) {
                    if (typeof v !== 'string') {
                        return {
                            code: 'invalid_server_entry',
                            serverId: id,
                            message: `Server '${id}' header '${k}' must be a string`
                        };
                    }
                    headers[k] = v;
                }
            }
            serverEntry = {
                transport: 'http',
                id,
                url: entry['url'] as string,
                headers,
                disabled,
            };
        } else {
            serverEntry = {
                transport: 'stdio',
                id,
                command: entry['command'] as string,
                args,
                env,
                disabled,
            };
        }
        if ('description' in entry && typeof entry['description'] === 'string') {
            serverEntry.description = entry['description'];
        }
        servers.push(serverEntry);
    }

    // Stable sort by id so the UI list is deterministic across reloads.
    servers.sort((a, b) => a.id.localeCompare(b.id));
    return { servers };
}

/**
 * Expand `${env:VARNAME}` references inside a string against a
 * provided env map (typically process.env). Unknown variables expand
 * to empty string, matching Kiro's behavior. No shell expansion, no
 * recursive substitution — just a simple find-and-replace.
 *
 * Used by McpManager when it spawns the server: the raw env values
 * from config are run through envExpand so secrets like API tokens
 * can live in the host's environment rather than the config file.
 *
 * Pure function — exported for unit testing.
 */
export function envExpand(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => {
        return env[varName] ?? '';
    });
}

/**
 * Convenience: return true when the parse result is an error vs a
 * config. TypeScript narrows the type after this check.
 */
export function isMcpConfigError(result: McpConfig | McpConfigError): result is McpConfigError {
    return 'code' in result;
}