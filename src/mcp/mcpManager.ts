// src/mcp/mcpManager.ts
//
// PR P2.1: MCP server management — config loading, status tracking,
// subscription API for the webview.
//
// Scope of this module (P2.1):
//   - Owns the config FS watcher
//   - Maintains per-server status state
//   - Exposes a subscription API the webview uses to render the
//     "MCP servers" tab in settings
//   - Provides a clean integration seam (TODO(MCP-CLIENT)) for the
//     actual @modelcontextprotocol/sdk client lifecycle
//
// What this module does NOT do (deferred to its own dedicated PR):
//   - Spawn the actual MCP server process
//   - JSON-RPC handshake / initialize / tools/list / tools/call
//   - Tool registration into the agent's toolRegistry
//
// The TODO seam below describes EXACTLY what needs to happen when the
// SDK integration lands. Designed so that PR can be net-additive: the
// public interfaces here don't change, only the bodies of two methods
// (connectServer, disconnectServer) and an internal tools-register
// hook acquire real implementations.

import * as vscode from 'vscode';
import { log } from '../logger';
import {
    parseMcpConfig,
    isMcpConfigError,
    type McpConfigError,
    type McpServerEntry
} from './mcpConfig';
import { connectMcpServer, type McpConnection } from './mcpClient';
import { registerTool, unregisterTool } from '../agents/toolRegistry';

/** P2.1: lifecycle status of a single MCP server, surfaced to the UI. */
export type McpServerStatus =
    /** Disabled in config (`"disabled": true`). Manager records the
     *  entry but does not attempt to connect. */
    | 'disabled'
    /** Read from config, not yet connected. Initial state for an
     *  enabled server before the manager attempts a connection. */
    | 'configured'
    /** Manager has spawned/handshaked but tools not yet listed. */
    | 'connecting'
    /** Successfully connected; tools are registered with the agent. */
    | 'connected'
    /** Connection failed or crashed. `errorMessage` carries the cause. */
    | 'error';

/** P2.1: per-server view object surfaced to the webview's MCP panel. */
export interface McpServerView {
    id: string;
    command: string;
    args: string[];
    /** Status timestamp, for "connected 2 min ago" / "errored 5s ago". */
    statusChangedAt: number;
    status: McpServerStatus;
    /** Populated when status === 'error'. */
    errorMessage?: string;
    /** Populated when status === 'connected'. The actual tools list
     *  comes from the SDK's tools/list response — for P2.1, this is
     *  always empty (TODO(MCP-CLIENT) populates it). */
    tools: string[];
    /** Pass-through from config. */
    description?: string;
}

/** P2.1: top-level config-error view for the UI. Distinct from a
 *  per-server error: this is "the whole file is wrong". */
export interface McpConfigErrorView extends McpConfigError {}

/** Internal state we keep per server. Subset of the view object plus
 *  the active SDK connection handle (when status is 'connected'). */
interface ServerState {
    entry: McpServerEntry;
    status: McpServerStatus;
    statusChangedAt: number;
    errorMessage?: string;
    tools: string[];
    /** P2.1 SDK: live connection. Set only when status === 'connected'.
     *  Cleared by disconnectServer. Holds the dispatch closure +
     *  close handle returned by connectMcpServer. */
    connection?: McpConnection;
}

/**
 * Singleton owning MCP server lifecycle.
 *
 * Invariant: the public `getServerViews` always returns a snapshot
 * — immutable, safe to postMessage to the webview without further
 * cloning.
 */
export class McpManager {
    private static _instance: McpManager | null = null;

    static getInstance(): McpManager {
        if (!McpManager._instance) {
            McpManager._instance = new McpManager();
        }
        return McpManager._instance;
    }

    /** P2.1: only used by tests — clears the singleton so each test
     *  gets a fresh instance. Production should NEVER call this. */
    static resetForTests(): void {
        McpManager._instance?.dispose();
        McpManager._instance = null;
    }

    /** TODO(MCP-CLIENT): also used by tests to hook in a fake SDK
     *  client factory. Production sets nothing — the real SDK is
     *  imported and used directly when wired up. */
    private constructor() {}

    private workspaceRoot: vscode.Uri | null = null;
    private watcher: vscode.FileSystemWatcher | null = null;
    private servers: Map<string, ServerState> = new Map();
    private configError: McpConfigError | null = null;
    private subscribers: Array<(views: McpServerView[], error: McpConfigError | null) => void> = [];

    /**
     * Initialize. Sets up a FS watcher on `.nexus/mcp-servers.json`,
     * loads the config once, then subscribes for live changes.
     * Idempotent — calling twice tears down the old watcher.
     */
    start(workspaceRoot: vscode.Uri): void {
        this.workspaceRoot = workspaceRoot;

        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }

        const configPattern = new vscode.RelativePattern(workspaceRoot, '.nexus/mcp-servers.json');
        this.watcher = vscode.workspace.createFileSystemWatcher(configPattern);
        const reload = () => {
            this.reloadConfig().catch((e) => {
                log.warn('[McpManager] reloadConfig failed:', e);
            });
        };
        this.watcher.onDidChange(reload);
        this.watcher.onDidCreate(reload);
        this.watcher.onDidDelete(reload);

        // Initial load — kick off async, don't block start().
        this.reloadConfig().catch((e) => {
            log.warn('[McpManager] initial reloadConfig failed:', e);
        });
    }

    /**
     * Tear down the watcher and any active connections. Safe to call
     * multiple times.
     */
    dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        // P2.1 SDK: close every active connection. Use Promise.allSettled
        // so one slow shutdown doesn't block the rest.
        const closing: Array<Promise<void>> = [];
        for (const state of this.servers.values()) {
            this.deregisterTools(state);
            if (state.connection) {
                closing.push(
                    state.connection.close().catch((e) => {
                        log.warn(`[McpManager] dispose close threw:`, e);
                    })
                );
            }
        }
        // Fire and forget — dispose() is sync to match the VS Code
        // disposable contract. The SDK's close() is non-critical for
        // correctness (process group will reap on host exit anyway).
        if (closing.length > 0) {
            void Promise.allSettled(closing);
        }
        this.servers.clear();
        this.configError = null;
        this.subscribers = [];
        this.workspaceRoot = null;
    }

    /**
     * Re-read .nexus/mcp-servers.json, diff against current state,
     * connect/disconnect as needed. Public so the UI can offer a
     * "reload config" button.
     */
    async reloadConfig(): Promise<void> {
        if (!this.workspaceRoot) { return; }

        const configUri = vscode.Uri.joinPath(this.workspaceRoot, '.nexus', 'mcp-servers.json');
        let raw = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(configUri);
            raw = new TextDecoder().decode(bytes);
        } catch {
            // Config file doesn't exist — treat as empty config.
            // The manager simply has zero servers. No error surfaced
            // to UI because "no MCP" is a legitimate state.
            raw = '';
        }

        const result = parseMcpConfig(raw);
        if (isMcpConfigError(result)) {
            // Surface the parse error to the UI but keep existing
            // (running) servers running. A bad edit shouldn't kill
            // already-connected servers.
            this.configError = result;
            this.notifySubscribers();
            return;
        }

        this.configError = null;

        // Diff: which servers are new / changed / removed?
        const incomingIds = new Set(result.servers.map((s) => s.id));
        const removedIds: string[] = [];
        for (const id of this.servers.keys()) {
            if (!incomingIds.has(id)) { removedIds.push(id); }
        }
        for (const id of removedIds) {
            await this.disconnectServer(id);
            this.servers.delete(id);
        }

        for (const entry of result.servers) {
            const existing = this.servers.get(entry.id);
            if (!existing) {
                // New server — record + maybe connect.
                this.servers.set(entry.id, {
                    entry,
                    status: entry.disabled ? 'disabled' : 'configured',
                    statusChangedAt: Date.now(),
                    tools: []
                });
                if (!entry.disabled) {
                    void this.connectServer(entry.id);
                }
            } else if (this.entryChanged(existing.entry, entry)) {
                // Changed config (command, args, env, or disabled
                // toggled) — disconnect and reconnect.
                await this.disconnectServer(entry.id);
                this.servers.set(entry.id, {
                    entry,
                    status: entry.disabled ? 'disabled' : 'configured',
                    statusChangedAt: Date.now(),
                    tools: []
                });
                if (!entry.disabled) {
                    void this.connectServer(entry.id);
                }
            }
            // Unchanged entries: leave their state alone, including
            // active connections.
        }

        this.notifySubscribers();
    }

    /**
     * Returns a snapshot of all known servers' view objects.
     * Returned array is freshly constructed; safe to postMessage
     * without cloning.
     */
    getServerViews(): McpServerView[] {
        const views: McpServerView[] = [];
        for (const state of this.servers.values()) {
            const view: McpServerView = {
                id: state.entry.id,
                command: state.entry.command,
                args: [...state.entry.args],
                status: state.status,
                statusChangedAt: state.statusChangedAt,
                tools: [...state.tools]
            };
            if (state.errorMessage !== undefined) {
                view.errorMessage = state.errorMessage;
            }
            if (state.entry.description !== undefined) {
                view.description = state.entry.description;
            }
            views.push(view);
        }
        // Stable order for deterministic UI rendering.
        views.sort((a, b) => a.id.localeCompare(b.id));
        return views;
    }

    /**
     * Returns the current config-level error, if any. Distinct from
     * per-server errors: this is "the whole file is invalid" vs
     * "this one server crashed".
     */
    getConfigError(): McpConfigError | null {
        return this.configError;
    }

    /**
     * Subscribe to status changes. Fires immediately with the current
     * snapshot, then on every subsequent state transition. Returns
     * a disposer.
     */
    subscribe(callback: (views: McpServerView[], error: McpConfigError | null) => void): () => void {
        this.subscribers.push(callback);
        // Initial delivery — synchronous, so the webview gets a
        // populated panel without waiting for a change.
        try {
            callback(this.getServerViews(), this.configError);
        } catch (e) {
            log.warn('[McpManager] subscriber threw on initial deliver:', e);
        }
        return () => {
            const idx = this.subscribers.indexOf(callback);
            if (idx !== -1) { this.subscribers.splice(idx, 1); }
        };
    }

    private notifySubscribers(): void {
        const views = this.getServerViews();
        for (const cb of this.subscribers) {
            try {
                cb(views, this.configError);
            } catch (e) {
                log.warn('[McpManager] subscriber threw:', e);
            }
        }
    }

    private entryChanged(a: McpServerEntry, b: McpServerEntry): boolean {
        if (a.command !== b.command) { return true; }
        if (a.disabled !== b.disabled) { return true; }
        if (a.args.length !== b.args.length) { return true; }
        for (let i = 0; i < a.args.length; i++) {
            if (a.args[i] !== b.args[i]) { return true; }
        }
        const aEnvKeys = Object.keys(a.env);
        const bEnvKeys = Object.keys(b.env);
        if (aEnvKeys.length !== bEnvKeys.length) { return true; }
        for (const k of aEnvKeys) {
            if (a.env[k] !== b.env[k]) { return true; }
        }
        return false;
    }

    /**
     * Connect to a configured MCP server. Spawns the server process,
     * performs the JSON-RPC initialize handshake, lists tools, and
     * registers each into the global toolRegistry under a namespaced
     * name (`mcp__<serverId>__<toolName>`).
     *
     * On success: transitions to 'connected' status with the tools
     * list populated.
     *
     * On failure (spawn error, handshake error, listTools threw):
     * transitions to 'error' with the captured error message. Tools
     * are NOT registered. The user can fix the config and reload
     * via the panel button.
     *
     * Idempotent for repeated calls on the same serverId — if a
     * connection already exists, it's closed before starting fresh.
     */
    private async connectServer(serverId: string): Promise<void> {
        const state = this.servers.get(serverId);
        if (!state || state.entry.disabled) { return; }

        // If somehow already connected (race), tear down first.
        if (state.connection) {
            try { await state.connection.close(); } catch { /* best effort */ }
            this.deregisterTools(state);
            delete state.connection;
        }

        state.status = 'connecting';
        state.statusChangedAt = Date.now();
        delete state.errorMessage;
        state.tools = [];
        this.notifySubscribers();

        let connection: McpConnection;
        try {
            connection = await connectMcpServer(state.entry);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // Common failure: ENOENT when command isn't on PATH. Surface
            // that specifically so the user knows what to fix.
            const friendlyMsg = message.includes('ENOENT')
                ? `Command not found: '${state.entry.command}'. Check it's installed and on PATH.`
                : message;

            // Re-fetch state in case the server was removed during the
            // async window. Treat that as "nothing to do".
            const stateAfter = this.servers.get(serverId);
            if (!stateAfter) { return; }
            stateAfter.status = 'error';
            stateAfter.statusChangedAt = Date.now();
            stateAfter.errorMessage = friendlyMsg;
            stateAfter.tools = [];
            this.notifySubscribers();
            return;
        }

        // Re-fetch state — connect can take seconds; the entry might
        // have been removed via config-reload during that window.
        const stateAfter = this.servers.get(serverId);
        if (!stateAfter) {
            // Server gone — close the new connection and bail.
            try { await connection.close(); } catch { /* best effort */ }
            return;
        }

        // Register each tool with the global registry. The dispatcher
        // wrapper unwraps the namespaced name back to the server-local
        // name before calling the SDK.
        for (let i = 0; i < connection.tools.length; i++) {
            const def = connection.tools[i]!;
            const originalName = connection.originalToolNames[i]!;
            registerTool(def, async (args, _ctx) => {
                return connection.dispatch(originalName, args);
            });
        }

        stateAfter.connection = connection;
        stateAfter.status = 'connected';
        stateAfter.statusChangedAt = Date.now();
        delete stateAfter.errorMessage;
        // The UI shows the un-namespaced names — namespacing is an
        // internal concern, the user thinks of "read_file" not
        // "mcp__filesystem__read_file".
        stateAfter.tools = [...connection.originalToolNames];
        this.notifySubscribers();
    }

    /**
     * Helper: deregister all of a server's tools from the toolRegistry.
     * Uses the namespaced names — same convention connectServer uses
     * to register them.
     */
    private deregisterTools(state: ServerState): void {
        for (const toolName of state.tools) {
            const namespaced = `mcp__${state.entry.id}__${toolName}`;
            unregisterTool(namespaced);
        }
    }

    /**
     * Disconnect a server: close the SDK client, deregister its tools,
     * reset state. Idempotent — safe on already-disconnected servers
     * or unknown ids.
     */
    private async disconnectServer(serverId: string): Promise<void> {
        const state = this.servers.get(serverId);
        if (!state) { return; }

        // Deregister tools first so any in-flight dispatch attempts
        // see "unknown tool" rather than racing the close().
        this.deregisterTools(state);

        if (state.connection) {
            try {
                await state.connection.close();
            } catch (e) {
                log.warn(`[McpManager] close threw for '${serverId}':`, e);
            }
            delete state.connection;
        }

        state.status = state.entry.disabled ? 'disabled' : 'configured';
        state.statusChangedAt = Date.now();
        delete state.errorMessage;
        state.tools = [];
        // notifySubscribers happens at the reloadConfig caller so
        // multiple disconnects coalesce into one notification.
    }
}