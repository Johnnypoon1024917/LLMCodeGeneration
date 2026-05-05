// webview-ui/src/components/WorkingBar.tsx
//
// A compact one-line bar shown at the bottom of the chat that surfaces
// the agent's current activity while the agent is working.
//
// Used by:
//   - Chat surface (App.tsx) replacing inline `agentStatus` rendering
//   - (future) Coordinator multi-step status during long runs
//
// Design intent (per UI_GAP_ANALYSIS.md Gap 5):
//   - Single line, fits at the bottom of the chat
//   - Spinning indicator when active
//   - Optional cancel button
//   - Optional expand affordance (chevron) for live tool-call detail —
//     deferred to T3 since the tool-call shape lands with Component 2
//
// What this is NOT:
//   - The same as the global "Loading..." state (that's the input lock,
//     a separate concern)
//   - A progress bar (we don't have meaningful progress percentages from
//     the LLM; spinning is the honest representation)
//
// Status text caveat: the existing implementation passes free-form strings
// in `agentStatus` that sometimes contain emoji like `⚠️` and `🛑`. The
// existing display logic at App.tsx L1309 inspects these via .includes()
// to decide whether to show the spinner. We preserve that contract here
// — callers can still pass emoji-bearing strings — but the cleaner long-term
// fix is to pass a structured status object. That's a follow-up.

import React from 'react';
import { Loader2 as IconLoader, AlertTriangle, X as IconX, Square as IconStop } from 'lucide-react';

export interface WorkingBarProps {
    /**
     * Free-form status text. Displayed verbatim. Keep short — single-line
     * design assumes ~50-80 chars.
     */
    status: string;
    /**
     * If provided, renders a stop button that calls this when clicked.
     * Button is hidden if not provided (some statuses are not cancellable).
     */
    onCancel?: () => void;
    /**
     * Override the auto-detected indicator. By default we show:
     *   - Warning icon if status contains '⚠️' or 'warning'
     *   - Stop icon if status contains '🛑' or 'stopped'
     *   - Spinner otherwise
     * Pass 'idle' to render no icon (uncommon).
     */
    indicator?: 'spinner' | 'warning' | 'stopped' | 'idle';
}

function autoIndicator(status: string): 'spinner' | 'warning' | 'stopped' {
    const s = status.toLowerCase();
    if (status.includes('⚠️') || s.includes('warning')) { return 'warning'; }
    if (status.includes('🛑') || s.includes('stopped') || s.includes('blocked')) { return 'stopped'; }
    return 'spinner';
}

export function WorkingBar({
    status,
    onCancel,
    indicator
}: WorkingBarProps): React.ReactElement | null {
    if (!status) { return null; }
    const ind = indicator ?? autoIndicator(status);

    let iconNode: React.ReactNode = null;
    if (ind === 'spinner') {
        iconNode = <IconLoader size={12} className="spin" />;
    } else if (ind === 'warning') {
        iconNode = <AlertTriangle size={12} style={{ color: 'var(--nexus-warning)' }} />;
    } else if (ind === 'stopped') {
        iconNode = <IconStop size={12} fill="currentColor" style={{ color: 'var(--nexus-error)' }} />;
    }
    // 'idle' → null (no icon)

    return (
        <div className="working-bar agent-status" style={{ flexShrink: 0 }}>
            {iconNode && <span className="working-bar-indicator">{iconNode}</span>}
            <span className="working-bar-text">{status}</span>
            {onCancel && (
                <button
                    type="button"
                    className="working-bar-cancel"
                    onClick={onCancel}
                    aria-label="Cancel"
                    title="Cancel"
                >
                    <IconX size={12} />
                </button>
            )}
        </div>
    );
}