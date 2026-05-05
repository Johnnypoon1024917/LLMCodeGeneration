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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerEntry } from './mcpConfig';
import { envExpand } from './mcpConfig';
import type { ToolDefinition } from '../llm/Provider';
import type { ToolDispatchResult } from '../agents/toolProtocol';
import { log } from '../logger';

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
export function namespaceToolName(serverId: string, toolName: string): string {
    return `${NAMESPACE_PREFIX}${serverId}${NAMESPACE_SEP}${toolName}`;
}

/** Parse a namespaced name back into its parts, or null if not MCP. */
export function parseNamespacedName(
    name: string
): { serverId: string; toolName: string } | null {
    if (!name.startsWith(NAMESPACE_PREFIX)) { return null; }
    const rest = name.slice(NAMESPACE_PREFIX.length);
    const sepIdx = rest.indexOf(NAMESPACE_SEP);
    if (sepIdx === -1) { return null; }
    const serverId = rest.slice(0, sepIdx);
    const toolName = rest.slice(sepIdx + NAMESPACE_SEP.length);
    if (!serverId || !toolName) { return null; }
    return { serverId, toolName };
}

/**
 * P2.1 SDK: result of a successful connect(). Carries:
 *   - `tools`: the OpenAI-shape ToolDefinitions ready to register
 *   - `dispatch`: the dispatcher function for callTool
 *   - `close`: tear-down hook
 *   - `originalToolNames`: the un-namespaced tool names, for
 *     reporting in the McpServerView UI (the user shouldn't see the
 *     namespacing — that's an internal concern)
 */
export interface McpConnection {
    tools: ToolDefinition[];
    originalToolNames: string[];
    dispatch: (toolName: string, args: Record<string, unknown>) => Promise<ToolDispatchResult>;
    close: () => Promise<void>;
}

/** Factory function type — swappable for tests via setMcpClientFactoryForTests. */
type ConnectMcpServerFn = (entry: McpServerEntry) => Promise<McpConnection>;

/** Real implementation — module-private. Exported one (`connectMcpServer`)
 *  reads through the swappable holder so tests can inject. */
async function realConnectMcpServer(entry: McpServerEntry): Promise<McpConnection> {
    // Resolve env: expand `${env:VAR}` references against process.env.
    // Empty values from process.env become empty strings (matches
    // envExpand's documented contract).
    const resolvedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.env)) {
        resolvedEnv[k] = envExpand(v, process.env);
    }

    log.debug(`[McpClient] connecting to '${entry.id}' (command=${entry.command})`);

    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: resolvedEnv
    });

    const client = new Client(
        {
            name: 'nexuscode',
            version: '0.1.0'  // TODO: read from package.json at start time
        },
        {
            capabilities: {
                // We're a tool-consuming client. Declare nothing
                // beyond the defaults — sampling, roots, etc., aren't
                // wired up.
            }
        }
    );

    // connect() performs the JSON-RPC initialize handshake. Errors
    // from the server (protocol mismatch, immediate crash) bubble up.
    await client.connect(transport);

    // listTools() returns the server's tools. Failures here mean the
    // server connected but doesn't speak the tools/list capability —
    // we treat that as a connected-but-no-tools server (returns []).
    let toolList: { name: string; description?: string; inputSchema: { type: 'object'; properties?: unknown; required?: unknown } }[] = [];
    try {
        const result = await client.listTools();
        toolList = result.tools as typeof toolList;
    } catch (e) {
        log.warn(`[McpClient] '${entry.id}' connected but listTools failed:`, e);
    }

    // Build the OpenAI-shape ToolDefinitions. The MCP inputSchema is
    // a JSON Schema object; we forward it as-is into our parameters
    // field (which is `Record<string, unknown>` — i.e. JSON-Schema-
    // compatible).
    const tools: ToolDefinition[] = toolList.map((t) => ({
        type: 'function' as const,
        function: {
            name: namespaceToolName(entry.id, t.name),
            description: t.description ?? `MCP tool '${t.name}' from server '${entry.id}'`,
            // The MCP inputSchema uses `Record<string, object>` for
            // properties; our ToolDefinition.parameters is the more
            // permissive `Record<string, unknown>`. Forward verbatim.
            parameters: t.inputSchema as Record<string, unknown>
        }
    }));

    const dispatch = async (
        toolName: string,
        args: Record<string, unknown>
    ): Promise<ToolDispatchResult> => {
        try {
            const result = await client.callTool({
                name: toolName,
                arguments: args
            });
            return mapCallToolResultToDispatchResult(result, entry.id, toolName);
        } catch (e) {
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
        } catch (e) {
            log.warn(`[McpClient] '${entry.id}' close threw:`, e);
        }
    };

    return {
        tools,
        originalToolNames: toolList.map((t) => t.name),
        dispatch,
        close
    };
}

let _connectMcpServer: ConnectMcpServerFn = realConnectMcpServer;

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
export function connectMcpServer(entry: McpServerEntry): Promise<McpConnection> {
    return _connectMcpServer(entry);
}

/**
 * Test-only: swap the connect implementation. Used to inject fakes
 * that don't actually spawn processes.
 *
 * Pass `null` to restore the real implementation.
 */
export function setMcpClientFactoryForTests(fn: ConnectMcpServerFn | null): void {
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
export function mapCallToolResultToDispatchResult(
    result: { content?: unknown; isError?: boolean | undefined; [k: string]: unknown },
    serverId: string,
    toolName: string
): ToolDispatchResult {
    const content = Array.isArray(result.content) ? result.content : [];

    const textParts: string[] = [];
    const nonTextKinds: string[] = [];
    for (const block of content) {
        if (block && typeof block === 'object' && 'type' in block) {
            const b = block as { type: string; text?: string };
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