// webview-ui/src/layout/Rail.tsx
//
// Left vertical navigation. Replaces the old horizontal `.nexus-tabs`
// from App.tsx.
//
// Maps existing 4 routes (coder / builder / rules / Map) to the new
// icon set. Future routes (hooks / steering / audit / settings) have
// placeholder slots that route to existing tabs until Sprint 2-3 ships
// the proper views:
//   - Hooks → 'coder' (Sprint 3 PR 3.2 will give it its own route)
//   - Steering → 'rules' (Sprint 3 PR 3.3 promotes .nexusrules to a
//     multi-file editor)
//   - Audit log → 'coder' (Sprint 2 PR 2.4 adds the panel)
//   - Settings → opens a vscode command (existing flow)
//
// This way the Rail looks complete from PR 1.3 onward; it just
// gradually gets more functional as later PRs land.

import { Tooltip, IconButton, cn } from '../components/ui';
import { useTranslation } from 'react-i18next';

export type ViewRoute = 'coder' | 'builder' | 'rules' | 'Map' | 'timeline';

interface RailProps {
    activeRoute: ViewRoute;
    onRouteChange: (route: ViewRoute) => void;
    /** Settings click opens the VS Code settings command. */
    onSettingsClick?: () => void;
    /** Audit panel toggle handler (PR 2.4). When the audit button is
     *  clicked, the parent toggles its `usePanel` state. The button's
     *  visual active state is driven by `auditPanelOpen`. */
    onAuditClick?: () => void;
    /** True when the right-side audit panel is currently open. Used to
     *  highlight the audit button so the user can see at a glance which
     *  side panel is engaged. */
    auditPanelOpen?: boolean;
    /** PR 3.2: hooks panel toggle. Like onAuditClick but for the
     *  hooks library. The 'hooks' nav item in PRIMARY_NAV gets dual
     *  duty: clicking it changes the active main route AND opens the
     *  hooks side panel. (The right-panel panel and the main canvas
     *  view show different things — the panel is the library;
     *  the main canvas shows hook executions / output.) */
    onHooksClick?: () => void;
    /** True when the right-side hooks panel is currently open. */
    hooksPanelOpen?: boolean;
    /** PR 3.3: steering panel toggle. Same dual-duty pattern as
     *  onHooksClick — the 'steering' nav item changes route AND
     *  opens the steering panel. */
    onSteeringClick?: () => void;
    /** True when the right-side steering panel is currently open. */
    steeringPanelOpen?: boolean;
    /** P2.1: MCP servers panel toggle. Same pattern as steering. */
    onMcpClick?: () => void;
    /** True when the right-side MCP panel is currently open. */
    mcpPanelOpen?: boolean;
    /** P3.1 panel: diagnostics panel toggle. */
    onDiagnosticsClick?: () => void;
    /** True when the right-side diagnostics panel is currently open. */
    diagnosticsPanelOpen?: boolean;
}

interface NavItem {
    /** Stable id for keys + automation hooks. */
    id: string;
    /** i18n label key. */
    labelKey: string;
    /** SVG icon as a React element. We use inline SVG instead of an
     *  icon library here to keep the Rail bundle-light — the rail is
     *  the first thing that paints. */
    icon: React.ReactNode;
    /** Which existing route this maps to. Hooks/Steering/Audit map to
     *  coder/rules until their dedicated views ship. */
    route: ViewRoute;
    /** When true, displays a small "soon" dot. Used for the
     *  placeholder hooks/steering/audit slots so users see them coming
     *  but understand they're not yet wired. */
    placeholder?: boolean;
}

const PRIMARY_NAV: readonly NavItem[] = [
    {
        id: 'workspace',
        labelKey: 'nav.workspace',
        route: 'coder',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    },
    {
        id: 'specs',
        labelKey: 'nav.specs',
        route: 'builder',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" />
                <path d="M10 2v3h3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
        )
    },
    {
        id: 'hooks',
        labelKey: 'nav.hooks',
        route: 'coder', // Placeholder until PR 3.2.
        placeholder: true,
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 2v6a3 3 0 003 3h0a3 3 0 003-3V5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="13" r="1.3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
        )
    },
    {
        id: 'steering',
        labelKey: 'nav.steering',
        route: 'rules',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M8 4v4l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
        )
    },
    {
        id: 'map',
        labelKey: 'nav.map',
        route: 'Map',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="12" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="8" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5 5l2 6M11 5l-2 6" stroke="currentColor" strokeWidth="1.3" />
            </svg>
        )
    },
    {
        // P3.1: Timeline tab. Per-task retrospective showing tool
        // calls in order, attempt boundaries, verifier verdicts.
        // Reads the session event log on demand.
        id: 'timeline',
        labelKey: 'nav.timeline',
        route: 'timeline',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
                <path d="M8 4v4l2.5 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M2 8h1.5M12.5 8H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
        )
    }
];

const FOOTER_NAV: readonly Pick<NavItem, 'id' | 'labelKey' | 'icon'>[] = [
    {
        id: 'audit',
        labelKey: 'nav.audit',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 2h10v12H3z" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
        )
    },
    {
        // P2.1: MCP servers panel. Plug-shaped icon hints at "external
        // connection / pluggable tool". Lives in the footer cluster
        // alongside audit and settings — it's a settings-adjacent
        // utility, not a primary workflow tab.
        id: 'mcp',
        labelKey: 'nav.mcp',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 2v4M10 2v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M4 6h8v3a4 4 0 01-4 4 4 4 0 01-4-4V6z" stroke="currentColor" strokeWidth="1.3" />
                <path d="M8 13v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
        )
    },
    {
        // P3.1 panel: diagnostics — session telemetry, token breakdown,
        // startup timing. Bar-chart icon hints at "data + measurements".
        // Sits next to settings since it's a developer-facing utility,
        // not a primary workflow tab.
        id: 'diagnostics',
        labelKey: 'nav.diagnostics',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 14h12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <path d="M4 14V8M8 14V4M12 14V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    },
    {
        id: 'settings',
        labelKey: 'nav.settings',
        icon: (
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
                <path
                    d="M8 1v2M8 13v2M15 8h-2M3 8H1M12.95 3.05l-1.4 1.4M4.45 11.55l-1.4 1.4M12.95 12.95l-1.4-1.4M4.45 4.45L3.05 3.05"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                />
            </svg>
        )
    }
];

export function Rail({
    activeRoute,
    onRouteChange,
    onSettingsClick,
    onAuditClick,
    auditPanelOpen,
    onHooksClick,
    hooksPanelOpen,
    onSteeringClick,
    steeringPanelOpen,
    onMcpClick,
    mcpPanelOpen,
    onDiagnosticsClick,
    diagnosticsPanelOpen
}: RailProps) {
    const { t } = useTranslation();

    return (
        <Tooltip.Provider delayDuration={300}>
            <nav
                aria-label="Primary"
                className={cn(
                    'row-span-3 grid-area-rail',
                    'flex flex-col items-center gap-1',
                    'w-14 py-2',
                    'bg-surface-raised border-r border-border-subtle'
                )}
                style={{ gridArea: 'rail' }}
            >
                <RailLogo />

                {PRIMARY_NAV.map((item) => {
                    // PR 3.2/3.3: 'hooks' and 'steering' nav items have
                    // dual duty — change route AND open the matching
                    // right-side panel. Visual active = "either route
                    // OR panel" so the user always sees the relevant
                    // button highlighted regardless of which surface
                    // they're using.
                    const isHooks = item.id === 'hooks';
                    const isSteering = item.id === 'steering';
                    const isActive = isHooks
                        ? (activeRoute === item.route || hooksPanelOpen === true)
                        : isSteering
                            ? (activeRoute === item.route || steeringPanelOpen === true)
                            : (activeRoute === item.route);
                    return (
                        <RailButton
                            key={item.id}
                            item={item}
                            isActive={isActive}
                            onClick={() => {
                                onRouteChange(item.route);
                                if (isHooks) {
                                    onHooksClick?.();
                                }
                                if (isSteering) {
                                    onSteeringClick?.();
                                }
                            }}
                            labelText={t(item.labelKey, defaultLabel(item.id))}
                        />
                    );
                })}

                <div className="flex-1" />

                {FOOTER_NAV.map((item) => {
                    const isAudit = item.id === 'audit';
                    const isMcp = item.id === 'mcp';
                    const isDiagnostics = item.id === 'diagnostics';
                    // Active state: audit, MCP, and diagnostics each
                    // reflect their panel-open status. Settings is
                    // always inactive (opens the VS Code settings UI,
                    // not a panel).
                    const isActive =
                        (isAudit && auditPanelOpen === true) ||
                        (isMcp && mcpPanelOpen === true) ||
                        (isDiagnostics && diagnosticsPanelOpen === true);
                    // aria-pressed makes sense only for toggle-buttons
                    // (audit, mcp, diagnostics). Settings is a launcher.
                    const ariaPressed = isAudit
                        ? (auditPanelOpen ?? false)
                        : isMcp
                            ? (mcpPanelOpen ?? false)
                            : isDiagnostics
                                ? (diagnosticsPanelOpen ?? false)
                                : undefined;
                    return (
                        <Tooltip.Root key={item.id}>
                            <Tooltip.Trigger asChild>
                                <IconButton
                                    aria-label={t(item.labelKey, defaultLabel(item.id))}
                                    aria-pressed={ariaPressed}
                                    variant={isActive ? 'default' : 'ghost'}
                                    onClick={() => {
                                        if (item.id === 'settings') { onSettingsClick?.(); }
                                        if (item.id === 'audit') { onAuditClick?.(); }
                                        if (item.id === 'mcp') { onMcpClick?.(); }
                                        if (item.id === 'diagnostics') { onDiagnosticsClick?.(); }
                                    }}
                                >
                                    {item.icon}
                                </IconButton>
                            </Tooltip.Trigger>
                            <Tooltip.Content side="right">
                                {t(item.labelKey, defaultLabel(item.id))}
                            </Tooltip.Content>
                        </Tooltip.Root>
                    );
                })}
            </nav>
        </Tooltip.Provider>
    );
}

interface RailButtonProps {
    item: NavItem;
    isActive: boolean;
    onClick: () => void;
    labelText: string;
}

function RailButton({ item, isActive, onClick, labelText }: RailButtonProps) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger asChild>
                <button
                    type="button"
                    aria-label={labelText}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={onClick}
                    className={cn(
                        'relative w-9 h-9',
                        'flex items-center justify-center',
                        'rounded-sm border-0 bg-transparent cursor-pointer',
                        'transition-colors duration-(--animate-duration-fast)',
                        'outline-none',
                        'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised',
                        '[&>svg]:w-4 [&>svg]:h-4',
                        isActive
                            ? 'text-text-primary bg-accent-soft'
                            : 'text-text-secondary hover:bg-surface-sunken hover:text-text-primary'
                    )}
                >
                    {/* Active indicator: 2px accent stripe to the left of
                        the button. Sits in the rail's padding area. */}
                    {isActive && (
                        <span
                            aria-hidden="true"
                            className={cn(
                                'absolute -left-[10px] top-1/2 -translate-y-1/2',
                                'w-0.5 h-4.5 rounded-r-sm bg-accent'
                            )}
                        />
                    )}
                    {item.icon}
                    {item.placeholder && (
                        <span
                            aria-hidden="true"
                            className={cn(
                                'absolute top-1.5 right-1.5',
                                'w-1 h-1 rounded-full bg-status-pending'
                            )}
                            title="Coming soon"
                        />
                    )}
                </button>
            </Tooltip.Trigger>
            <Tooltip.Content side="right">
                {labelText}
                {item.placeholder && ' (soon)'}
            </Tooltip.Content>
        </Tooltip.Root>
    );
}

function RailLogo() {
    return (
        <div
            aria-label="NexusCode"
            className="w-8 h-8 flex items-center justify-center mb-2"
        >
            <svg viewBox="0 0 24 24" fill="none" className="w-5.5 h-5.5">
                <path
                    d="M12 2L21 7V17L12 22L3 17V7L12 2Z"
                    stroke="var(--nx-text-primary)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                />
                <path d="M12 7L17 9.5V14.5L12 17L7 14.5V9.5L12 7Z" fill="var(--nx-accent)" />
            </svg>
        </div>
    );
}

/** Fallback labels in case the i18n strings haven't been added yet —
 *  PR 1.3 includes them but old locales may not. Keeps the Rail
 *  functional even on a partial-locale state. */
function defaultLabel(id: string): string {
    switch (id) {
        case 'workspace': return 'Workspace';
        case 'specs': return 'Specs';
        case 'hooks': return 'Hooks';
        case 'steering': return 'Steering';
        case 'map': return 'Code map';
        case 'audit': return 'Audit log';
        case 'mcp': return 'MCP servers';
        case 'diagnostics': return 'Diagnostics';
        case 'settings': return 'Settings';
        default: return id;
    }
}