// webview-ui/src/views/audit/AuditLogPanel.tsx
//
// Renders the audit log records as a scrollable list of rows. The list
// is the live view of an append-only, hash-chained log written by the
// host (.nexus/audit/audit-YYYY-MM-DD.jsonl). This component is
// purely presentational — useAuditLog provides the data, this just
// renders it.
//
// Visual structure per row:
//
//   ┌─────────────────────────────────────────────┐
//   │ [pill] summary                       12:34  │
//   │        actor · sessionId                    │
//   └─────────────────────────────────────────────┘
//
// The pill kind→color mapping:
//   - llm_call      → neutral (informational, not security-relevant)
//   - tool_call     → info    (agent action, observable)
//   - file_write    → secure  (concrete change, post-verification)
//   - spec_edit     → secure  (compliance-relevant, deliberate)
//   - config_change → pending (notable, may want review)
//
// Header subtitle shows "{N} entries · chain valid" or "chain broken"
// — the chain status comes from useAuditLog's chainValid flag.

import { useTranslation } from 'react-i18next';
import {
    FileEdit as IconFileWrite,
    Brain as IconLlm,
    Wrench as IconTool,
    FileText as IconSpec,
    Settings as IconConfig,
    ShieldCheck as IconChainOk,
    ShieldAlert as IconChainBroken,
    Trash2 as IconClear
} from 'lucide-react';
import { Panel } from '../../layout/Panel';
import { Pill } from '../../components/ui/Pill';
import { IconButton } from '../../components/ui/IconButton';
import { cn } from '../../components/ui/cn';
import type { AuditRecord, UseAuditLogResult } from '../../state/useAuditLog';

export interface AuditLogPanelProps {
    audit: UseAuditLogResult;
    onClose: () => void;
}

/** Kind → icon. Each event kind gets a distinct icon for quick scanning. */
const KIND_ICON: Record<AuditRecord['kind'], typeof IconLlm> = {
    llm_call:      IconLlm,
    tool_call:     IconTool,
    file_write:    IconFileWrite,
    spec_edit:     IconSpec,
    config_change: IconConfig
};

/** Kind → Pill variant. Color ramp matches the security strip. */
const KIND_VARIANT: Record<
    AuditRecord['kind'],
    'secure' | 'info' | 'pending' | 'neutral'
> = {
    llm_call:      'neutral',
    tool_call:     'info',
    file_write:    'secure',
    spec_edit:     'secure',
    config_change: 'pending'
};

/** Kind → display label. Short for pill, no truncation. */
const KIND_LABEL: Record<AuditRecord['kind'], string> = {
    llm_call:      'llm',
    tool_call:     'tool',
    file_write:    'file',
    spec_edit:     'spec',
    config_change: 'config'
};

export function AuditLogPanel({ audit, onClose }: AuditLogPanelProps) {
    const { t } = useTranslation();
    const { records, chainValid, totalSeen, reset } = audit;

    const subtitle = chainValid
        ? `${totalSeen} ${t('audit.entries') || 'entries'} · ${t('audit.chain_valid') || 'chain valid'}`
        : `${totalSeen} ${t('audit.entries') || 'entries'} · ${t('audit.chain_broken') || 'chain broken'}`;

    return (
        <Panel
            title={t('audit.title') || 'Audit log'}
            subtitle={subtitle}
            onClose={onClose}
            closeLabel={t('audit.close') || 'Close audit panel'}
            actions={
                records.length > 0 && (
                    <IconButton
                        aria-label={t('audit.clear') || 'Clear audit panel'}
                        variant="ghost"
                        size="sm"
                        onClick={reset}
                        title={t('audit.clear_tooltip') || 'Clear panel (disk log unaffected)'}
                    >
                        <IconClear size={13} />
                    </IconButton>
                )
            }
        >
            {/* Chain-status banner: red on broken chain. Sits at the top
                of the body so the user can't miss it if tampering is
                detected. The host writes records with valid hashes by
                construction, so a broken chain in normal operation
                indicates either a bug or live tampering — either way,
                worth flagging loudly. */}
            {!chainValid && (
                <div
                    role="alert"
                    className={cn(
                        'flex items-start gap-2',
                        'px-3 py-2',
                        'bg-status-blocked-bg border-b border-status-blocked/30',
                        'text-xs text-status-blocked'
                    )}
                >
                    <IconChainBroken size={13} className="shrink-0 mt-0.5" />
                    <span className="leading-relaxed">
                        {t('audit.chain_broken_warning') ||
                            'Hash chain integrity check failed. Investigate the on-disk log immediately.'}
                    </span>
                </div>
            )}

            {records.length === 0 ? (
                <EmptyState />
            ) : (
                <ul className="m-0 p-0 list-none">
                    {/* Show newest first — agents emit a few events per
                        action and most-recent-first is what the user
                        wants when watching a session unfold. */}
                    {[...records].reverse().map((record) => (
                        <AuditRow key={record.id} record={record} />
                    ))}
                </ul>
            )}
        </Panel>
    );
}

// ─── empty state ─────────────────────────────────────────────────────

function EmptyState() {
    const { t } = useTranslation();
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center gap-2',
                'px-6 py-12',
                'text-center text-text-tertiary'
            )}
        >
            <IconChainOk size={20} className="text-text-tertiary/60" />
            <p className="text-sm m-0">
                {t('audit.empty_title') || 'No activity yet'}
            </p>
            <p className="text-xs m-0 max-w-prose leading-relaxed">
                {t('audit.empty_hint') ||
                    'When the agent runs tools, edits files, or invokes the LLM, those events appear here. The on-disk log at .nexus/audit/ records everything for compliance.'}
            </p>
        </div>
    );
}

// ─── row ─────────────────────────────────────────────────────────────

function AuditRow({ record }: { record: AuditRecord }) {
    const Icon = KIND_ICON[record.kind];
    const variant = KIND_VARIANT[record.kind];
    const label = KIND_LABEL[record.kind];

    // Format timestamp as "HH:MM" (24h, local time). Full ISO string
    // is in the title attribute for hover. Timezone matters for
    // compliance, but the row is too narrow for the full string.
    const time = formatTime(record.timestamp);

    return (
        <li
            className={cn(
                'flex flex-col gap-1',
                'px-3 py-2',
                'border-b border-border-subtle last:border-b-0',
                'hover:bg-surface-sunken/50',
                'transition-colors duration-(--animate-duration-fast)'
            )}
        >
            <div className="flex items-start gap-2">
                <Pill variant={variant} className="text-[10px] font-mono shrink-0 mt-0.5">
                    <Icon size={10} className="mr-1" />
                    {label}
                </Pill>
                <span className="flex-1 min-w-0 text-xs text-text-primary leading-relaxed break-words">
                    {record.summary}
                </span>
                <span
                    title={record.timestamp}
                    className="shrink-0 text-[10px] text-text-tertiary font-mono tabular-nums tracking-tight pt-0.5"
                >
                    {time}
                </span>
            </div>
            <div className="flex items-center gap-2 pl-[42px] text-[10px] text-text-tertiary font-mono">
                <span className="truncate" title={record.actor}>
                    {record.actor}
                </span>
                <span aria-hidden="true">·</span>
                <span
                    className="truncate"
                    title={`session: ${record.sessionId} · prevHash: ${record.prevHash.substring(0, 12)}…`}
                >
                    {record.sessionId.substring(0, 8)}
                </span>
            </div>
        </li>
    );
}

// ─── helpers ─────────────────────────────────────────────────────────

/** Format an ISO timestamp as HH:MM in the local timezone. Defensive
 *  against malformed timestamps — falls back to the raw string rather
 *  than crashing the row. */
function formatTime(isoTimestamp: string): string {
    try {
        const d = new Date(isoTimestamp);
        if (Number.isNaN(d.getTime())) return isoTimestamp.substring(11, 16);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    } catch {
        return isoTimestamp.substring(11, 16);
    }
}