// webview-ui/src/components/CrossTaskRegressionBanner.tsx
//
// V2.2 cross-task remediation: inline banner shown when the host
// detects new tsc errors after a successful task.
//
// Two render modes based on whether we could attribute the new errors
// to a specific session task:
//
//   attributable: true  →  show "Fix automatically" button. Click
//                          dispatches the synthesized remediation
//                          task into the autonomy queue.
//
//   attributable: false →  informational. Link to Problems pane.
//
// Visual: amber accent. The originating task DID succeed; this is a
// "by the way, your other task broke" signal — warning not error.

import React from 'react';
import { AlertTriangle, Wrench } from 'lucide-react';

export interface RemediationTaskPayload {
    taskKey: string;
    taskTitle: string;
    prompt: string;
    sourceTaskKey: string;
    targetFile: string;
}

export interface CrossTaskRegressionBannerProps {
    sourceTaskKey: string;
    newErrorCount: number;
    summary: string;
    attributable: boolean;
    remediationTask?: RemediationTaskPayload;
    onApplyRemediation: (task: RemediationTaskPayload) => void;
    onDismiss: () => void;
}

export function CrossTaskRegressionBanner(props: CrossTaskRegressionBannerProps): React.ReactElement {
    const { newErrorCount, summary, attributable, remediationTask, onApplyRemediation, onDismiss } = props;
    return (
        <div
            role="region"
            aria-label="Cross-task regression detected"
            style={{
                margin: '8px 0',
                border: '1px solid var(--vscode-inputValidation-warningBorder, #cca700)',
                borderLeft: '3px solid var(--vscode-inputValidation-warningBorder, #cca700)',
                borderRadius: '4px',
                background: 'var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.08))',
                fontSize: '12px',
                color: 'var(--vscode-foreground)',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '8px 10px 6px 10px',
                    fontWeight: 600,
                }}
            >
                <AlertTriangle size={14} aria-hidden="true" />
                <span>Cross-task regression</span>
                <span style={{ fontWeight: 'normal', opacity: 0.75 }}>
                    · {newErrorCount} new tsc error{newErrorCount === 1 ? '' : 's'}
                </span>
            </div>

            <div style={{ padding: '0 10px 8px 10px', opacity: 0.92 }}>
                {summary}
            </div>

            <div
                style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '6px',
                    padding: '6px 10px 10px 10px',
                    borderTop: '1px dashed var(--vscode-widget-border, transparent)',
                }}
            >
                <button
                    type="button"
                    onClick={onDismiss}
                    style={{
                        background: 'transparent',
                        color: 'var(--vscode-foreground)',
                        border: '1px solid var(--vscode-button-secondaryBackground, var(--vscode-widget-border))',
                        borderRadius: '3px',
                        padding: '4px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                    }}
                >
                    Dismiss
                </button>
                {attributable && remediationTask && (
                    <button
                        type="button"
                        onClick={() => onApplyRemediation(remediationTask)}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            background: 'var(--vscode-button-background)',
                            color: 'var(--vscode-button-foreground)',
                            border: '1px solid var(--vscode-button-background)',
                            borderRadius: '3px',
                            padding: '4px 12px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: 600,
                        }}
                        aria-label={`Auto-remediate by editing ${remediationTask.targetFile}`}
                    >
                        <Wrench size={12} aria-hidden="true" />
                        Fix automatically
                    </button>
                )}
            </div>
        </div>
    );
}