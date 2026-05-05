// webview-ui/src/state/usePanel.ts
//
// Right-side panel state. The panel slot in AppShell can show one of
// several views: audit log (PR 2.4), hooks library (PR 3.2), steering
// rules (PR 3.3). This hook tracks which is active and whether the
// panel is open.
//
// Default state: closed. The user opens it by clicking a Rail button
// or via a keyboard shortcut (future). Once open, switching between
// panel kinds doesn't re-trigger an open animation — they swap in place.
//
// Why no persistence: VS Code webviews can persist via vscode.setState()
// but the panel preference is small enough and ephemeral enough that
// resetting on reload is fine. If a user really wants the audit panel
// pinned, future PR can add it to the user settings via the host.

import { useCallback, useState } from 'react';

export type PanelKind = 'audit' | 'hooks' | 'steering' | 'mcp' | 'diagnostics';

export interface PanelState {
    isOpen: boolean;
    kind: PanelKind;
}

export interface UsePanelResult extends PanelState {
    /** Open the panel showing the given view. If already open with the
     *  same kind, this is a no-op. If open with a different kind, swaps
     *  in place (no close-then-open animation). */
    open: (kind: PanelKind) => void;
    /** Close the panel. Kind state is preserved so the next open()
     *  with no argument could in theory restore — but we don't expose
     *  that yet; callers always pass a kind. */
    close: () => void;
    /** Toggle: if open with this kind, close; if closed or different
     *  kind, open with this kind. Used by the Rail buttons. */
    toggle: (kind: PanelKind) => void;
}

export function usePanel(initial?: Partial<PanelState>): UsePanelResult {
    const [state, setState] = useState<PanelState>({
        isOpen: initial?.isOpen ?? false,
        kind: initial?.kind ?? 'audit'
    });

    const open = useCallback((kind: PanelKind) => {
        setState({ isOpen: true, kind });
    }, []);

    const close = useCallback(() => {
        setState((s) => ({ ...s, isOpen: false }));
    }, []);

    const toggle = useCallback((kind: PanelKind) => {
        setState((s) => {
            if (s.isOpen && s.kind === kind) { return { ...s, isOpen: false }; }
            return { isOpen: true, kind };
        });
    }, []);

    return { ...state, open, close, toggle };
}