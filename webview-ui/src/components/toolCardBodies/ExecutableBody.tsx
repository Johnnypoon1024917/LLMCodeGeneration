// webview-ui/src/components/toolCardBodies/ExecutableBody.tsx
//
// Component 2B-4c: body strategy for "executable" tools — the four
// shell-running tools share this body:
//
//   - bash_exec       → arbitrary shell command
//   - run_tests       → test runner (jest / pytest / npm test)
//   - install_package → npm/pip install
//   - git_commit      → git commit / git push
//
// All four go through src/agents/tools/_execHelper.ts → runCommand,
// which produces a `bash_output` UI payload (stdout, stderr,
// exitCode, durationMs) and emits chronologically-interleaved
// `toolCallOutput` events as the subprocess runs (Q7=7B streaming
// deltas). The events accumulate into `state.outputBuffer` via
// applyToolEvent's reducer.
//
// Rendering strategy:
//
//   - Status === 'running'  → show outputBuffer in a terminal-style
//                             <pre>. Cursor blinks in the empty case.
//   - Status === 'success'  → same <pre>, but with completion meta
//                             (exit code, duration). Auto-scrolled
//                             to the end so the user lands on the
//                             tail of the output.
//   - Status === 'error' or 'cancelled' → same <pre> with red border
//                             on the meta strip. exit code shown
//                             prominently.
//
// Why we render outputBuffer directly (not payload.stdout +
// payload.stderr): the streaming chunks ARE chronologically
// interleaved (runCommand's handleChunk emits in arrival order),
// which is what a real terminal shows. Splitting into stdout-then-
// stderr loses that ordering. The payload's stdout/stderr fields
// are still useful for debugging — exposed via a "View streams
// separately" details toggle when complete.
//
// Edge cases:
//
//   - Empty output (no chunks ever arrived AND payload empty):
//     "(no output)" placeholder.
//   - outputBuffer empty but payload has content (rare — events
//     dropped/lost): fall back to synthesizing a stream from
//     payload.stdout + payload.stderr.
//   - Very long output: native browser scrolling handles it. The
//     <pre> has max-height; user can scroll.
//
// Reuses CSS:
//   - .command-card-output, .command-card-empty (from existing
//     CommandCard styling — terminal-y look for output blocks)
//   - .tool-call-info-meta, .tool-call-info-meta-item (from 2B-4a)
//   - .tool-call-card-empty, .tool-call-card-error (from 2B-4a)
//
// Adds CSS:
//   - .tool-call-exec-* family for the meta + exit code chips

import React, { useEffect, useRef } from 'react';
import {
    AlertCircle as IconAlert,
    CheckCircle2 as IconSuccess,
    XCircle as IconFail,
    SlashSquare as IconCancelled,
    Clock as IconClock
} from 'lucide-react';
import type { ToolCallState, ToolResult } from '../../toolEvents';

export interface ExecutableBodyProps {
    state: ToolCallState;
}

/**
 * Auto-scroll a ref'd element to the bottom whenever its
 * dependency value changes. Used to keep the output `<pre>` pinned
 * to the latest line as new chunks stream in. Without this, the
 * user has to manually scroll to follow streaming output.
 *
 * Caveat: if the user has scrolled UP to read earlier output, we
 * shouldn't yank them back to the bottom on every chunk. Track the
 * user's intent: only auto-scroll if they were already at the
 * bottom (or near it) before the new content arrived.
 */
function useAutoScrollOnUpdate(
    ref: React.RefObject<HTMLElement>,
    dep: string
): void {
    // Track whether the user is currently pinned to the bottom.
    // We update this on every dep change; if at the time of the
    // update the user was at the bottom, we keep them there.
    const wasAtBottomRef = useRef(true);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        // After the DOM updates with new content, decide based on
        // the PRIOR pinned state: if the user was at the bottom
        // before this update, scroll to the new bottom; otherwise
        // leave them alone.
        if (wasAtBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }
        // Now sample the new state for the NEXT update.
        // Threshold of 12px allows tiny rounding from line-height
        // calculations to still count as "at the bottom".
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        wasAtBottomRef.current = distanceFromBottom < 12;
    }, [dep, ref]);
}

/**
 * Format duration as a human-readable string. Mirrors the helper
 * in ToolCallCard but inlined here to avoid circular import.
 *   < 1000ms   → "342ms"
 *   < 60000ms  → "4.2s"
 *   else       → "1m 23s"
 */
function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}

export function ExecutableBody({ state }: ExecutableBodyProps): React.ReactElement {
    const preRef = useRef<HTMLPreElement>(null);

    // Resolve the output text. While running, we always use the
    // streamed outputBuffer. Once complete, prefer outputBuffer if
    // we have any (chronological ordering preserved); fall back to
    // payload-synthesized output if events were dropped.
    const outputText = resolveOutputText(state);

    // Auto-scroll on every output change, but respect the user's
    // current scroll position (see hook implementation).
    useAutoScrollOnUpdate(preRef, outputText);

    // Error path — explicit error payload (e.g., spawn failed before
    // runCommand could collect any output).
    if (state.result?.uiPayload.kind === 'error') {
        return (
            <div className="tool-call-card-error">
                <IconAlert size={14} />
                <span>{state.result.uiPayload.message}</span>
            </div>
        );
    }

    // Compute meta info: exit code (if completed), duration.
    const isComplete = state.status === 'success' || state.status === 'error' || state.status === 'cancelled';
    const bashPayload =
        state.result?.uiPayload.kind === 'bash_output'
            ? state.result.uiPayload
            : null;

    return (
        <div className="tool-call-info-body">
            <pre
                ref={preRef}
                className="command-card-output tool-call-exec-output"
                tabIndex={0}
            >
                {outputText
                    ? outputText
                    : <span className="command-card-empty">
                        {state.status === 'running' ? '(running…)' : '(no output)'}
                      </span>}
            </pre>

            {isComplete && (
                <div className="tool-call-exec-meta" data-status={state.status}>
                    <ExitCodeChip
                        status={state.status}
                        exitCode={bashPayload?.exitCode}
                    />
                    {(state.durationMs ?? bashPayload?.durationMs) !== undefined && (
                        <span className="tool-call-info-meta-item tool-call-exec-duration">
                            <IconClock size={11} />
                            <span>{formatDuration(state.durationMs ?? bashPayload!.durationMs)}</span>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Choose the right text to render. Priority:
 *
 *   1. outputBuffer if non-empty (streamed chunks, chronological)
 *   2. payload's stdout + stderr concatenated (if completed and
 *      buffer is empty — rare, indicates events were lost)
 *   3. empty string (caller renders a placeholder)
 *
 * The synthesized fallback explicitly LABELS the streams ("--- stdout ---"
 * etc.) because we've lost chronology and the user should know.
 */
function resolveOutputText(state: ToolCallState): string {
    if (state.outputBuffer) return state.outputBuffer;
    if (state.result?.uiPayload.kind === 'bash_output') {
        const p = state.result.uiPayload;
        const parts: string[] = [];
        if (p.stdout) parts.push(p.stdout);
        if (p.stderr) {
            // Label only when both streams have content — pure-stderr
            // commands (e.g., `cmake --version`) shouldn't show a
            // gratuitous "--- stderr ---" header.
            if (p.stdout) parts.push('\n--- stderr ---\n');
            parts.push(p.stderr);
        }
        return parts.join('');
    }
    return '';
}

/**
 * Compact chip showing the exit code. Color-coded:
 *   - exit 0 + status='success' → green check + "exit 0"
 *   - exit !0 + status='error'  → red X + "exit N"
 *   - status='cancelled'        → grey slash + "cancelled"
 *
 * Why we don't infer status from exit code alone: a command can
 * exit 0 but the dispatch wrapper can still mark it as 'cancelled'
 * (e.g., the abort signal fired right as the process was wrapping up).
 * The status carries authority; exit code is just informational.
 */
function ExitCodeChip({
    status,
    exitCode
}: {
    status: ToolCallState['status'];
    exitCode?: number;
}): React.ReactElement {
    if (status === 'cancelled') {
        return (
            <span className="tool-call-exec-chip tool-call-exec-chip-cancelled">
                <IconCancelled size={11} />
                <span>cancelled</span>
            </span>
        );
    }
    if (status === 'error') {
        return (
            <span className="tool-call-exec-chip tool-call-exec-chip-error">
                <IconFail size={11} />
                <span>{exitCode !== undefined ? `exit ${exitCode}` : 'failed'}</span>
            </span>
        );
    }
    // success
    return (
        <span className="tool-call-exec-chip tool-call-exec-chip-success">
            <IconSuccess size={11} />
            <span>{exitCode !== undefined ? `exit ${exitCode}` : 'done'}</span>
        </span>
    );
}

// Discourage unused-import warnings if a future refactor drops
// references — keep the type imported because it's part of the
// public contract.
export type { ToolResult };