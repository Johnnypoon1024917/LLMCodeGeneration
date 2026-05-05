// webview-ui/src/layout/SecurityStrip.tsx
//
// Persistent top bar showing the security gate status. The
// "unforgettable element" of the redesign — visible on every screen,
// every state. No competitor has this.
//
// Data flow (PR 1.3):
//   - Receives a SecurityStatus prop derived in App.tsx where the
//     existing audit-fix state lives (securityBanner,
//     pendingBashApproval, securityGateDisabled).
//   - PR 2.x: when App.tsx is decomposed, this state moves into a
//     useSecurityStatus() hook. The component contract here doesn't
//     change; just the data source.
//
// Visually:
//   - Pills are 11px text, dot prefix, color-coded by status token.
//   - Dividers are 1px vertical hairlines, --nx-border-subtle.
//   - Right side shows model assignments and workspace name in muted
//     text, font-variant-numeric: tabular-nums for stability.
//
// On narrow widths (sidebar mode, ~380px) the strip would overflow.
// Sprint 2 will add a "compact" mode that drops the right-side meta
// and shows only the gate pills. For now we let it scroll horizontally
// — acceptable in PR 1.3 because the panel-mode (1100px+) is the
// primary demo viewport.

import { useTranslation } from 'react-i18next';
import { Pill, Tooltip, cn } from '../components/ui';

export interface SecurityStatus {
    /** Static command-pattern denylist is active. Today: always true
     *  (compiled in, can't be toggled without code change). */
    denylistActive: boolean;
    /** LLM Security Monitor reachable. False after a
     *  `securityMonitorUnavailable` message until the user retries
     *  or disables the gate. */
    monitorOnline: boolean;
    /** Confirm-on-bash policy active. False when the user disabled
     *  the gate for this session via the banner's "Disable for
     *  session" button (mirrors host-side _securityGateEnabled). */
    confirmOnBash: boolean;
    /** A bash_exec command is currently waiting on user click.
     *  Pre-empts the confirmOnBash display in the strip. */
    awaitingApproval: boolean;
    /** Hash chain integrity verified. Today: always true; PR 2.4
     *  will derive from real audit-log validity events. */
    auditChainValid: boolean;
    /** Optional model assignments for display in the right meta. */
    coderModel?: string;
    plannerModel?: string;
    /** Workspace identifier. Optional. */
    workspaceName?: string;
}

interface SecurityStripProps {
    status: SecurityStatus;
}

export function SecurityStrip({ status }: SecurityStripProps) {
    const { t } = useTranslation();

    return (
        <Tooltip.Provider delayDuration={300}>
            <header
                role="status"
                aria-label={t('security_strip.aria_label', 'Security posture')}
                className={cn(
                    'flex items-center gap-4',
                    'px-4 h-9',
                    'bg-surface-raised border-b border-border-subtle',
                    'overflow-x-auto whitespace-nowrap',
                    'text-xs'
                )}
                style={{ gridArea: 'security' }}
            >
                <StripGroup>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <span>
                                <Pill
                                    variant={status.denylistActive ? 'secure' : 'blocked'}
                                    showDot
                                    className="bg-transparent px-0"
                                >
                                    {t('security_strip.denylist', 'Denylist active')}
                                </Pill>
                            </span>
                        </Tooltip.Trigger>
                        <Tooltip.Content side="bottom">
                            {t(
                                'security_strip.denylist_tooltip',
                                'Static regex denylist runs before the LLM judge. Catches rm -rf /, fork bombs, curl|sh patterns.'
                            )}
                        </Tooltip.Content>
                    </Tooltip.Root>
                </StripGroup>

                <Divider />

                <StripGroup>
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <span>
                                <Pill
                                    variant={status.monitorOnline ? 'secure' : 'blocked'}
                                    showDot
                                    className="bg-transparent px-0"
                                >
                                    {status.monitorOnline
                                        ? t('security_strip.monitor_online', 'Monitor online')
                                        : t('security_strip.monitor_offline', 'Monitor offline')}
                                </Pill>
                            </span>
                        </Tooltip.Trigger>
                        <Tooltip.Content side="bottom">
                            {t(
                                'security_strip.monitor_tooltip',
                                'LLM Security Monitor reviews every bash_exec command before user confirmation.'
                            )}
                        </Tooltip.Content>
                    </Tooltip.Root>
                </StripGroup>

                <Divider />

                <StripGroup>
                    <Pill
                        variant={
                            status.awaitingApproval
                                ? 'pending'
                                : status.confirmOnBash
                                  ? 'secure'
                                  : 'pending'
                        }
                        showDot
                        className="bg-transparent px-0"
                    >
                        {status.awaitingApproval
                            ? t('security_strip.awaiting_approval', 'Awaiting approval')
                            : status.confirmOnBash
                              ? t('security_strip.confirm_on_bash', 'Confirm on bash')
                              : t('security_strip.autopilot', 'Autopilot')}
                    </Pill>
                </StripGroup>

                <Divider />

                <StripGroup>
                    <Pill
                        variant={status.auditChainValid ? 'secure' : 'blocked'}
                        showDot
                        className="bg-transparent px-0"
                    >
                        {t('security_strip.audit_chain', 'Audit chain valid')}
                    </Pill>
                </StripGroup>

                {/* Right-side meta. Muted color, tabular-nums. */}
                <div className="flex-1" />

                {status.coderModel && (
                    <>
                        <span className="text-text-tertiary tabular-nums">
                            {t('security_strip.coder_model', 'Coder')}: {status.coderModel}
                        </span>
                        <Divider />
                    </>
                )}
                {status.plannerModel && (
                    <>
                        <span className="text-text-tertiary tabular-nums">
                            {t('security_strip.planner_model', 'Planner')}: {status.plannerModel}
                        </span>
                        <Divider />
                    </>
                )}
                {status.workspaceName && (
                    <span className="text-text-tertiary tabular-nums">
                        {status.workspaceName}
                    </span>
                )}
            </header>
        </Tooltip.Provider>
    );
}

function StripGroup({ children }: { children: React.ReactNode }) {
    return <div className="flex items-center gap-2 text-text-secondary">{children}</div>;
}

function Divider() {
    return <span aria-hidden="true" className="w-px h-4 bg-border-subtle" />;
}