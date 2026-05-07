"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMcpConfig = parseMcpConfig;
exports.envExpand = envExpand;
exports.isMcpConfigError = isMcpConfigError;
/**
 * Parse a raw config string into a validated McpConfig OR a structured
 * error. Pure function — caller (typically McpManager) handles the FS.
 *
 * Empty / missing input is a valid config with zero servers. The
 * caller treats that as "no MCP configured" and the manager simply
 * doesn't attempt any connections.
 */
function parseMcpConfig(raw) {
    if (raw.trim() === '') {
        return { servers: [] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
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
    const root = parsed;
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
    const servers = [];
    const mcpServersMap = root['mcpServers'];
    for (const [id, raw] of Object.entries(mcpServersMap)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {
                code: 'invalid_server_entry',
                serverId: id,
                message: `Server '${id}' entry must be a JSON object`
            };
        }
        const entry = raw;
        if (typeof entry['command'] !== 'string' || entry['command'].trim() === '') {
            return {
                code: 'invalid_server_entry',
                serverId: id,
                message: `Server '${id}' missing required string field 'command'`
            };
        }
        // args: optional, defaults to []
        let args = [];
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
        let env = {};
        if ('env' in entry && entry['env'] !== undefined) {
            if (!entry['env'] || typeof entry['env'] !== 'object' || Array.isArray(entry['env'])) {
                return {
                    code: 'invalid_server_entry',
                    serverId: id,
                    message: `Server '${id}' field 'env' must be an object of string-to-string pairs`
                };
            }
            for (const [k, v] of Object.entries(entry['env'])) {
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
        const serverEntry = { id, command: entry['command'], args, env, disabled };
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
function envExpand(value, env) {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName) => {
        return env[varName] ?? '';
    });
}
/**
 * Convenience: return true when the parse result is an error vs a
 * config. TypeScript narrows the type after this check.
 */
function isMcpConfigError(result) {
    return 'code' in result;
}
//# sourceMappingURL=mcpConfig.js.map