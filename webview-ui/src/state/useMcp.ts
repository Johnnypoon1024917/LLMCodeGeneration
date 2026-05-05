// webview-ui/src/state/useMcp.ts
//
// PR P2.1: webview-side state for the MCP servers panel. Subscribes
// to host `mcpStatusUpdated` messages — the McpManager fires these
// on initial load, on every status transition, and on config-file
// changes.
//
// On mount, posts `requestMcpStatus` to the host so a freshly-mounted
// panel gets the current snapshot without waiting for a state change.
// Idempotent — host can re-send freely.
//
// Action: reload() → host re-reads .nexus/mcp-servers.json. Used by
// the panel's "Reload" button. Status updates flow back through the
// normal subscription channel, no need for a return value.

import { useCallback, useEffect, useReducer } from 'react';

/** Host-side server view, mirrored here. Keep this shape in sync with
 *  src/mcp/mcpManager.ts McpServerView. The webview defensively
 *  validates incoming messages so a host change won't crash the panel. */
export interface McpServerView {
    id: string;
    command: string;
    args: string[];
    status: 'disabled' | 'configured' | 'connecting' | 'connected' | 'error';
    statusChangedAt: number;
    errorMessage?: string;
    tools: string[];
    description?: string;
}

/** Top-level config error (the entire file is malformed). Distinct
 *  from per-server errors. */
export interface McpConfigErrorView {
    code: 'invalid_json' | 'wrong_shape' | 'invalid_server_entry';
    message: string;
    serverId?: string;
}

interface McpState {
    servers: McpServerView[];
    configError: McpConfigErrorView | null;
    loading: boolean;
}

type McpAction =
    | { type: 'updated'; servers: McpServerView[]; configError: McpConfigErrorView | null };

function reducer(state: McpState, action: McpAction): McpState {
    if (action.type === 'updated') {
        return {
            servers: action.servers,
            configError: action.configError,
            loading: false
        };
    }
    return state;
}

interface VsCodeBridge {
    postMessage: (message: { type: string; [k: string]: unknown }) => void;
}

export interface UseMcpResult extends McpState {
    /** Trigger host to re-read .nexus/mcp-servers.json. */
    reload: () => void;
    /** Test helper — set state directly without going through the
     *  message bus. */
    setServersForTest: (servers: McpServerView[], configError?: McpConfigErrorView | null) => void;
}

const VALID_STATUSES: ReadonlySet<McpServerView['status']> = new Set([
    'disabled', 'configured', 'connecting', 'connected', 'error'
]);

const VALID_ERROR_CODES: ReadonlySet<McpConfigErrorView['code']> = new Set([
    'invalid_json', 'wrong_shape', 'invalid_server_entry'
]);

/** Defensive shape validation for one server view. Drops any entry
 *  that doesn't match — better to show a partial list than crash on
 *  bad host data. */
function validateServer(raw: unknown): McpServerView | null {
    if (typeof raw !== 'object' || raw === null) { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o['id'] !== 'string') { return null; }
    if (typeof o['command'] !== 'string') { return null; }
    if (!Array.isArray(o['args'])) { return null; }
    if (typeof o['statusChangedAt'] !== 'number') { return null; }
    if (typeof o['status'] !== 'string' || !VALID_STATUSES.has(o['status'] as McpServerView['status'])) {
        return null;
    }
    if (!Array.isArray(o['tools'])) { return null; }

    const args = (o['args'] as unknown[]).filter((a) => typeof a === 'string') as string[];
    const tools = (o['tools'] as unknown[]).filter((t) => typeof t === 'string') as string[];

    const view: McpServerView = {
        id: o['id'] as string,
        command: o['command'] as string,
        args,
        status: o['status'] as McpServerView['status'],
        statusChangedAt: o['statusChangedAt'] as number,
        tools
    };
    if (typeof o['errorMessage'] === 'string') { view.errorMessage = o['errorMessage'] as string; }
    if (typeof o['description'] === 'string') { view.description = o['description'] as string; }
    return view;
}

function validateConfigError(raw: unknown): McpConfigErrorView | null {
    if (raw === null || raw === undefined) { return null; }
    if (typeof raw !== 'object') { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o['code'] !== 'string' || !VALID_ERROR_CODES.has(o['code'] as McpConfigErrorView['code'])) {
        return null;
    }
    if (typeof o['message'] !== 'string') { return null; }
    const err: McpConfigErrorView = {
        code: o['code'] as McpConfigErrorView['code'],
        message: o['message'] as string
    };
    if (typeof o['serverId'] === 'string') { err.serverId = o['serverId'] as string; }
    return err;
}

export function useMcp(vscode: VsCodeBridge): UseMcpResult {
    const [state, dispatch] = useReducer(reducer, {
        servers: [],
        configError: null,
        loading: true
    });

    useEffect(() => {
        const handler = (event: MessageEvent<unknown>) => {
            const data = event.data as { type?: unknown; servers?: unknown; configError?: unknown } | null;
            if (!data || typeof data !== 'object' || data.type !== 'mcpStatusUpdated') {
                return;
            }
            if (!Array.isArray(data.servers)) { return; }

            const validated: McpServerView[] = [];
            for (const raw of data.servers as unknown[]) {
                const view = validateServer(raw);
                if (view) { validated.push(view); }
            }
            const configError = validateConfigError(data.configError);
            dispatch({ type: 'updated', servers: validated, configError });
        };

        window.addEventListener('message', handler);
        // Initial fetch — idempotent, safe to re-send if the panel is
        // remounted (tab-switch).
        vscode.postMessage({ type: 'requestMcpStatus' });
        return () => window.removeEventListener('message', handler);
    }, [vscode]);

    const reload = useCallback(() => {
        vscode.postMessage({ type: 'mcpReload' });
    }, [vscode]);

    const setServersForTest = useCallback(
        (servers: McpServerView[], configError: McpConfigErrorView | null = null) => {
            dispatch({ type: 'updated', servers, configError });
        },
        []
    );

    return { ...state, reload, setServersForTest };
}