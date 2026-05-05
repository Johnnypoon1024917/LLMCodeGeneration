// webview-ui/src/components/HookFireCard.tsx
//
// PR P1.4: visual card for an inline hook fire.
//
//   ┌─ [zap-icon] hookName  · onFileSave: foo.ts        [duration] [⌄] ┐
//   │                                                                   │
//   │  [output markdown]                                                │
//   │                                                                   │
//   │  (on error/timeout/skipped: red banner with errorMessage)         │
//   └───────────────────────────────────────────────────────────────────┘
//
// Style matches ToolCallCard so the chat thread looks consistent.
// Icons differ: hooks use Zap (lightning bolt = "triggered"), and the
// status icons are spinning loader / check / x / clock / pause.
//
// Layout principles cribbed from PR 2.2:
//   - Card is a Card primitive container (rounded surface, subtle border)
//   - Header is a clickable row with chevron, icon, name, status pill
//   - Body shows when expanded; collapsed by default for completed
//     successful runs to keep the chat thread compact

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Zap as IconHook,
    Loader2 as IconLoader,
    CheckCircle as IconCheck,
    XCircle as IconError,
    Clock as IconTimeout,
    PauseCircle as IconSkipped,
    ChevronDown as IconChevronDown,
    ChevronRight as IconChevronRight
} from 'lucide-react';
import type { HookFireState } from '../hookEvents';
import { cn } from './ui/cn';

export interface HookFireCardProps {
    state: HookFireState;
    /** Initial expanded. Default: collapsed for terminal-success,
     *  expanded for running/error/timeout/skipped (so user sees what
     *  happened without an extra click). */
    defaultExpanded?: boolean;
}

/** Status configuration: icon, color class, ARIA label. */
const STATUS_CONFIG: Record<
    HookFireState['status'],
    { Icon: typeof IconCheck; color: string; label: string; spin: boolean; borderColor: string }
> = {
    running: {
        Icon: IconLoader,
        color: 'text-text-secondary',
        label: 'Running',
        spin: true,
        borderColor: 'border-border-subtle'
    },
    success: {
        Icon: IconCheck,
        color: 'text-status-success',
        label: 'Succeeded',
        spin: false,
        borderColor: 'border-border-subtle'
    },
    error: {
        Icon: IconError,
        color: 'text-status-danger',
        label: 'Errored',
        spin: false,
        borderColor: 'border-status-danger/40'
    },
    timeout: {
        Icon: IconTimeout,
        color: 'text-status-warning',
        label: 'Timed out',
        spin: false,
        borderColor: 'border-status-warning/40'
    },
    skipped: {
        Icon: IconSkipped,
        color: 'text-text-tertiary',
        label: 'Skipped',
        spin: false,
        borderColor: 'border-border-subtle'
    }
};

/** Format a duration ms into "1.2s" / "847ms". */
function formatDuration(ms: number | undefined): string | null {
    if (ms === undefined) { return null; }
    if (ms < 1000) { return `${ms}ms`; }
    return `${(ms / 1000).toFixed(1)}s`;
}

/** Build the trigger summary for the header — "onFileSave: src/foo.ts"
 *  / "onCommand" / "onSchedule". */
function triggerSummary(state: HookFireState): string {
    if (state.triggerType === 'onFileSave' && state.filePath) {
        // Show only the basename in the header to keep it compact;
        // full path is in the body if needed.
        const basename = state.filePath.split(/[/\\]/).pop() ?? state.filePath;
        return `onFileSave: ${basename}`;
    }
    return state.triggerType;
}

export function HookFireCard({ state, defaultExpanded }: HookFireCardProps): React.ReactElement {
    const { t } = useTranslation();

    // Localized status labels. Same keys as the en/zh-CN locale entries.
    const statusLabel: Record<HookFireState['status'], string> = {
        running: t('hooks.fire_running'),
        success: t('hooks.fire_succeeded'),
        error: t('hooks.fire_errored'),
        timeout: t('hooks.fire_timed_out'),
        skipped: t('hooks.fire_skipped')
    };

    const cfg = STATUS_CONFIG[state.status];
    const StatusIcon = cfg.Icon;
    const durationLabel = formatDuration(state.durationMs);
    // Default-expansion logic: collapsed only for terminal-success.
    // Running cards expand so user sees output as it streams; error /
    // timeout / skipped expand so the cause is immediately visible.
    const initial = defaultExpanded !== undefined
        ? defaultExpanded
        : state.status !== 'success';
    const [expanded, setExpanded] = useState(initial);

    return (
        <div
            data-testid={`hook-fire-card-${state.hookFireId}`}
            data-hook-id={state.hookId}
            data-status={state.status}
            className={cn(
                'mt-2 rounded-md',
                'bg-surface-raised border',
                cfg.borderColor,
                'overflow-hidden'
            )}
        >
            <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={() => setExpanded(e => !e)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(x => !x);
                    }
                }}
                className={cn(
                    'flex items-center gap-2',
                    'px-3 py-2',
                    'cursor-pointer select-none',
                    'transition-colors duration-(--animate-duration-fast)',
                    'hover:bg-surface-sunken',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus focus-visible:ring-inset'
                )}
            >
                <span aria-hidden="true" className="shrink-0 text-text-tertiary">
                    {expanded
                        ? <IconChevronDown size={12} />
                        : <IconChevronRight size={12} />}
                </span>
                <span aria-hidden="true" className="shrink-0 text-status-info">
                    <IconHook size={14} />
                </span>
                <span className="font-mono text-sm text-text-primary truncate min-w-0 flex-1">
                    {state.hookName}
                    <span className="text-text-secondary ml-1.5">
                        · {triggerSummary(state)}
                    </span>
                </span>
                {durationLabel && (
                    <span
                        title="Duration"
                        className="shrink-0 font-mono text-xs text-text-tertiary tabular-nums"
                    >
                        {durationLabel}
                    </span>
                )}
                <span
                    title={statusLabel[state.status]}
                    aria-label={statusLabel[state.status]}
                    className={cn('shrink-0 inline-flex items-center', cfg.color)}
                >
                    <StatusIcon size={14} className={cfg.spin ? 'spin' : undefined} />
                </span>
            </div>

            {expanded && (
                <div className="border-t border-border-subtle bg-surface-base/40 px-3 py-2 space-y-2">
                    {/* Trigger detail — full file path when applicable, since
                        the header only shows the basename. */}
                    {state.triggerType === 'onFileSave' && state.filePath && (
                        <div className="text-xs text-text-tertiary font-mono">
                            {t('hooks.fire_file_label')}: {state.filePath}
                        </div>
                    )}

                    {/* Error / timeout / skipped banner. Only for non-success
                        terminal states. Renders before the output buffer so
                        the cause is the first thing seen. */}
                    {state.errorMessage && state.status !== 'running' && (
                        <div
                            role="alert"
                            className={cn(
                                'text-xs px-2 py-1.5 rounded',
                                state.status === 'error'
                                    ? 'bg-status-danger/10 text-status-danger'
                                    : state.status === 'timeout'
                                        ? 'bg-status-warning/10 text-status-warning'
                                        : 'bg-surface-sunken text-text-secondary'
                            )}
                        >
                            {state.errorMessage}
                        </div>
                    )}

                    {/* Output buffer. Hooks output markdown by convention.
                        For now we render preformatted text — same as the
                        OutputChannel. Future: route through the same
                        markdown renderer the assistant chat uses. */}
                    {state.outputBuffer && (
                        <pre className="text-xs whitespace-pre-wrap break-words font-mono text-text-primary max-h-96 overflow-auto">
                            {state.outputBuffer}
                        </pre>
                    )}

                    {/* Empty-state text when running with no output yet. */}
                    {!state.outputBuffer && state.status === 'running' && (
                        <div className="text-xs text-text-tertiary italic">
                            {t('hooks.fire_waiting_output')}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}