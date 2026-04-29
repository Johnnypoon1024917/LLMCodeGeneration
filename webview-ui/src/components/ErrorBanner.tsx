// webview-ui/src/components/ErrorBanner.tsx
//
// A bordered card for surfacing transient errors and warnings that are
// addressed to the human user (not internal logs).
//
// Used by:
//   - LLM auth/network failures bubbled to chat
//   - Spec workflow generation errors
//   - (future) Coordinator retry-exhausted notifications
//
// Design intent (per UI_GAP_ANALYSIS.md Gap 3):
//   - Bordered card with explicit warning icon, in red/orange
//   - Optional collapsible details section for stack traces or remediation steps
//   - Optional dismiss button (omit for must-acknowledge errors)
//
// What this is NOT:
//   - Status badges (those are inline tags, not banners — see T2 work)
//   - Console error logging (use logger.ts for that)
//   - Modal error dialogs (heavier, used only when blocking — not in scope here)

import React, { useState } from 'react';
import { AlertTriangle, AlertCircle, Info, X as IconX, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Banner severity. Each maps to a different border color and icon.
 *
 *   - 'error':   red. Use for things the user should fix or escalate.
 *   - 'warning': orange. Use for transient or recoverable issues.
 *   - 'info':    blue. Use for advisory notices — e.g. "context truncated".
 */
export type BannerSeverity = 'error' | 'warning' | 'info';

export interface ErrorBannerProps {
    severity?: BannerSeverity;
    /** Short one-line summary. Always visible. */
    title: string;
    /** Optional detail body. If provided, renders inside an expandable region. */
    details?: string;
    /**
     * If provided, renders an × button that calls this when clicked.
     * Omit for errors the user must address (e.g. "API key missing").
     */
    onDismiss?: () => void;
}

const SEVERITY_CONFIG: Record<BannerSeverity, { color: string; bg: string; Icon: typeof AlertTriangle }> = {
    error: {
        color: 'var(--nexus-error)',
        bg: 'var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.1))',
        Icon: AlertCircle
    },
    warning: {
        color: 'var(--nexus-warning)',
        bg: 'var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.1))',
        Icon: AlertTriangle
    },
    info: {
        color: 'var(--nexus-border)',
        bg: 'var(--vscode-inputValidation-infoBackground, rgba(0, 127, 212, 0.1))',
        Icon: Info
    }
};

export function ErrorBanner({
    severity = 'error',
    title,
    details,
    onDismiss
}: ErrorBannerProps): React.ReactElement {
    const [expanded, setExpanded] = useState(false);
    const cfg = SEVERITY_CONFIG[severity];
    const { Icon } = cfg;

    return (
        <div
            className="error-banner"
            role={severity === 'error' ? 'alert' : 'status'}
            style={{
                borderColor: cfg.color,
                background: cfg.bg
            }}
        >
            <div className="error-banner-header">
                <span className="error-banner-icon" style={{ color: cfg.color }}>
                    <Icon size={16} />
                </span>
                <span className="error-banner-title">{title}</span>
                {details && (
                    <button
                        type="button"
                        className="error-banner-toggle"
                        onClick={() => setExpanded(!expanded)}
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Hide details' : 'Show details'}
                    >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                )}
                {onDismiss && (
                    <button
                        type="button"
                        className="error-banner-close"
                        onClick={onDismiss}
                        aria-label="Dismiss"
                    >
                        <IconX size={14} />
                    </button>
                )}
            </div>
            {details && expanded && (
                <pre className="error-banner-details">{details}</pre>
            )}
        </div>
    );
}