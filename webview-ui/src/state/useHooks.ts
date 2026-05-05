// webview-ui/src/state/useHooks.ts
//
// Webview-side state for the hooks list. Subscribes to host
// `hookListUpdated` messages, which the HookManager fires whenever
// hooks are loaded, reloaded, or toggled. The webview never holds
// authoritative state — the .nexus/hooks/*.md files on disk are the
// source of truth, the host parses them, the webview reflects.
//
// On mount, posts `requestHookList` to the host to populate the
// initial state. The host responds with `hookListUpdated`.
//
// Actions:
//   - toggleHook(id, enabled) → host updates the frontmatter `enabled:`
//     field in the .md file. The FS watcher then fires hookListUpdated.
//   - runHook(id) → host invokes the hook outside its trigger context.
//
// Why no optimistic updates: hook state changes round-trip in <100ms
// because writes are local FS. Optimistic toggling would risk the UI
// disagreeing with disk if a write fails. We accept the round-trip
// latency for state correctness.

import { useCallback, useEffect, useReducer } from 'react';

/** Subset of HookDefinition that's serializable + UI-relevant. The
 *  host's full HookDefinition includes a sourceUri (absolute FS path)
 *  and promptTemplate (potentially huge); the webview gets a summary. */
export interface HookSummary {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    /** Trigger summary string, pre-formatted by the host for display.
     *  Example: "on save: globPattern" or "command: nexuscode.hook.lint"
     *  or "every 60s". */
    triggerSummary: string;
    /** Trigger type — used for the pill color. Discriminator. */
    triggerType: 'onFileSave' | 'onCommand' | 'onSchedule';
    /** Last fire timestamp, ISO-8601, or undefined if never fired this
     *  session. Used to show recent activity in the panel. */
    lastFiredAt?: string;
    /** True if a fire is currently in flight. */
    inflight: boolean;
}

interface HooksState {
    hooks: HookSummary[];
    /** True until the first hookListUpdated message arrives. The host
     *  may take a moment to scan .nexus/hooks/ on cold start. */
    loading: boolean;
}

type HooksAction =
    | { type: 'list_updated'; hooks: HookSummary[] }
    | { type: 'set_inflight'; id: string; inflight: boolean };

function reducer(state: HooksState, action: HooksAction): HooksState {
    if (action.type === 'list_updated') {
        return { hooks: action.hooks, loading: false };
    }
    if (action.type === 'set_inflight') {
        return {
            ...state,
            hooks: state.hooks.map((h) =>
                h.id === action.id ? { ...h, inflight: action.inflight } : h
            )
        };
    }
    return state;
}

/** Minimal vscode bridge — the same `acquireVsCodeApi()` shape used
 *  elsewhere. Typed loosely because App.tsx already owns the singleton. */
interface VsCodeBridge {
    postMessage: (message: { type: string; [k: string]: unknown }) => void;
}

export interface UseHooksResult extends HooksState {
    /** Toggle a hook's enabled state. The host writes the .md file's
     *  frontmatter; the FS watcher then fires hookListUpdated. */
    toggleHook: (id: string, enabled: boolean) => void;
    /** Fire a hook now, outside its trigger context. Useful for
     *  testing a hook or running an "audit-everything" hook on demand. */
    runHook: (id: string) => void;
    /** Test/demo escape hatch — inject a list directly. Used by unit
     *  tests so we don't need a host stub. */
    setHooksForTest: (hooks: HookSummary[]) => void;
}

export function useHooks(vscode: VsCodeBridge): UseHooksResult {
    const [state, dispatch] = useReducer(reducer, {
        hooks: [],
        loading: true
    });

    // Subscribe to host messages.
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data as { type?: string; hooks?: unknown };
            if (data?.type !== 'hookListUpdated') {
                return;
            }
            if (!Array.isArray(data.hooks)) {
                // Malformed — ignore.
                return;
            }
            // Defensive shape check. We don't crash on bad host data;
            // we just drop entries that don't match the shape.
            const validated: HookSummary[] = [];
            for (const h of data.hooks as unknown[]) {
                if (typeof h !== 'object' || h === null) {
                    continue;
                }
                const obj = h as Record<string, unknown>;
                if (
                    typeof obj['id'] !== 'string' ||
                    typeof obj['name'] !== 'string' ||
                    typeof obj['enabled'] !== 'boolean' ||
                    typeof obj['triggerSummary'] !== 'string' ||
                    typeof obj['triggerType'] !== 'string'
                ) {
                    continue;
                }
                const tt = obj['triggerType'] as string;
                if (tt !== 'onFileSave' && tt !== 'onCommand' && tt !== 'onSchedule') {
                    continue;
                }
                const summary: HookSummary = {
                    id: obj['id'] as string,
                    name: obj['name'] as string,
                    enabled: obj['enabled'] as boolean,
                    triggerSummary: obj['triggerSummary'] as string,
                    triggerType: tt,
                    inflight: typeof obj['inflight'] === 'boolean' ? (obj['inflight'] as boolean) : false
                };
                if (typeof obj['description'] === 'string') {
                    summary.description = obj['description'] as string;
                }
                if (typeof obj['lastFiredAt'] === 'string') {
                    summary.lastFiredAt = obj['lastFiredAt'] as string;
                }
                validated.push(summary);
            }
            dispatch({ type: 'list_updated', hooks: validated });
        };
        window.addEventListener('message', handler);
        // Request initial list from host. Idempotent — host can re-send
        // freely without state damage.
        vscode.postMessage({ type: 'requestHookList' });
        return () => window.removeEventListener('message', handler);
    }, [vscode]);

    const toggleHook = useCallback(
        (id: string, enabled: boolean) => {
            vscode.postMessage({ type: 'toggleHook', id, enabled });
        },
        [vscode]
    );

    const runHook = useCallback(
        (id: string) => {
            // Mark inflight optimistically. The host clears it via the next
            // hookListUpdated. Inflight state is purely a visual cue; the
            // actual run state lives on the host.
            dispatch({ type: 'set_inflight', id, inflight: true });
            vscode.postMessage({ type: 'runHook', id });
        },
        [vscode]
    );

    const setHooksForTest = useCallback((hooks: HookSummary[]) => {
        dispatch({ type: 'list_updated', hooks });
    }, []);

    return { ...state, toggleHook, runHook, setHooksForTest };
}