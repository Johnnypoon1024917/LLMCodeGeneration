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
//     (this session)
//   - DiffBody: write_file / edit_file (deferred to 2B-4b)
//   - ExecutableBody: bash_exec / run_tests / install_package /
//     git_commit (deferred to 2B-4c — likely reuses existing CommandCard)
//   - NetworkBody: web_fetch (deferred to 2B-4d)
//
// State source: webview-ui/src/toolEvents.ts ToolCallState. The card
// is purely presentational — all state mutation happens in App.tsx's
// reducer when toolCallEvent messages arrive.
//
// Lifecycle visuals:
//   - status='running' → spinner icon, "running..." status, body shows
//     output buffer if any (for streaming tools)
//   - status='success' → green check, duration, body shows final result
//   - status='error' → red X, body shows error message
//   - status='cancelled' → grey slash, "cancelled" label

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
import { InformationalBody } from './toolCardBodies/InformationalBody';
import { DiffBody } from './toolCardBodies/DiffBody';
import { ExecutableBody } from './toolCardBodies/ExecutableBody';
import { NetworkBody } from './toolCardBodies/NetworkBody';

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

const STATUS_CONFIG = {
    running:   { color: 'var(--vscode-charts-orange, #cca700)', Icon: IconLoader,     label: 'running' },
    success:   { color: 'var(--nexus-success)',                Icon: IconCheck,      label: 'done' },
    error:     { color: 'var(--nexus-error)',                  Icon: IconError,      label: 'error' },
    cancelled: { color: 'var(--nexus-text-muted, #8b949e)',    Icon: IconCancelled,  label: 'cancelled' }
} as const;

/**
 * Format duration as a human-readable string.
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
        <div className="tool-call-card" data-status={state.status}>
            <div
                className="tool-call-card-header"
                onClick={() => setExpanded(e => !e)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpanded(x => !x);
                    }
                }}
                aria-expanded={expanded}
            >
                <span className="tool-call-card-chev" aria-hidden="true">
                    {expanded
                        ? <IconChevronDown size={12} />
                        : <IconChevronRight size={12} />}
                </span>
                <span className="tool-call-card-tool-icon" aria-hidden="true">
                    <ToolIcon size={14} />
                </span>
                <span className="tool-call-card-name">
                    {state.name}
                    {argSummary && <span className="tool-call-card-args">({argSummary})</span>}
                </span>
                {durationLabel && (
                    <span className="tool-call-card-duration" title="Duration">
                        {durationLabel}
                    </span>
                )}
                <span className="tool-call-card-status" style={{ color: cfg.color }} title={cfg.label}>
                    <StatusIcon size={14} className={isSpinner ? 'spin' : undefined} />
                </span>
            </div>

            {expanded && (
                <div className="tool-call-card-body">
                    {/* Body strategy dispatch. As more archetypes ship in
                        2B-4c/d, add cases to bodyForTool() below. */}
                    {bodyForTool(state)}
                </div>
            )}
        </div>
    );
}

/**
 * Pick the body component for a tool call based on its name. Each
 * tool maps to one of four archetypes (all four shipped as of 2B-4d):
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
        // All 10 tools in the Q1=1C catalog are covered by an archetype
        // as of 2B-4d. The default branch handles unknown tool names —
        // kept for forward-compat in case an audit-log replay or a
        // newer extension ships a tool the webview doesn't recognize.
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
            <div className="tool-call-card-empty">
                {state.status === 'running' ? '(running…)' : '(no output)'}
            </div>
        );
    }
    return (
        <pre className="tool-call-card-fallback-output" tabIndex={0}>
            {content}
        </pre>
    );
}