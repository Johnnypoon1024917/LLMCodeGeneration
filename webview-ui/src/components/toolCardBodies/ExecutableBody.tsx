// webview-ui/src/components/toolCardBodies/ExecutableBody.tsx
//
// Body strategy for "executable" tools — the four shell-running tools
// share this body:
//
//   - bash_exec       → arbitrary shell command
//   - run_tests       → test runner (jest / pytest / npm test)
//   - install_package → npm/pip install
//   - git_commit      → git commit / git push
//
// All four go through src/agents/tools/_execHelper.ts → runCommand,
// which produces a `bash_output` UI payload (stdout, stderr, exitCode,
// durationMs) and emits chronologically-interleaved `toolCallOutput`
// events as the subprocess runs. The events accumulate into
// `state.outputBuffer` via applyToolEvent's reducer.
//
// Rendering strategy:
//   - Status === 'running'  → outputBuffer in a terminal-style <pre>.
//                             "(running…)" placeholder if no output yet.
//   - Status === 'success'  → same <pre>, plus completion meta strip
//                             (exit code chip + duration). Auto-scrolled
//                             to the end so the user lands on the tail.
//   - Status === 'error' or 'cancelled' → same <pre> with red/grey chip
//                             on the meta strip.
//
// Output is rendered from outputBuffer (chronological order preserved)
// rather than payload.stdout + payload.stderr (which would lose
// ordering). Synthesizes from payload only when buffer is empty —
// rare, indicates events were dropped.
//
// PR 2.2 (Sprint 2): visual overhaul. Chrome (meta, error) now uses
// shared body atoms + design tokens. Exit-code chip rewritten using
// the Pill primitive for consistency with the rest of the redesign.
// Terminal output <pre> intentionally keeps its dark GitHub-style
// background — that's the universal developer expectation for
// command output. resolveOutputText / useAutoScrollOnUpdate /
// formatDuration / ExitCodeChip logic preserved.

import React, { useEffect, useRef } from 'react';
import {
    CheckCircle2 as IconSuccess,
    XCircle as IconFail,
    SlashSquare as IconCancelled,
    Clock as IconClock
} from 'lucide-react';
import type { ToolCallState, ToolResult } from '../../toolEvents';
import { cn } from '../ui/cn';
import { Pill } from '../ui/Pill';
import { BodyContainer, BodyError } from './shared';

export interface ExecutableBodyProps {
    state: ToolCallState;
}

/**
 * Auto-scroll a ref'd element to the bottom whenever its dependency
 * value changes. Used to keep the output `<pre>` pinned to the latest
 * line as new chunks stream in. Without this, the user has to manually
 * scroll to follow streaming output.
 *
 * Caveat: if the user has scrolled UP to read earlier output, we don't
 * yank them back to the bottom on every chunk. We only auto-scroll if
 * the user was already at the bottom before the new content arrived.
 */
function useAutoScrollOnUpdate(
    ref: React.RefObject<HTMLElement>,
    dep: string
): void {
    const wasAtBottomRef = useRef(true);

    useEffect(() => {
        const el = ref.current;
        if (!el) { return; }
        if (wasAtBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        wasAtBottomRef.current = distanceFromBottom < 12;
    }, [dep, ref]);
}

/**
 * Format duration as a human-readable string. Mirrors the helper in
 * ToolCallCard but inlined to avoid circular import.
 */
function formatDuration(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}

export function ExecutableBody({ state }: ExecutableBodyProps): React.ReactElement {
    const preRef = useRef<HTMLPreElement>(null);
    const outputText = resolveOutputText(state);
    useAutoScrollOnUpdate(preRef, outputText);

    if (state.result?.uiPayload.kind === 'error') {
        return <BodyError message={state.result.uiPayload.message} />;
    }

    const isComplete =
        state.status === 'success' ||
        state.status === 'error' ||
        state.status === 'cancelled';
    const bashPayload =
        state.result?.uiPayload.kind === 'bash_output'
            ? state.result.uiPayload
            : null;

    return (
        <BodyContainer>
            <pre
                ref={preRef}
                tabIndex={0}
                className={cn(
                    'm-0 px-4 py-3',
                    'font-mono text-xs leading-relaxed',
                    'bg-[#0d1117] text-[#c9d1d9]',
                    'whitespace-pre-wrap',
                    'max-h-70 overflow-y-auto',
                    'outline-none focus:ring-1 focus:ring-border-focus focus:ring-inset'
                )}
            >
                {outputText
                    ? outputText
                    : (
                        <span className="text-[#8b949e] italic">
                            {state.status === 'running' ? '(running…)' : '(no output)'}
                        </span>
                    )}
            </pre>

            {isComplete && (
                <div
                    data-status={state.status}
                    className={cn(
                        'flex items-center gap-3',
                        'px-4 py-2',
                        'border-t border-border-subtle',
                        'font-mono text-xs',
                        // Tint the meta row when the run failed/was cancelled
                        // so the eye is drawn to the result chip.
                        state.status === 'error' && 'bg-status-blocked-bg/50 border-t-status-blocked/30',
                        state.status === 'cancelled' && 'bg-surface-sunken'
                    )}
                >
                    <ExitCodeChip
                        status={state.status}
                        // exactOptionalPropertyTypes: spread only when defined.
                        {...(bashPayload?.exitCode !== undefined
                            ? { exitCode: bashPayload.exitCode }
                            : {})}
                    />
                    {(state.durationMs ?? bashPayload?.durationMs) !== undefined && (
                        <span className="inline-flex items-center gap-1 text-text-tertiary tabular-nums">
                            <IconClock size={11} />
                            <span>
                                {formatDuration(state.durationMs ?? bashPayload!.durationMs)}
                            </span>
                        </span>
                    )}
                </div>
            )}
        </BodyContainer>
    );
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Choose the right text to render. Priority:
 *   1. outputBuffer if non-empty (streamed chunks, chronological)
 *   2. payload's stdout + stderr concatenated (if completed and buffer
 *      is empty — rare, indicates events were lost)
 *   3. empty string (caller renders a placeholder)
 *
 * The synthesized fallback explicitly LABELS the streams ("--- stderr ---")
 * because chronology is lost and the user should know.
 */
function resolveOutputText(state: ToolCallState): string {
    if (state.outputBuffer) { return state.outputBuffer; }
    if (state.result?.uiPayload.kind === 'bash_output') {
        const p = state.result.uiPayload;
        const parts: string[] = [];
        if (p.stdout) { parts.push(p.stdout); }
        if (p.stderr) {
            if (p.stdout) { parts.push('\n--- stderr ---\n'); }
            parts.push(p.stderr);
        }
        return parts.join('');
    }
    return '';
}

/**
 * Compact chip showing the exit code. Uses the Pill primitive for
 * visual consistency with the security strip and audit log.
 *
 *   - status='success'   → secure pill, "exit 0" or "done"
 *   - status='error'     → blocked pill, "exit N" or "failed"
 *   - status='cancelled' → neutral pill, "cancelled"
 *
 * We don't infer status from exit code alone: a command can exit 0
 * but the dispatch wrapper can still mark it as 'cancelled' (abort
 * signal racing process completion). Status carries authority; exit
 * code is informational.
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
            <Pill variant="neutral" className="font-mono">
                <IconCancelled size={11} className="mr-1" />
                cancelled
            </Pill>
        );
    }
    if (status === 'error') {
        return (
            <Pill variant="blocked" className="font-mono">
                <IconFail size={11} className="mr-1" />
                {exitCode !== undefined ? `exit ${exitCode}` : 'failed'}
            </Pill>
        );
    }
    return (
        <Pill variant="secure" className="font-mono">
            <IconSuccess size={11} className="mr-1" />
            {exitCode !== undefined ? `exit ${exitCode}` : 'done'}
        </Pill>
    );
}

// Keep the type imported because it's part of the public contract.
export type { ToolResult };