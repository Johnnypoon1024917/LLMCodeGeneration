// webview-ui/src/components/VerifierAttemptsPanel.tsx
//
// V2.2.3 "things I tried" — surfaces structured verifier attempts that
// the Coordinator's retry loop produces, so the user reviewing a
// session sees the dead ends, not just the final outcome.
//
// Why this exists: the Coordinator emits structured VerifierFailure[]
// data on every retry, but only the inline streamed prose ever reached
// the user. The structured data (file:line:code:message + severity)
// was tracked for telemetry and discarded for the UI. This panel
// surfaces it.
//
// Visual contract:
//   - Each attempt renders as a collapsible card
//   - Self-healed attempts (a later attempt passed) → amber accent,
//     labeled "Tried, recovered". Non-blocking — informational.
//   - Final-failure attempts (max retries exhausted) → red accent,
//     labeled "Final failure". Blocking — the task didn't complete.
//   - Failures inside an attempt are listed file:line — code: message
//     so the user can click through to fix manually if they want.
//
// The panel is collapsed by default (one summary line) to avoid
// dominating the chat thread. Click to expand.

import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, XCircle, RotateCcw } from 'lucide-react';

export interface VerifierFailureEntry {
    kind: 'compile' | 'test' | 'review';
    file: string | null;
    line?: number;
    column?: number;
    code?: string;
    message: string;
    severity: 'error' | 'unambiguous_typo' | 'warning';
}

export interface VerifierAttempt {
    /** 1-indexed attempt number from the Coordinator's retry loop. */
    attempt: number;
    /** True if a SUBSEQUENT attempt passed verification. False if this
     *  was the terminal failure (max retries exhausted). */
    selfHealed: boolean;
    /** Prose critique. Used only as fallback when failures[] is empty. */
    critique: string;
    /** Structured per-failure list. The interesting field. */
    failures: VerifierFailureEntry[];
}

export interface VerifierAttemptsPanelProps {
    /** Task key these attempts belong to. Used for ARIA labelling only. */
    taskKey: string;
    /** Attempts in chronological order. Caller (App.tsx) is responsible
     *  for dedup + ordering. */
    attempts: VerifierAttempt[];
}

function severityColor(sev: VerifierFailureEntry['severity']): string {
    if (sev === 'unambiguous_typo') {
        return 'var(--vscode-editorInfo-foreground, #3794ff)';
    }
    if (sev === 'warning') {
        return 'var(--vscode-editorWarning-foreground, #cca700)';
    }
    return 'var(--vscode-editorError-foreground, #f48771)';
}

function formatFailureLocation(f: VerifierFailureEntry): string {
    if (!f.file) { return ''; }
    if (f.line !== undefined && f.column !== undefined) {
        return `${f.file}:${f.line}:${f.column}`;
    }
    if (f.line !== undefined) {
        return `${f.file}:${f.line}`;
    }
    return f.file;
}

function AttemptCard({ entry }: { entry: VerifierAttempt }): React.ReactElement {
    const [expanded, setExpanded] = useState(false);

    const isFinalFailure = !entry.selfHealed;
    const accent = isFinalFailure
        ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
        : 'var(--vscode-inputValidation-warningBorder, #cca700)';
    const background = isFinalFailure
        ? 'var(--vscode-inputValidation-errorBackground, rgba(190, 17, 0, 0.08))'
        : 'var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.08))';
    const Icon = isFinalFailure ? XCircle : RotateCcw;
    const label = isFinalFailure ? 'Final failure' : 'Tried, recovered';

    const failureCount = entry.failures.length;
    const summary = failureCount > 0
        ? `${failureCount} ${failureCount === 1 ? 'issue' : 'issues'}`
        : 'no structured detail';

    return (
        <div
            role="region"
            aria-label={`Verifier attempt ${entry.attempt}`}
            style={{
                margin: '4px 0',
                border: `1px solid ${accent}`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: '4px',
                background,
                fontSize: '0.92em',
            }}
        >
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    width: '100%',
                    padding: '6px 8px',
                    background: 'transparent',
                    border: 0,
                    cursor: 'pointer',
                    color: 'inherit',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                }}
            >
                {expanded
                    ? <ChevronDown size={14} aria-hidden="true" />
                    : <ChevronRight size={14} aria-hidden="true" />}
                <Icon size={14} aria-hidden="true" />
                <span style={{ fontWeight: 500 }}>
                    Attempt {entry.attempt}: {label}
                </span>
                <span style={{ opacity: 0.7, marginLeft: 'auto' }}>{summary}</span>
            </button>

            {expanded && (
                <div style={{ padding: '0 10px 8px 30px' }}>
                    {entry.failures.length === 0 ? (
                        <pre
                            style={{
                                margin: 0,
                                padding: '4px 0',
                                whiteSpace: 'pre-wrap',
                                fontSize: '0.92em',
                                opacity: 0.85,
                                fontFamily: 'inherit',
                            }}
                        >
                            {entry.critique || '(no detail recorded)'}
                        </pre>
                    ) : (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                            {entry.failures.map((f, i) => {
                                const loc = formatFailureLocation(f);
                                const codePart = f.code ? ` [${f.code}]` : '';
                                return (
                                    <li
                                        key={i}
                                        style={{
                                            padding: '3px 0',
                                            borderTop: i === 0 ? 0 : '1px dotted rgba(128,128,128,0.25)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', gap: '6px', alignItems: 'baseline' }}>
                                            <span
                                                style={{
                                                    color: severityColor(f.severity),
                                                    fontWeight: 600,
                                                    fontSize: '0.85em',
                                                    textTransform: 'uppercase',
                                                    minWidth: '54px',
                                                }}
                                            >
                                                {f.kind}
                                            </span>
                                            {loc && (
                                                <code
                                                    style={{
                                                        fontSize: '0.9em',
                                                        opacity: 0.85,
                                                    }}
                                                >
                                                    {loc}
                                                </code>
                                            )}
                                            {codePart && (
                                                <span style={{ opacity: 0.65, fontSize: '0.85em' }}>
                                                    {codePart}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ marginLeft: '60px', whiteSpace: 'pre-wrap' }}>
                                            {f.message}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

export function VerifierAttemptsPanel(props: VerifierAttemptsPanelProps): React.ReactElement | null {
    const { taskKey, attempts } = props;
    const [collapsed, setCollapsed] = useState(true);
    if (attempts.length === 0) { return null; }

    const finalFailureCount = attempts.filter(a => !a.selfHealed).length;
    const recoveredCount = attempts.filter(a => a.selfHealed).length;
    const totalIssues = attempts.reduce((sum, a) => sum + a.failures.length, 0);

    return (
        <div
            role="region"
            aria-label={`Verifier attempts for ${taskKey}`}
            style={{
                margin: '6px 0',
                border: '1px solid var(--vscode-panel-border, #444)',
                borderRadius: '4px',
                background: 'var(--vscode-editorWidget-background, transparent)',
                fontSize: '0.95em',
            }}
        >
            <button
                type="button"
                onClick={() => setCollapsed(v => !v)}
                aria-expanded={!collapsed}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 10px',
                    background: 'transparent',
                    border: 0,
                    cursor: 'pointer',
                    color: 'inherit',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                }}
            >
                {collapsed
                    ? <ChevronRight size={14} aria-hidden="true" />
                    : <ChevronDown size={14} aria-hidden="true" />}
                <AlertTriangle size={14} aria-hidden="true" />
                <span style={{ fontWeight: 500 }}>
                    {attempts.length === 1 ? '1 verifier attempt' : `${attempts.length} verifier attempts`}
                </span>
                <span style={{ opacity: 0.7 }}>
                    ({recoveredCount > 0 && `${recoveredCount} recovered`}
                    {recoveredCount > 0 && finalFailureCount > 0 && ', '}
                    {finalFailureCount > 0 && `${finalFailureCount} final ${finalFailureCount === 1 ? 'failure' : 'failures'}`}
                    {totalIssues > 0 ? `, ${totalIssues} ${totalIssues === 1 ? 'issue' : 'issues'} total` : ''})
                </span>
            </button>

            {!collapsed && (
                <div style={{ padding: '0 10px 8px 10px' }}>
                    {attempts.map(a => (
                        <AttemptCard key={a.attempt} entry={a} />
                    ))}
                </div>
            )}
        </div>
    );
}