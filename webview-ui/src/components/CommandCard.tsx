// webview-ui/src/components/CommandCard.tsx
//
// A bordered card representing a shell command execution: the command
// itself, its working directory, status, and (live or final) output.
//
// Used by:
//   - Coordinator-emitted bash tool calls (currently rendered ad-hoc as
//     a div with terminal-like styling at App.tsx L1143)
//   - (future) inline command playback in spec discussion
//
// Design intent (per UI_GAP_ANALYSIS.md Gap 2):
//   - Header strip: terminal prompt indicator, command summary, optional cwd
//   - Body: scrollable terminal output, fixed max-height to keep chat compact
//   - Status indicator: running | success | error
//   - Multiple commands stack as separate cards (this component is one card)
//
// Terminal styling: the existing inline rendering uses GitHub-Dark-ish
// hex colors (#0d1117 bg, #c9d1d9 fg, #30363d border, #8b949e prompt).
// Those are kept for the body — they're terminal conventions and the
// VS Code theme tokens don't have direct equivalents. The chrome (border,
// header text) uses the regular Nexus tokens so it integrates with the
// surrounding chat UI.

import React from 'react';
import { Terminal as IconTerminal, Loader2 as IconLoader, CheckCircle as IconCheck, XCircle as IconError } from 'lucide-react';

export type CommandStatus = 'running' | 'success' | 'error';

export interface CommandCardProps {
    /**
     * The command line as it would appear at the user's prompt.
     * Single-line preferred; multi-line is rendered verbatim.
     */
    command: string;
    /**
     * Output captured so far (may grow live during streaming).
     * Pre-formatted text; carriage returns and ANSI sequences should
     * be cleaned by the caller before passing in.
     */
    output: string;
    /**
     * Working directory for the command, displayed in the header.
     * Optional — omit for non-cwd-relevant commands.
     */
    cwd?: string;
    /**
     * Current status. Drives the header icon and color.
     * 'running' shows a spinner; 'success' a checkmark; 'error' an X.
     */
    status?: CommandStatus;
    /**
     * Maximum body height in pixels. Output beyond this scrolls.
     * Default: 150 (matches existing inline rendering).
     */
    maxHeight?: number;
}

const STATUS_CONFIG: Record<CommandStatus, { color: string; Icon: typeof IconLoader }> = {
    running: { color: 'var(--vscode-charts-orange, #cca700)', Icon: IconLoader },
    success: { color: 'var(--nexus-success)', Icon: IconCheck },
    error:   { color: 'var(--nexus-error)',   Icon: IconError }
};

export function CommandCard({
    command,
    output,
    cwd,
    status = 'running',
    maxHeight = 150
}: CommandCardProps): React.ReactElement {
    const cfg = STATUS_CONFIG[status];
    const { Icon } = cfg;
    const isSpinner = status === 'running';

    return (
        <div className="command-card">
            <div className="command-card-header">
                <span className="command-card-prompt" aria-hidden="true">
                    <IconTerminal size={12} />
                </span>
                <span className="command-card-cmd" title={command}>{command}</span>
                {cwd && <span className="command-card-cwd" title={cwd}>{cwd}</span>}
                <span className="command-card-status" style={{ color: cfg.color }}>
                    <Icon size={14} className={isSpinner ? 'spin' : undefined} />
                </span>
            </div>
            <pre
                className="command-card-output"
                style={{ maxHeight: `${maxHeight}px` }}
                tabIndex={0}
            >
                {output || <span className="command-card-empty">(no output yet)</span>}
            </pre>
        </div>
    );
}