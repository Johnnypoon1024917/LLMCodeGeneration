// webview-ui/src/views/steering/SteeringPanel.tsx
//
// Renders the steering files list. Each row shows a steering file
// (whether existing or one of the canonical three that hasn't been
// created yet). Layout:
//
//   ┌──────────────────────────────────────────────────┐
//   │ Product                                  [edit]  │
//   │ What you're building, who it's for               │
//   │ [canonical]  modified 12:34                      │
//   └──────────────────────────────────────────────────┘
//
//   ┌──────────────────────────────────────────────────┐
//   │ Structure                                [+ create] │  ← missing
//   │ Folder layout & naming conventions               │
//   │ [canonical]                                      │
//   └──────────────────────────────────────────────────┘
//
// The 3 canonical files (Kiro convention) always appear, even if
// not yet created. Custom files appear if they exist. Missing
// canonical files get a one-click "create from template" button;
// existing files get an "open in editor" button.
//
// Why no inline editor: same reasoning as HooksPanel — markdown
// editing happens better in VS Code's main editor where monaco
// features (folding, find/replace, etc.) just work. The panel is
// a directory-and-status view, not an editor.

import { useTranslation } from 'react-i18next';
import {
    FileEdit as IconOpen,
    Plus as IconCreate,
    Loader as IconLoading,
    BookOpen as IconCanonical,
    FileText as IconCustom
} from 'lucide-react';
import { Panel } from '../../layout/Panel';
import { Pill } from '../../components/ui/Pill';
import { IconButton } from '../../components/ui/IconButton';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import type { SteeringSummary, UseSteeringResult } from '../../state/useSteering';

export interface SteeringPanelProps {
    steering: UseSteeringResult;
    onClose: () => void;
}

export function SteeringPanel({ steering, onClose }: SteeringPanelProps) {
    const { t } = useTranslation();
    const { items, loading, createSteeringFile, openSteeringFile } = steering;

    const existing = items.filter((it) => it.exists).length;
    const subtitle = loading
        ? t('steering.loading') || 'Loading steering rules…'
        : `${existing} ${t('steering.active') || 'active'} · ${items.length} ${t('steering.total') || 'total'}`;

    return (
        <Panel
            title={t('steering.title') || 'Steering rules'}
            subtitle={subtitle}
            onClose={onClose}
            closeLabel={t('steering.close') || 'Close steering panel'}
        >
            {loading ? (
                <LoadingState />
            ) : items.length === 0 ? (
                <EmptyState />
            ) : (
                <ul className="m-0 p-0 list-none">
                    {items.map((item) => (
                        <SteeringRow
                            key={item.id}
                            item={item}
                            onOpen={() => openSteeringFile(item.id)}
                            onCreate={() => createSteeringFile(item.id)}
                        />
                    ))}
                </ul>
            )}
        </Panel>
    );
}

// ─── states ──────────────────────────────────────────────────────────

function LoadingState() {
    const { t } = useTranslation();
    return (
        <div
            className={cn(
                'flex flex-col items-center justify-center gap-2',
                'px-6 py-12',
                'text-text-tertiary'
            )}
        >
            <IconLoading size={20} className="animate-spin" />
            <p className="text-sm m-0">
                {t('steering.loading') || 'Loading steering rules…'}
            </p>
        </div>
    );
}

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
            <IconCanonical size={20} className="text-text-tertiary/60" />
            <p className="text-sm m-0">
                {t('steering.empty_title') || 'No steering rules yet'}
            </p>
            <p className="text-xs m-0 max-w-prose leading-relaxed">
                {t('steering.empty_hint') ||
                    'Steering rules guide the agent across every task. Create one of the canonical files (product, structure, tech) or add your own .md file in .nexus/steering/.'}
            </p>
        </div>
    );
}

// ─── row ─────────────────────────────────────────────────────────────

function SteeringRow({
    item,
    onOpen,
    onCreate
}: {
    item: SteeringSummary;
    onOpen: () => void;
    onCreate: () => void;
}) {
    const { t } = useTranslation();
    const Icon = item.kind === 'canonical' ? IconCanonical : IconCustom;

    return (
        <li
            className={cn(
                'flex flex-col gap-2',
                'px-3 py-3',
                'border-b border-border-subtle last:border-b-0',
                'transition-colors duration-(--animate-duration-fast)',
                item.exists ? 'bg-surface-base' : 'bg-surface-sunken/40'
            )}
        >
            {/* Header row: name + action */}
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        'flex-1 min-w-0 text-sm font-medium truncate',
                        item.exists ? 'text-text-primary' : 'text-text-secondary'
                    )}
                    title={`.nexus/steering/${item.id}.md`}
                >
                    {item.name}
                </span>

                {/* Action: open if exists, create if missing. Different
                    visual weight — open is ghost (recurring action),
                    create is the primary CTA on missing files. */}
                {item.exists ? (
                    <IconButton
                        aria-label={t('steering.open_in_editor') || 'Open in editor'}
                        title={t('steering.open_in_editor') || 'Open in editor'}
                        variant="ghost"
                        size="sm"
                        onClick={onOpen}
                    >
                        <IconOpen size={13} />
                    </IconButton>
                ) : (
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={onCreate}
                        className="shrink-0"
                    >
                        <IconCreate size={13} />
                        {t('steering.create') || 'Create'}
                    </Button>
                )}
            </div>

            {/* Description (always shown if present) */}
            {item.description && (
                <p className="m-0 text-xs text-text-secondary leading-relaxed line-clamp-2">
                    {item.description}
                </p>
            )}

            {/* Footer: kind pill + modified time (existing files only) */}
            <div className="flex items-center gap-2 text-[10px]">
                <Pill
                    variant={item.kind === 'canonical' ? 'secure' : 'neutral'}
                    className="font-mono"
                >
                    <Icon size={10} className="mr-1" />
                    {item.kind === 'canonical'
                        ? t('steering.kind_canonical') || 'canonical'
                        : t('steering.kind_custom') || 'custom'}
                </Pill>
                {item.exists && item.lastModified && (
                    <span className="text-text-tertiary font-mono tabular-nums">
                        {t('steering.modified') || 'modified'} {formatTime(item.lastModified)}
                    </span>
                )}
                {!item.exists && (
                    <span className="text-text-tertiary font-mono italic">
                        {t('steering.not_created') || 'not created'}
                    </span>
                )}
            </div>
        </li>
    );
}

// ─── helpers ─────────────────────────────────────────────────────────

function formatTime(isoTimestamp: string): string {
    try {
        const d = new Date(isoTimestamp);
        if (Number.isNaN(d.getTime())) {
            return isoTimestamp.substring(11, 16);
        }
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    } catch {
        return isoTimestamp.substring(11, 16);
    }
}