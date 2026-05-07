// webview-ui/src/components/FixApplicationCard.tsx
//
// V2.1.2 spec-fix-13: compact rendering of the "Apply Fix" re-feed.
//
// When the user clicks "Apply this fix" on an explore-mode response,
// the host synthesizes a build-mode prompt that bundles the original
// user request + the entire explore diagnosis, then re-sends it
// through processUserMessage. This is necessary for the planner to
// have full grounding context.
//
// BUT — naively rendering that 19KB synthesized prompt as a user-
// message bubble bloats the chat window so much that the actual fix
// activity below scrolls off-screen. This card replaces the bubble
// with a compact representation:
//
//   ┌─ ⚡ Applied fix ─────────────────────────────────────────┐
//   │ "There is no dashboard shown at the index.html"          │
//   │ ↳ with diagnosis from previous message (19,561 chars)    │
//   └──────────────────────────────────────────────────────────┘
//
// The diagnosis itself isn't duplicated here — it's already visible
// above as the prior assistant message, so the user has full context
// without us re-rendering it.

import React from 'react';
import { Zap } from 'lucide-react';

export interface FixApplicationCardProps {
    originalPrompt: string;
    diagnosisLength: number;
}

export function FixApplicationCard({ originalPrompt, diagnosisLength }: FixApplicationCardProps): React.ReactElement {
    // Defensive: trim and cap the original prompt for display. Even
    // though it's typically short, an attacker / malformed payload
    // shouldn't be able to render a giant block here either.
    const display = (originalPrompt || '').trim().slice(0, 400);
    const truncated = (originalPrompt || '').length > display.length;

    // Format the diagnosis length with thousands separators so 19561
    // reads as 19,561.
    const formattedLen = diagnosisLength.toLocaleString();

    return (
        <div
            role="region"
            aria-label="Applied fix"
            style={{
                margin: '4px 0',
                padding: '8px 12px',
                border: '1px solid var(--vscode-widget-border, transparent)',
                borderLeft: '3px solid var(--vscode-charts-purple, #b072d6)',
                borderRadius: '4px',
                background: 'var(--vscode-editor-inactiveSelectionBackground, rgba(176, 114, 214, 0.06))',
                fontSize: '12px',
                color: 'var(--vscode-foreground)',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 600,
                    marginBottom: '4px',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--vscode-charts-purple, #b072d6)',
                }}
            >
                <Zap size={12} aria-hidden="true" />
                <span>Applied fix</span>
            </div>

            <div
                style={{
                    fontStyle: 'italic',
                    opacity: 0.92,
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.4,
                }}
            >
                "{display}{truncated && '…'}"
            </div>

            <div
                style={{
                    marginTop: '4px',
                    fontSize: '10px',
                    opacity: 0.65,
                }}
            >
                ↳ with diagnosis from previous message ({formattedLen} chars)
            </div>
        </div>
    );
}