// webview-ui/src/views/diagnostics/DiagnosticsPanel.tsx
//
// PR P3.1 panel: surfaces the data from sessionDiagnostics +
// startupTiming for inspection and support-ticket export.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────┐
//   │ Diagnostics                          [Refresh] [×]      │
//   ├──────────────────────────────────────────────────────────┤
//   │ Sessions                                                 │
//   │  [▼ session picker]                                      │
//   ├──────────────────────────────────────────────────────────┤
//   │ Summary                                                  │
//   │  Started:  2026-05-04 14:32:11                           │
//   │  Duration: 4m 12s                                        │
//   │  Events:   23 LLM · 47 tool · 3 file write · 0 hook     │
//   │  Errors:   2                                             │
//   ├──────────────────────────────────────────────────────────┤
//   │ Tokens                                                   │
//   │  planner:   12.4k prompt · 3.1k completion (4 calls)    │
//   │  coder:     38.2k prompt · 8.9k completion (16 calls)   │
//   │  verifier:  4.8k  prompt · 0.6k completion (3 calls)    │
//   ├──────────────────────────────────────────────────────────┤
//   │ Timeline                                                 │
//   │  +0ms     [llm]  Plan task 1                             │
//   │  +1.2s    [tool] read_file src/foo.ts                    │
//   │  +1.5s    [llm]  Implement TASK-001                      │
//   │  ...                                                     │
//   ├──────────────────────────────────────────────────────────┤
//   │ Startup phases (host)                                    │
//   │  +0ms     activate.start                                 │
//   │  +47ms    activate.audit.done                            │
//   │  ...                                                     │
//   └──────────────────────────────────────────────────────────┘
//
// Copy-as-JSON button at the bottom puts the full bundle on the
// clipboard for support-ticket pasting. No file save — webviews
// don't have direct FS access; clipboard is the simplest path.

import { useTranslation } from 'react-i18next';
import {
    RefreshCw as IconRefresh,
    Clipboard as IconCopy,
    AlertTriangle as IconError,
} from 'lucide-react';
import { Panel } from '../../layout/Panel';
import { Pill } from '../../components/ui/Pill';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import type {
    UseDiagnosticsResult,
    AuditEventKind,
    AgentRole,
} from '../../state/useDiagnostics';

export interface DiagnosticsPanelProps {
    diagnostics: UseDiagnosticsResult;
    onClose: () => void;
}

/** Pill variant per audit kind — same visual language as the audit panel. */
const KIND_PILL: Record<AuditEventKind, 'secure' | 'info' | 'pending' | 'blocked' | 'running' | 'neutral'> = {
    llm_call:      'neutral',
    tool_call:     'info',
    file_write:    'secure',
    spec_edit:     'secure',
    config_change: 'pending',
    hook_fire:     'running',
};

/** Display label per agent role. Uses translation keys when present;
 *  the role itself is a fine fallback. */
function agentLabel(role: AgentRole, t: (key: string, defaultValue: string) => string): string {
    return t(`diagnostics.agent_${role}`, role);
}

/** Format a duration in ms as a compact string: "0ms" / "423ms" / "1.4s" / "2m 13s". */
function formatDuration(ms: number): string {
    if (ms < 1000) { return `${Math.round(ms)}ms`; }
    if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/** Format a token count: "1234" → "1.2k", "12345" → "12.3k", "1234567" → "1.23M". */
function formatTokens(n: number): string {
    if (n < 1000) { return n.toString(); }
    if (n < 1_000_000) { return `${(n / 1000).toFixed(1)}k`; }
    return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format an ISO timestamp into "YYYY-MM-DD HH:MM:SS" local time. */
function formatTimestamp(iso: string): string {
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) { return iso; }
        const pad = (n: number): string => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
        return iso;
    }
}

export function DiagnosticsPanel({ diagnostics, onClose }: DiagnosticsPanelProps) {
    const { t } = useTranslation();

    const handleCopyBundle = async () => {
        if (!diagnostics.bundle) { return; }
        try {
            const json = JSON.stringify(diagnostics.bundle, null, 2);
            await navigator.clipboard.writeText(json);
        } catch {
            // Clipboard API can fail in some contexts (older webviews,
            // permissions). Silently no-op rather than throw — the
            // user can still see the data in the panel.
        }
    };

    const handleRefresh = () => {
        diagnostics.refreshSessions();
        diagnostics.refreshTiming();
        if (diagnostics.selectedSessionId) {
            diagnostics.selectSession(diagnostics.selectedSessionId);
        }
    };

    return (
        <Panel
            title={t('diagnostics.title', 'Diagnostics')}
            onClose={onClose}
            actions={
                <Button
                    onClick={handleRefresh}
                    title={t('diagnostics.refresh_tooltip', 'Refresh sessions and timing data')}
                    aria-label={t('diagnostics.refresh_tooltip', 'Refresh')}
                    size="sm"
                    variant="secondary"
                >
                    <IconRefresh size={14} />
                    <span className="ml-1">{t('diagnostics.refresh', 'Refresh')}</span>
                </Button>
            }
        >
            <div className="overflow-y-auto">

                {/* ─── Session picker ─── */}
                <section className="px-3 py-3 border-t border-border-subtle">
                    <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                        {t('diagnostics.section_sessions', 'Sessions')}
                    </div>
                    {diagnostics.sessionsLoading ? (
                        <div className="text-sm text-text-tertiary">
                            {t('diagnostics.sessions_loading', 'Loading sessions…')}
                        </div>
                    ) : diagnostics.sessions.length === 0 ? (
                        <div className="text-sm text-text-tertiary">
                            {t('diagnostics.sessions_empty', 'No audit sessions recorded yet.')}
                        </div>
                    ) : (
                        <select
                            data-testid="diagnostics-session-picker"
                            className={cn(
                                'w-full px-2 py-1 text-sm rounded',
                                'bg-surface-sunken text-text-primary border border-border-subtle',
                                'focus:outline-none focus:ring-1 focus:ring-border-focus'
                            )}
                            value={diagnostics.selectedSessionId ?? ''}
                            onChange={(e) => diagnostics.selectSession(e.target.value || null)}
                        >
                            <option value="">
                                {t('diagnostics.session_pick_prompt', '— pick a session —')}
                            </option>
                            {diagnostics.sessions.map((s) => (
                                <option key={s.sessionId} value={s.sessionId}>
                                    {formatTimestamp(s.startedAt)} · {s.label}
                                </option>
                            ))}
                        </select>
                    )}
                </section>

                {/* ─── Bundle error ─── */}
                {diagnostics.bundleError && (
                    <div
                        role="alert"
                        className="mx-3 my-2 px-3 py-2 rounded bg-status-blocked-bg/10 text-status-blocked text-sm flex items-start gap-2"
                    >
                        <IconError size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <div>
                            <div className="font-medium">
                                {t('diagnostics.bundle_error_title', 'Failed to load session')}
                            </div>
                            <div className="text-xs mt-0.5">{diagnostics.bundleError}</div>
                        </div>
                    </div>
                )}

                {/* ─── Bundle loading ─── */}
                {diagnostics.bundleLoading && !diagnostics.bundle && (
                    <div className="px-3 py-3 text-sm text-text-tertiary">
                        {t('diagnostics.bundle_loading', 'Loading session details…')}
                    </div>
                )}

                {/* ─── Summary ─── */}
                {diagnostics.bundle && (
                    <section
                        data-testid="diagnostics-summary"
                        className="px-3 py-3 border-t border-border-subtle"
                    >
                        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                            {t('diagnostics.section_summary', 'Summary')}
                        </div>
                        <div className="space-y-1 text-sm">
                            <SummaryRow
                                label={t('diagnostics.summary_started', 'Started')}
                                value={formatTimestamp(diagnostics.bundle.summary.startedAt)}
                            />
                            <SummaryRow
                                label={t('diagnostics.summary_duration', 'Duration')}
                                value={formatDuration(diagnostics.bundle.summary.durationMs)}
                            />
                            <SummaryRow
                                label={t('diagnostics.summary_events', 'Events')}
                                value={
                                    Object.entries(diagnostics.bundle.summary.eventCounts)
                                        .filter(([, n]) => n > 0)
                                        .map(([k, n]) => `${n} ${k}`)
                                        .join(' · ') || '—'
                                }
                            />
                            {diagnostics.bundle.summary.statusCounts.error > 0 && (
                                <SummaryRow
                                    label={t('diagnostics.summary_errors', 'Errors')}
                                    value={String(diagnostics.bundle.summary.statusCounts.error)}
                                    valueClass="text-status-blocked font-medium"
                                />
                            )}
                        </div>
                    </section>
                )}

                {/* ─── Token breakdown ─── */}
                {diagnostics.bundle && diagnostics.bundle.summary.tokens.total.calls > 0 && (
                    <section
                        data-testid="diagnostics-tokens"
                        className="px-3 py-3 border-t border-border-subtle"
                    >
                        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                            {t('diagnostics.section_tokens', 'Tokens')}
                        </div>
                        <table className="w-full text-xs">
                            <tbody>
                                {(['planner', 'coder', 'verifier', 'hook', 'unknown'] as AgentRole[])
                                    .filter((role) => diagnostics.bundle!.summary.tokens.byAgent[role].calls > 0)
                                    .map((role) => {
                                        const stats = diagnostics.bundle!.summary.tokens.byAgent[role];
                                        return (
                                            <tr key={role} className="border-t border-border-subtle/50">
                                                <td className="py-1 pr-2 font-medium text-text-primary">
                                                    {agentLabel(role, t)}
                                                </td>
                                                <td className="py-1 pr-2 text-text-secondary tabular-nums">
                                                    {formatTokens(stats.prompt)} {t('diagnostics.tokens_prompt', 'prompt')}
                                                </td>
                                                <td className="py-1 pr-2 text-text-secondary tabular-nums">
                                                    {formatTokens(stats.completion)} {t('diagnostics.tokens_completion', 'completion')}
                                                </td>
                                                <td className="py-1 text-text-tertiary tabular-nums">
                                                    {stats.calls} {stats.calls === 1 ? t('diagnostics.tokens_call', 'call') : t('diagnostics.tokens_calls', 'calls')}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                <tr className="border-t border-border-default font-medium">
                                    <td className="py-1 pr-2 text-text-primary">
                                        {t('diagnostics.tokens_total', 'total')}
                                    </td>
                                    <td className="py-1 pr-2 text-text-primary tabular-nums">
                                        {formatTokens(diagnostics.bundle.summary.tokens.total.prompt)}
                                    </td>
                                    <td className="py-1 pr-2 text-text-primary tabular-nums">
                                        {formatTokens(diagnostics.bundle.summary.tokens.total.completion)}
                                    </td>
                                    <td className="py-1 text-text-tertiary tabular-nums">
                                        {diagnostics.bundle.summary.tokens.total.calls}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </section>
                )}

                {/* ─── Tool counts ─── */}
                {diagnostics.bundle &&
                    Object.keys(diagnostics.bundle.summary.toolCounts).length > 0 && (
                    <section
                        data-testid="diagnostics-tools"
                        className="px-3 py-3 border-t border-border-subtle"
                    >
                        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                            {t('diagnostics.section_tools', 'Tools')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {Object.entries(diagnostics.bundle.summary.toolCounts)
                                .sort((a, b) => b[1] - a[1])
                                .map(([tool, count]) => (
                                    <Pill key={tool} variant="info">
                                        <span className="font-mono">{tool}</span>
                                        <span className="ml-1 opacity-70 tabular-nums">×{count}</span>
                                    </Pill>
                                ))}
                        </div>
                    </section>
                )}

                {/* ─── Timeline ─── */}
                {diagnostics.bundle && diagnostics.bundle.timeline.length > 0 && (
                    <section
                        data-testid="diagnostics-timeline"
                        className="px-3 py-3 border-t border-border-subtle"
                    >
                        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                            {t('diagnostics.section_timeline', 'Timeline')}
                        </div>
                        <div className="space-y-1">
                            {diagnostics.bundle.timeline.map((entry) => (
                                <div
                                    key={entry.id}
                                    className="flex items-center gap-2 text-xs py-0.5"
                                >
                                    <span className="text-text-tertiary tabular-nums w-12 shrink-0 text-right">
                                        +{formatDuration(entry.elapsedMs)}
                                    </span>
                                    <Pill variant={KIND_PILL[entry.kind]}>
                                        {entry.kind === 'llm_call' && entry.inferredAgent
                                            ? entry.inferredAgent
                                            : entry.kind.replace('_', ' ')}
                                    </Pill>
                                    <span className="truncate text-text-primary flex-1 min-w-0">
                                        {entry.summary}
                                    </span>
                                    {entry.durationMs !== undefined && (
                                        <span className="text-text-tertiary tabular-nums shrink-0">
                                            {formatDuration(entry.durationMs)}
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {/* ─── Copy-bundle button ─── */}
                {diagnostics.bundle && (
                    <section className="px-3 py-3 border-t border-border-subtle">
                        <Button
                            onClick={handleCopyBundle}
                            variant="secondary"
                            size="sm"
                            title={t('diagnostics.copy_bundle_tooltip', 'Copy full session bundle as JSON for support tickets')}
                            data-testid="diagnostics-copy-bundle"
                        >
                            <IconCopy size={14} />
                            <span className="ml-1">
                                {t('diagnostics.copy_bundle', 'Copy bundle as JSON')}
                            </span>
                        </Button>
                    </section>
                )}

                {/* ─── Startup timing (host) ─── */}
                {diagnostics.timingRelative.length > 0 && (
                    <section
                        data-testid="diagnostics-timing"
                        className="px-3 py-3 border-t border-border-subtle"
                    >
                        <div className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
                            {t('diagnostics.section_timing', 'Startup phases (host)')}
                        </div>
                        <div className="space-y-0.5">
                            {diagnostics.timingRelative.map((m, i) => (
                                <div key={`${m.name}-${i}`} className="flex gap-2 text-xs">
                                    <span className="text-text-tertiary tabular-nums w-12 shrink-0 text-right">
                                        +{formatDuration(m.sinceStartMs)}
                                    </span>
                                    <span className="font-mono text-text-primary">{m.name}</span>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

            </div>
        </Panel>
    );
}

/** One label/value row in the summary section. */
function SummaryRow({
    label,
    value,
    valueClass,
}: {
    label: string;
    value: string;
    valueClass?: string;
}) {
    return (
        <div className="flex gap-2">
            <span className="text-text-tertiary w-20 shrink-0">{label}</span>
            <span className={cn('text-text-primary', valueClass)}>{value}</span>
        </div>
    );
}