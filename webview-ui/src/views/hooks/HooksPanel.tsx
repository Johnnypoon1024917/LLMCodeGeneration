// webview-ui/src/views/hooks/HooksPanel.tsx
//
// Renders the hooks list as a scrollable panel of cards. Plugs into
// the same Panel chrome as the AuditLogPanel (PR 2.4). Each card
// shows:
//
//   ┌──────────────────────────────────────────────────┐
//   │ name                                  [▶] [○/●]  │
//   │ description (one line, ellipsized)               │
//   │ [trigger pill]  last fired 12:34                 │
//   └──────────────────────────────────────────────────┘
//
// The toggle (○/●) flips the .md file's frontmatter `enabled:` field
// via the host. The play (▶) button runs the hook now, outside its
// trigger. Both round-trip through the host — see useHooks.ts.
//
// Why no inline editor here:
//   The hook prompt lives in the markdown body of the .md file.
//   Editing it in a webview textarea would mean redoing all the
//   monaco-editor wiring inside our CSP-locked iframe. We instead
//   show an "Open in editor" affordance per card that opens the file
//   in VS Code's main editor (where syntax highlighting, monaco
//   features, etc. all work). The ".md as code" approach also makes
//   hooks Git-versionable, code-reviewable, and copy-pasteable.

import { useTranslation } from 'react-i18next';
import {
    FileEdit as IconOpen,
    Play as IconPlay,
    Loader as IconLoading,
    Save as IconSave,
    Terminal as IconCmd,
    Clock as IconClock
} from 'lucide-react';
import { Panel } from '../../layout/Panel';
import { Pill } from '../../components/ui/Pill';
import { Switch } from '../../components/ui/Switch';
import { IconButton } from '../../components/ui/IconButton';
import { cn } from '../../components/ui/cn';
import type { HookSummary, UseHooksResult } from '../../state/useHooks';

export interface HooksPanelProps {
    hooks: UseHooksResult;
    onClose: () => void;
    /** Called when the user clicks "open in editor" for a hook. The
     *  parent posts an 'openHookFile' message to the host with the
     *  hook id. The host resolves to the actual .md path and opens it
     *  in the main editor. */
    onOpenHook: (id: string) => void;
}

const TRIGGER_ICON = {
    onFileSave: IconSave,
    onCommand:  IconCmd,
    onSchedule: IconClock
} as const;

const TRIGGER_VARIANT = {
    onFileSave: 'info',
    onCommand:  'neutral',
    onSchedule: 'pending'
} as const;

export function HooksPanel({ hooks, onClose, onOpenHook }: HooksPanelProps) {
    const { t } = useTranslation();
    const { hooks: hookList, loading, toggleHook, runHook } = hooks;

    const subtitle = loading
        ? t('hooks.loading') || 'Loading hooks…'
        : `${hookList.length} ${
              hookList.length === 1
                  ? t('hooks.hook_singular') || 'hook'
                  : t('hooks.hook_plural') || 'hooks'
          } · ${hookList.filter((h) => h.enabled).length} ${
              t('hooks.enabled_label') || 'enabled'
          }`;

    return (
        <Panel
            title={t('hooks.title') || 'Hooks'}
            subtitle={subtitle}
            onClose={onClose}
            closeLabel={t('hooks.close') || 'Close hooks panel'}
        >
            {loading ? (
                <LoadingState />
            ) : hookList.length === 0 ? (
                <EmptyState />
            ) : (
                <ul className="m-0 p-0 list-none">
                    {hookList.map((hook) => (
                        <HookRow
                            key={hook.id}
                            hook={hook}
                            onToggle={(enabled) => toggleHook(hook.id, enabled)}
                            onRun={() => runHook(hook.id)}
                            onOpen={() => onOpenHook(hook.id)}
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
                {t('hooks.loading') || 'Loading hooks…'}
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
            <IconSave size={20} className="text-text-tertiary/60" />
            <p className="text-sm m-0">
                {t('hooks.empty_title') || 'No hooks yet'}
            </p>
            <p className="text-xs m-0 max-w-prose leading-relaxed">
                {t('hooks.empty_hint') ||
                    'Hooks fire prompts on file saves, commands, or schedules. Create a markdown file at .nexus/hooks/<name>.md to add one.'}
            </p>
        </div>
    );
}

// ─── row ─────────────────────────────────────────────────────────────

function HookRow({
    hook,
    onToggle,
    onRun,
    onOpen
}: {
    hook: HookSummary;
    onToggle: (enabled: boolean) => void;
    onRun: () => void;
    onOpen: () => void;
}) {
    const { t } = useTranslation();
    const TriggerIcon = TRIGGER_ICON[hook.triggerType];
    const variant = TRIGGER_VARIANT[hook.triggerType];

    return (
        <li
            className={cn(
                'flex flex-col gap-2',
                'px-3 py-3',
                'border-b border-border-subtle last:border-b-0',
                'transition-colors duration-(--animate-duration-fast)',
                hook.enabled ? 'bg-surface-base' : 'bg-surface-sunken/40 opacity-70'
            )}
        >
            {/* Header row: name + actions */}
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        'flex-1 min-w-0 text-sm font-medium truncate',
                        hook.enabled ? 'text-text-primary' : 'text-text-secondary'
                    )}
                    title={hook.id}
                >
                    {hook.name}
                </span>

                {/* Action cluster: open / run / toggle */}
                <div className="flex items-center gap-1 shrink-0">
                    <IconButton
                        aria-label={t('hooks.open_in_editor') || 'Open in editor'}
                        title={t('hooks.open_in_editor') || 'Open in editor'}
                        variant="ghost"
                        size="sm"
                        onClick={onOpen}
                    >
                        <IconOpen size={13} />
                    </IconButton>

                    <IconButton
                        aria-label={t('hooks.run_now') || 'Run hook now'}
                        title={t('hooks.run_now') || 'Run hook now'}
                        variant="ghost"
                        size="sm"
                        onClick={onRun}
                        disabled={hook.inflight || !hook.enabled}
                    >
                        {hook.inflight ? (
                            <IconLoading size={13} className="animate-spin" />
                        ) : (
                            <IconPlay size={13} />
                        )}
                    </IconButton>

                    <Switch
                        checked={hook.enabled}
                        onCheckedChange={onToggle}
                        aria-label={
                            hook.enabled
                                ? t('hooks.disable') || 'Disable hook'
                                : t('hooks.enable') || 'Enable hook'
                        }
                    />
                </div>
            </div>

            {/* Description (optional) */}
            {hook.description && (
                <p className="m-0 text-xs text-text-secondary leading-relaxed line-clamp-2">
                    {hook.description}
                </p>
            )}

            {/* Footer row: trigger pill + last fired */}
            <div className="flex items-center gap-2 text-[10px]">
                <Pill variant={variant} className="font-mono">
                    <TriggerIcon size={10} className="mr-1" />
                    {hook.triggerSummary}
                </Pill>
                {hook.lastFiredAt && (
                    <span className="text-text-tertiary font-mono tabular-nums">
                        {t('hooks.last_fired') || 'last fired'} {formatTime(hook.lastFiredAt)}
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