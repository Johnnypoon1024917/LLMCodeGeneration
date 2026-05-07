// webview-ui/src/components/ToolApprovalCard.tsx
//
// V2.1.2 spec-fix-12 — Bug #1: inline approval card for write_file /
// edit_file when AutoPilot is OFF.
//
// Renders in the chat thread immediately when the host posts
// `requestToolApproval`. Two buttons:
//   [Approve]  → posts approveToolCall { callId } back, host resolves
//                the pending promise with true, dispatch proceeds.
//   [Reject]   → posts rejectToolCall  { callId } back, host resolves
//                with false, dispatch returns an error to the LLM.
//
// The card disappears when the host's tool-event stream completes the
// call (we don't tie removal to the click; we let the eventual
// toolCallCompleted event clear it via the parent's state).
//
// Visuals deliberately distinct from ToolCallCard so the user reads
// "this is a question" not "this is a log line." Yellow/orange accent
// per the standard "needs attention" semaphore.

import React from 'react';
import { FilePlus, FileEdit, ShieldAlert } from 'lucide-react';

export interface ToolApprovalRequest {
    callId: string;
    toolName: 'write_file' | 'edit_file';
    filepath: string;
    preview:
        | { kind: 'write'; content: string }
        | { kind: 'edit'; oldText: string; newText: string };
}

export interface ToolApprovalCardProps {
    request: ToolApprovalRequest;
    onApprove: (callId: string) => void;
    onReject: (callId: string) => void;
}

export function ToolApprovalCard(props: ToolApprovalCardProps): React.ReactElement {
    const { request, onApprove, onReject } = props;
    const Icon = request.toolName === 'write_file' ? FilePlus : FileEdit;
    const verbHeader = request.toolName === 'write_file' ? 'Write file' : 'Edit file';

    return (
        <div
            role="region"
            aria-label="Approval required for file change"
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
                <ShieldAlert size={14} aria-hidden="true" />
                <span>Approval required</span>
                <span style={{ fontWeight: 'normal', opacity: 0.7 }}>· {verbHeader}</span>
                <code
                    style={{
                        marginLeft: 'auto',
                        fontSize: '11px',
                        opacity: 0.85,
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    }}
                >
                    {request.filepath}
                </code>
                <Icon size={14} aria-hidden="true" />
            </div>

            <div style={{ padding: '0 10px 8px 10px' }}>
                {request.preview.kind === 'write' ? (
                    <pre
                        style={{
                            margin: 0,
                            padding: '6px 8px',
                            background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2))',
                            border: '1px solid var(--vscode-widget-border, transparent)',
                            borderRadius: '3px',
                            fontFamily: 'var(--vscode-editor-font-family, monospace)',
                            fontSize: '11px',
                            maxHeight: '180px',
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                        }}
                    >
                        {request.preview.content}
                        {request.preview.content.length >= 800 && (
                            <span style={{ opacity: 0.6 }}>{'\n…(truncated)'}</span>
                        )}
                    </pre>
                ) : (
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '6px',
                        }}
                    >
                        <ApprovalEditPanel label="Replace" colorVar="--vscode-diffEditor-removedTextBackground" text={request.preview.oldText} />
                        <ApprovalEditPanel label="With"    colorVar="--vscode-diffEditor-insertedTextBackground" text={request.preview.newText} />
                    </div>
                )}
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
                    onClick={() => onReject(request.callId)}
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
                    Reject
                </button>
                <button
                    type="button"
                    onClick={() => onApprove(request.callId)}
                    style={{
                        background: 'var(--vscode-button-background)',
                        color: 'var(--vscode-button-foreground)',
                        border: '1px solid var(--vscode-button-background)',
                        borderRadius: '3px',
                        padding: '4px 12px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: 600,
                    }}
                >
                    Approve
                </button>
            </div>
        </div>
    );
}

function ApprovalEditPanel(props: { label: string; colorVar: string; text: string }): React.ReactElement {
    return (
        <div>
            <div style={{ fontSize: '10px', opacity: 0.7, marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {props.label}
            </div>
            <pre
                style={{
                    margin: 0,
                    padding: '4px 6px',
                    background: `var(${props.colorVar}, rgba(120, 120, 120, 0.08))`,
                    border: '1px solid var(--vscode-widget-border, transparent)',
                    borderRadius: '3px',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    fontSize: '11px',
                    maxHeight: '120px',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                }}
            >
                {props.text || <span style={{ opacity: 0.5 }}>(empty)</span>}
            </pre>
        </div>
    );
}