// webview-ui/src/state/useSteering.ts
//
// Webview-side state for the steering rules list. Subscribes to host
// `steeringListUpdated` messages. The .nexus/steering/*.md files on
// disk are the source of truth; the webview reflects.
//
// Steering rules differ from hooks in two ways:
//   1. There are 3 canonical files (product.md, structure.md, tech.md)
//      that follow Kiro's convention. The host always lists these
//      three, marking each as "exists" or "missing". The user can
//      one-click create a missing file with a starter template.
//   2. Users can add arbitrary additional .md files in the steering
//      directory. Those show up too, distinguished from the canonical
//      three by a `kind: 'custom'` discriminator.
//
// Actions:
//   - createSteeringFile(name) → host creates the file with a template
//     (canonical files use a built-in template; custom files start blank)
//   - openSteeringFile(name)   → host opens the file in the main editor

import { useCallback, useEffect, useReducer } from 'react';

/** A steering file as the webview sees it. The host pre-formats the
 *  display name and exists flag; the webview just renders. */
export interface SteeringSummary {
    /** Filename without extension (e.g. 'product', 'structure', 'tech', or
     *  any custom name). Stable id for keying, opens, creates. */
    id: string;
    /** Pretty name for display. For canonical files, this is the human
     *  label ("Product", "Structure", "Tech"). For custom files, equals id. */
    name: string;
    /** Optional short description shown under the name. Canonical files
     *  have built-in descriptions; custom files leave this undefined. */
    description?: string;
    /** Discriminator: canonical files (the Kiro-convention three) vs
     *  custom files (anything else in the steering dir). The UI may
     *  render them differently — canonical files stay sorted at the
     *  top; custom files follow alphabetically. */
    kind: 'canonical' | 'custom';
    /** True if the file exists on disk. Canonical files may be missing
     *  on a fresh project — the panel offers a create button when so. */
    exists: boolean;
    /** Last-modified timestamp, ISO-8601. Undefined for missing files. */
    lastModified?: string;
}

interface SteeringState {
    items: SteeringSummary[];
    loading: boolean;
}

type SteeringAction =
    | { type: 'list_updated'; items: SteeringSummary[] };

function reducer(state: SteeringState, action: SteeringAction): SteeringState {
    if (action.type === 'list_updated') {
        return { items: action.items, loading: false };
    }
    return state;
}

interface VsCodeBridge {
    postMessage: (message: { type: string; [k: string]: unknown }) => void;
}

export interface UseSteeringResult extends SteeringState {
    /** Create a steering file (with a template if it's a canonical name).
     *  Round-trips through the host; the next steeringListUpdated will
     *  reflect the new file. */
    createSteeringFile: (id: string) => void;
    /** Open the file in VS Code's main editor. Same pattern as hooks
     *  panel — editing happens in the real editor where monaco works. */
    openSteeringFile: (id: string) => void;
    /** Test/demo escape hatch — inject a list directly. */
    setItemsForTest: (items: SteeringSummary[]) => void;
}

export function useSteering(vscode: VsCodeBridge): UseSteeringResult {
    const [state, dispatch] = useReducer(reducer, {
        items: [],
        loading: true
    });

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const data = event.data as { type?: string; items?: unknown };
            if (data?.type !== 'steeringListUpdated') {
                return;
            }
            if (!Array.isArray(data.items)) {
                return;
            }
            // Defensive shape check — drop entries that don't match.
            const validated: SteeringSummary[] = [];
            for (const it of data.items as unknown[]) {
                if (typeof it !== 'object' || it === null) {
                    continue;
                }
                const obj = it as Record<string, unknown>;
                if (
                    typeof obj['id'] !== 'string' ||
                    typeof obj['name'] !== 'string' ||
                    typeof obj['exists'] !== 'boolean' ||
                    typeof obj['kind'] !== 'string'
                ) {
                    continue;
                }
                const k = obj['kind'] as string;
                if (k !== 'canonical' && k !== 'custom') {
                    continue;
                }
                const summary: SteeringSummary = {
                    id: obj['id'] as string,
                    name: obj['name'] as string,
                    kind: k,
                    exists: obj['exists'] as boolean
                };
                if (typeof obj['description'] === 'string') {
                    summary.description = obj['description'] as string;
                }
                if (typeof obj['lastModified'] === 'string') {
                    summary.lastModified = obj['lastModified'] as string;
                }
                validated.push(summary);
            }
            dispatch({ type: 'list_updated', items: validated });
        };
        window.addEventListener('message', handler);
        // Request initial list. Idempotent — host can re-send freely.
        vscode.postMessage({ type: 'requestSteeringList' });
        return () => window.removeEventListener('message', handler);
    }, [vscode]);

    const createSteeringFile = useCallback(
        (id: string) => {
            vscode.postMessage({ type: 'createSteeringFile', id });
        },
        [vscode]
    );

    const openSteeringFile = useCallback(
        (id: string) => {
            vscode.postMessage({ type: 'openSteeringFile', id });
        },
        [vscode]
    );

    const setItemsForTest = useCallback((items: SteeringSummary[]) => {
        dispatch({ type: 'list_updated', items });
    }, []);

    return { ...state, createSteeringFile, openSteeringFile, setItemsForTest };
}