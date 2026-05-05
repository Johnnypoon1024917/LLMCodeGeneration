// webview-ui/src/components/ToolCallCard.tsx
//
// Component 2B-4: shell for tool-call cards. Per Q2=2B (mid-rich
// Cursor-style), the shell is the same across all 10 tool variants:
//
//   ┌─ [icon] tool_name(...args summary)            [status] [⌄] ┐
//   │                                                            │
//   │  [body — varies by archetype]                              │
//   │                                                            │
//   └─ [duration] [outcome chip]                                  ┘
//
// Body strategies (one per archetype):
//   - InformationalBody: read_file / list_directory / search_codebase
//   - DiffBody: write_file / edit_file
//   - ExecutableBody: bash_exec / run_tests / install_package /
//     git_commit
//   - NetworkBody: web_fetch
//
// State source: webview-ui/src/toolEvents.ts ToolCallState. The card
// is purely presentational — all state mutation happens in App.tsx's
// reducer when toolCallEvent messages arrive.
//
// Lifecycle visuals:
//   - status='running' → spinner icon, body shows output buffer if any
//   - status='success' → green check, duration in header, body shows result
//   - status='error' → red X, body shows error message
//   - status='cancelled' → grey slash, "cancelled" label
//
// PR 2.2 (Sprint 2): visual overhaul. Shell rewritten using the
// Card primitive + Pill for status + design tokens. Logic preserved
// verbatim — iconForTool, summarizeArgs, STATUS_CONFIG, formatDuration,
// bodyForTool, GenericFallbackBody all unchanged. The applyToolEvent
// state reducer (in toolEvents.ts) is untouched, so the
// applyToolEvent.test.ts suite continues to pass without changes.

import React, { useState } from 'react';
import {
    FileText as IconRead,
    FolderOpen as IconList,
    Search as IconSearch,
    FilePlus as IconWrite,
    FileEdit as IconEdit,
    Terminal as IconBash,
    Beaker as IconTest,
    Package as IconPackage,
    GitCommit as IconCommit,
    Globe as IconWeb,
    HelpCircle as IconUnknown,
    Loader2 as IconLoader,
    CheckCircle as IconCheck,
    XCircle as IconError,
    SlashSquare as IconCancelled,
    ChevronDown as IconChevronDown,
    ChevronRight as IconChevronRight
} from 'lucide-react';
import type { ToolCallState } from '../toolEvents';
import { cn } from './ui/cn';
import { InformationalBody } from './toolCardBodies/InformationalBody';
import { DiffBody } from './toolCardBodies/DiffBody';
import { ExecutableBody } from './toolCardBodies/ExecutableBody';
import { NetworkBody } from './toolCardBodies/NetworkBody';
import { BodyEmpty, BodyFallbackPre } from './toolCardBodies/shared';

export interface ToolCallCardProps {
    state: ToolCallState;
    /** Initial collapsed state. Default: collapsed for completed
     *  successful calls (preserve chat compactness), expanded for
     *  running/errored calls (so user sees what's happening). */
    defaultExpanded?: boolean;
}

/** Map tool name → icon. Unknown tools get a generic placeholder. */
function iconForTool(name: string): typeof IconRead {
    switch (name) {
        case 'read_file':       return IconRead;
        case 'list_directory':  return IconList;
        case 'search_codebase': return IconSearch;
        case 'write_file':      return IconWrite;
        case 'edit_file':       return IconEdit;
        case 'bash_exec':       return IconBash;
        case 'run_tests':       return IconTest;
        case 'install_package': return IconPackage;
        case 'git_commit':      return IconCommit;
        case 'web_fetch':       return IconWeb;
        default:                return IconUnknown;
    }
}

/**
 * Build a one-line summary of args for the card header. Each tool has
 * a different "primary" arg worth surfacing:
 *
 *   read_file('src/x.ts')       — show the filepath
 *   list_directory('src/')      — show the dirpath
 *   search_codebase('AuthGuard')— show the keyword
 *   write_file('src/x.ts', ...) — show the filepath, hide content
 *   bash_exec('npm test')       — show the command (truncated)
 *
 * Truncate to 60 chars to keep header tidy. The full args are still
 * accessible by expanding the card.
 */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
    const truncate = (s: string, n: number = 60): string =>
        s.length <= n ? s : s.substring(0, n - 1) + '…';

    switch (name) {
        case 'read_file':       return `'${truncate(String(args['filepath'] ?? ''))}'`;
        case 'list_directory':  return `'${truncate(String(args['dirpath'] ?? ''))}'`;
        case 'search_codebase': return `'${truncate(String(args['keyword'] ?? ''))}'`;
        case 'write_file':
        case 'edit_file':       return `'${truncate(String(args['filepath'] ?? ''))}'`;
        case 'bash_exec':       return `${truncate(String(args['command'] ?? ''))}`;
        case 'run_tests': {
            const filter = args['testFilter'];
            return filter ? `filter: ${truncate(String(filter))}` : '';
        }
        case 'install_package': return `${truncate(String(args['packageName'] ?? ''))}${args['dev'] ? ' (dev)' : ''}`;
        case 'git_commit':      return `'${truncate(String(args['message'] ?? ''))}'`;
        case 'web_fetch':       return `${truncate(String(args['url'] ?? ''))}`;
        default:                return '';
    }
}

/** Status configuration: status text, the icon, and a Pill variant
 *  matching our design-token color ramp. The variant maps directly
 *  onto --nx-status-* so the colors align with the security strip. */
const STATUS_CONFIG = {
    running:   { Icon: IconLoader,    label: 'running',   pill: 'running' as const,  color: 'text-status-running' },
    success:   { Icon: IconCheck,     label: 'done',      pill: 'secure'  as const,  color: 'text-status-secure'  },
    error:     { Icon: IconError,     label: 'error',     pill: 'blocked' as const,  color: 'text-status-blocked' },
    cancelled: { Icon: IconCancelled, label: 'cancelled', pill: 'neutral' as const,  color: 'text-text-tertiary'  }
} as const;

/**
 * Format duration as a human-readable string.
 *   < 1000ms   → "342ms"
 *   < 60000ms  → "4.2s"
 *   else       → "1m 23s"
 */
function formatDuration(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}

/** Border-color class per status. Applied as a left border on the
 *  card to give a quick at-a-glance status indicator without needing
 *  to read the pill text. */
const STATUS_BORDER: Record<ToolCallState['status'], string> = {
    running:   'border-l-2 border-l-status-running',
    success:   'border-l-2 border-l-status-secure',
    error:     'border-l-2 border-l-status-blocked',
    cancelled: 'border-l-2 border-l-text-tertiary/40'
};

export function ToolCallCard({ state, defaultExpanded }: ToolCallCardProps): React.ReactElement {
    // Default expansion: running and errored cards expanded so the user
    // sees them; completed-success cards collapsed for chat compactness.
    // Override via prop if needed.
    const initiallyExpanded = defaultExpanded ?? (
        state.status === 'running' || state.status === 'error'
    );
    const [expanded, setExpanded] = useState(initiallyExpanded);

    const cfg = STATUS_CONFIG[state.status];
    const ToolIcon = iconForTool(state.name);
    const StatusIcon = cfg.Icon;
    const isSpinner = state.status === 'running';
    const argSummary = summarizeArgs(state.name, state.args);

    const durationLabel = state.durationMs !== undefined
        ? formatDuration(state.durationMs)
        : null;

    return (
        <div
            data-status={state.status}
            className={cn(
                'mt-2 rounded-md',
                'bg-surface-raised border border-border-subtle',
                'overflow-hidden',
                STATUS_BORDER[state.status]
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
                <span aria-hidden="true" className="shrink-0 text-text-primary">
                    <ToolIcon size={14} />
                </span>
                <span className="font-mono text-sm text-text-primary truncate min-w-0 flex-1">
                    {state.name}
                    {argSummary && (
                        <span className="text-text-secondary ml-0.5">
                            ({argSummary})
                        </span>
                    )}
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
                    title={cfg.label}
                    className={cn('shrink-0 inline-flex items-center', cfg.color)}
                >
                    <StatusIcon size={14} className={isSpinner ? 'spin' : undefined} />
                </span>
            </div>

            {expanded && (
                <div className="border-t border-border-subtle bg-surface-base/40">
                    {/* Body strategy dispatch. Each archetype has its own
                        body component; they all consume the same
                        ToolCallState shape. */}
                    {bodyForTool(state)}
                </div>
            )}
        </div>
    );
}

/**
 * Pick the body component for a tool call based on its name. Each
 * tool maps to one of four archetypes:
 *
 *   - Informational: read_file / list_directory / search_codebase
 *     → InformationalBody (file_contents / directory / search_matches payloads)
 *   - Modification: write_file / edit_file
 *     → DiffBody (diff payload)
 *   - Executable: bash_exec / run_tests / install_package / git_commit
 *     → ExecutableBody (bash_output payload, streaming deltas via outputBuffer)
 *   - Network: web_fetch
 *     → NetworkBody (string payload parsed for URL + status + body)
 *
 * The GenericFallbackBody path is kept for forward-compat: an audit
 * log replay or a newer extension version could surface a tool the
 * webview doesn't recognize. Better to render the llmContent as
 * preformatted text than to crash or render nothing.
 */
function bodyForTool(state: ToolCallState): React.ReactElement {
    switch (state.name) {
        case 'read_file':
        case 'list_directory':
        case 'search_codebase':
            return <InformationalBody state={state} />;
        case 'write_file':
        case 'edit_file':
            return <DiffBody state={state} />;
        case 'bash_exec':
        case 'run_tests':
        case 'install_package':
        case 'git_commit':
            return <ExecutableBody state={state} />;
        case 'web_fetch':
            return <NetworkBody state={state} />;
        default:
            return <GenericFallbackBody state={state} />;
    }
}

/**
 * Forward-compat fallback. As of 2B-4d, every tool in the Q1=1C
 * catalog has a dedicated archetype, so this body should never
 * render under normal operation. Kept because:
 *   - Audit-log replay may surface tools that have since been removed
 *     from the catalog
 *   - A newer extension may add a tool the webview build doesn't
 *     yet recognize (until the bundled webview catches up)
 *   - Defensive behavior is better than a blank/crashing card
 */
function GenericFallbackBody({ state }: { state: ToolCallState }): React.ReactElement {
    const content = state.result?.llmContent ?? state.outputBuffer ?? '';
    if (!content) {
        return (
            <BodyEmpty>
                {state.status === 'running' ? '(running…)' : '(no output)'}
            </BodyEmpty>
        );
    }
    return <BodyFallbackPre>{content}</BodyFallbackPre>;
}