"use strict";
// src/mcp/mcpClient.ts
//
// PR P2.1 SDK INTEGRATION: thin adapter over the
// @modelcontextprotocol/sdk Client + StdioClientTransport.
//
// Responsibilities:
//   - Spawn the configured MCP server, perform the JSON-RPC handshake
//   - List the server's tools, return them in our toolRegistry's
//     ToolDefinition shape with namespaced names
//   - Dispatch tool calls back to the server via client.callTool, map
//     the SDK's content-block response into our ToolDispatchResult
//   - Disconnect cleanly, killing the spawned subprocess
//
// What this module does NOT do:
//   - State management — that's McpManager's job
//   - Tool registration into the global registry — McpManager wires
//     dispatchers into toolRegistry; this file only shapes the
//     dispatchers
//   - Process supervision / auto-reconnect — out of scope for v1; if
//     a server crashes, the user reloads via the panel button
Object.defineProperty(exports, "__esModule", { value: true });
exports.namespaceToolName = namespaceToolName;
exports.parseNamespacedName = parseNamespacedName;
exports.connectMcpServer = connectMcpServer;
exports.setMcpClientFactoryForTests = setMcpClientFactoryForTests;
exports.mapCallToolResultToDispatchResult = mapCallToolResultToDispatchResult;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const mcpConfig_1 = require("./mcpConfig");
const logger_1 = require("../logger");
/**
 * P2.1 SDK: namespacing convention for MCP-provided tools.
 *
 * Every tool the agent dispatches goes through one toolRegistry. To
 * keep MCP-server tool names from colliding with built-in tool names
 * (`read_file`, `bash_exec`, etc.) — and to keep tools from one MCP
 * server from colliding with tools from another — we namespace.
 *
 *   built-in:   "read_file"
 *   mcp tool:   "mcp__<serverId>__<toolName>"
 *
 * Double underscore separator because:
 *   - Single underscore appears in many built-in tool names
 *     (`read_file`) — ambiguous as a delimiter
 *   - Hyphen / dot conflict with OpenAI's tool-name regex
 *     (`^[a-zA-Z0-9_-]{1,64}$`) only allows alphanumeric, underscore,
 *     hyphen — but hyphens occur in tool names already
 *   - Double underscore is unambiguous and OpenAI-name-regex-safe
 *
 * The format is: `mcp__<serverId>__<toolName>`. Reverse via
 * parseNamespacedName.
 */
const NAMESPACE_PREFIX = 'mcp__';
const NAMESPACE_SEP = '__';
/** Namespace a server-local tool name into a registry-global name. */
function namespaceToolName(serverId, toolName) {
    return `${NAMESPACE_PREFIX}${serverId}${NAMESPACE_SEP}${toolName}`;
}
/** Parse a namespaced name back into its parts, or null if not MCP. */
function parseNamespacedName(name) {
    if (!name.startsWith(NAMESPACE_PREFIX)) {
        return null;
    }
    const rest = name.slice(NAMESPACE_PREFIX.length);
    const sepIdx = rest.indexOf(NAMESPACE_SEP);
    if (sepIdx === -1) {
        return null;
    }
    const serverId = rest.slice(0, sepIdx);
    const toolName = rest.slice(sepIdx + NAMESPACE_SEP.length);
    if (!serverId || !toolName) {
        return null;
    }
    return { serverId, toolName };
}
/** Real implementation — module-private. Exported one (`connectMcpServer`)
 *  reads through the swappable holder so tests can inject. */
async function realConnectMcpServer(entry) {
    // Resolve env: expand `${env:VAR}` references against process.env.
    // Empty values from process.env become empty strings (matches
    // envExpand's documented contract).
    const resolvedEnv = {};
    for (const [k, v] of Object.entries(entry.env)) {
        resolvedEnv[k] = (0, mcpConfig_1.envExpand)(v, process.env);
    }
    logger_1.log.debug(`[McpClient] connecting to '${entry.id}' (command=${entry.command})`);
    const transport = new stdio_js_1.StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: resolvedEnv
    });
    const client = new index_js_1.Client({
        name: 'nexuscode',
        version: '0.1.0' // TODO: read from package.json at start time
    }, {
        capabilities: {
        // We're a tool-consuming client. Declare nothing
        // beyond the defaults — sampling, roots, etc., aren't
        // wired up.
        }
    });
    // connect() performs the JSON-RPC initialize handshake. Errors
    // from the server (protocol mismatch, immediate crash) bubble up.
    await client.connect(transport);
    // listTools() returns the server's tools. Failures here mean the
    // server connected but doesn't speak the tools/list capability —
    // we treat that as a connected-but-no-tools server (returns []).
    let toolList = [];
    try {
        const result = await client.listTools();
        toolList = result.tools;
    }
    catch (e) {
        logger_1.log.warn(`[McpClient] '${entry.id}' connected but listTools failed:`, e);
    }
    // Build the OpenAI-shape ToolDefinitions. The MCP inputSchema is
    // a JSON Schema object; we forward it as-is into our parameters
    // field (which is `Record<string, unknown>` — i.e. JSON-Schema-
    // compatible).
    const tools = toolList.map((t) => ({
        type: 'function',
        function: {
            name: namespaceToolName(entry.id, t.name),
            description: t.description ?? `MCP tool '${t.name}' from server '${entry.id}'`,
            // The MCP inputSchema uses `Record<string, object>` for
            // properties; our ToolDefinition.parameters is the more
            // permissive `Record<string, unknown>`. Forward verbatim.
            parameters: t.inputSchema
        }
    }));
    const dispatch = async (toolName, args) => {
        try {
            const result = await client.callTool({
                name: toolName,
                arguments: args
            });
            return mapCallToolResultToDispatchResult(result, entry.id, toolName);
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return {
                llmContent: `MCP tool '${toolName}' on server '${entry.id}' failed: ${message}`,
                uiPayload: {
                    kind: 'error',
                    message: `MCP tool error (server '${entry.id}'): ${message}`
                }
            };
        }
    };
    const close = async () => {
        try {
            await client.close();
        }
        catch (e) {
            logger_1.log.warn(`[McpClient] '${entry.id}' close threw:`, e);
        }
    };
    return {
        tools,
        originalToolNames: toolList.map((t) => t.name),
        dispatch,
        close
    };
}
let _connectMcpServer = realConnectMcpServer;
/**
 * P2.1 SDK: connect to an MCP server defined by `entry`. Spawns,
 * handshakes, lists tools.
 *
 * Throws on connection failure — caller (McpManager) catches and
 * transitions to 'error' status with the thrown message.
 *
 * The returned dispatch function is closure-scoped to this client;
 * calling it after close() will hit a closed-transport error from
 * the SDK.
 */
function connectMcpServer(entry) {
    return _connectMcpServer(entry);
}
/**
 * Test-only: swap the connect implementation. Used to inject fakes
 * that don't actually spawn processes.
 *
 * Pass `null` to restore the real implementation.
 */
function setMcpClientFactoryForTests(fn) {
    _connectMcpServer = fn ?? realConnectMcpServer;
}
/**
 * P2.1 SDK: map the SDK's CallToolResult (a list of content blocks
 * with optional isError flag) into our ToolDispatchResult shape.
 *
 * Strategy:
 *   - Concatenate all `text`-type blocks for the LLM content
 *   - Note presence of non-text blocks (image, resource) in the
 *     LLM content but don't try to render them — our ToolResult
 *     union doesn't have an image variant for tool returns yet
 *   - When isError is true, surface as a `kind: 'error'` UI payload;
 *     otherwise return a `kind: 'string'` with the concatenated text
 *
 * Exported (not just used internally) so it can be unit-tested
 * against synthetic CallToolResult fixtures without needing a live
 * SDK client.
 */
function mapCallToolResultToDispatchResult(result, serverId, toolName) {
    const content = Array.isArray(result.content) ? result.content : [];
    const textParts = [];
    const nonTextKinds = [];
    for (const block of content) {
        if (block && typeof block === 'object' && 'type' in block) {
            const b = block;
            if (b.type === 'text') {
                if (typeof b.text === 'string') {
                    textParts.push(b.text);
                }
                // Malformed text block (no text field) — drop silently.
                // Reporting it as non-text would confuse the LLM more
                // than help it.
                continue;
            }
            nonTextKinds.push(b.type);
        }
    }
    let llmContent = textParts.join('\n');
    if (nonTextKinds.length > 0) {
        // Annotate, don't fail — the LLM still reasons about whatever
        // text content was returned, but it should know there was
        // non-text content it didn't see.
        const summary = `[+ ${nonTextKinds.length} non-text content block(s): ${nonTextKinds.join(', ')}]`;
        llmContent = llmContent ? `${llmContent}\n${summary}` : summary;
    }
    if (result.isError === true) {
        return {
            llmContent: llmContent || `MCP tool '${toolName}' on server '${serverId}' returned an error.`,
            uiPayload: {
                kind: 'error',
                message: llmContent || `MCP tool '${toolName}' returned an error.`
            }
        };
    }
    // Empty-content edge case: the server returned nothing. Rare but
    // legal per the spec. Surface a benign empty string to the LLM
    // rather than letting downstream code see undefined.
    if (!llmContent) {
        llmContent = `(empty result from MCP tool '${toolName}')`;
    }
    return {
        llmContent,
        uiPayload: { kind: 'string', content: llmContent }
    };
}
//# sourceMappingURL=mcpClient.js.map