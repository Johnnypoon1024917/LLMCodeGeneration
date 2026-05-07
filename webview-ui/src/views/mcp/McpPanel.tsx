// webview-ui/src/views/mcp/McpPanel.tsx
//
// PR P2.1: settings tab for MCP servers.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │ MCP Servers                              [Reload] [×]      │
//   ├─────────────────────────────────────────────────────────────┤
//   │ [Config error banner — only when configError is set]       │
//   ├─────────────────────────────────────────────────────────────┤
//   │  ● filesystem                                  [connected] │
//   │    npx -y @modelcontextprotocol/server-filesystem /tmp     │
//   │    Tools: read_file, write_file, list_directory            │
//   ├─────────────────────────────────────────────────────────────┤
//   │  ○ github                                      [disabled]  │
//   │    npx -y @modelcontextprotocol/server-github              │
//   ├─────────────────────────────────────────────────────────────┤
//   │  ⚠ slack                                       [error]     │
//   │    Process exited with code 1 (npx not found)              │
//   └─────────────────────────────────────────────────────────────┘
//
// The actual SDK integration is staged separately (TODO MCP-CLIENT
// in mcpManager.ts). Until that lands, the "Tools:" line is always
// empty and the "error" status carries a stub message — but the
// panel itself renders correctly so the UI is ready when the client
// arrives.

import { useTranslation } from 'react-i18next';
import {
    AlertCircle as IconError,
    CheckCircle as IconConnected,
    Circle as IconConfigured,
    PauseCircle as IconDisabled,
    RotateCw as IconReload,
    Loader2 as IconConnecting
} from 'lucide-react';
import { Panel } from '../../layout/Panel';
import { Pill } from '../../components/ui/Pill';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import type { McpServerView, UseMcpResult } from '../../state/useMcp';

export interface McpPanelProps {
    mcp: UseMcpResult;
    onClose: () => void;
}

/** Icon + status pill color per status. */
const STATUS_DISPLAY: Record<
    McpServerView['status'],
    {
        Icon: typeof IconConnected;
        color: string;
        spin: boolean;
        pillVariant: 'secure' | 'pending' | 'blocked' | 'running' | 'info' | 'neutral';
    }
> = {
    disabled:    { Icon: IconDisabled,   color: 'text-text-tertiary',  spin: false, pillVariant: 'neutral' },
    configured:  { Icon: IconConfigured, color: 'text-text-secondary', spin: false, pillVariant: 'neutral' },
    connecting:  { Icon: IconConnecting, color: 'text-status-running', spin: true,  pillVariant: 'running' },
    connected:   { Icon: IconConnected,  color: 'text-status-secure',  spin: false, pillVariant: 'secure' },
    error:       { Icon: IconError,      color: 'text-status-blocked', spin: false, pillVariant: 'blocked' }
};

export function McpPanel({ mcp, onClose }: McpPanelProps) {
    const { t } = useTranslation();

    const statusLabel: Record<McpServerView['status'], string> = {
        disabled: t('mcp.status_disabled'),
        configured: t('mcp.status_configured'),
        connecting: t('mcp.status_connecting'),
        connected: t('mcp.status_connected'),
        error: t('mcp.status_error')
    };

    return (
        <Panel
            title={t('mcp.title')}
            onClose={onClose}
            actions={
                <Button
                    onClick={mcp.reload}
                    title={t('mcp.reload_tooltip')}
                    aria-label={t('mcp.reload_tooltip')}
                    size="sm"
                    variant="secondary"
                >
                    <IconReload size={14} />
                    <span className="ml-1">{t('mcp.reload')}</span>
                </Button>
            }
        >
            {/* Config error banner — full file is malformed */}
            {mcp.configError && (
                <div
                    role="alert"
                    className="mx-3 my-2 px-3 py-2 rounded bg-status-blocked-bg text-status-blocked text-sm"
                >
                    <div className="font-medium">{t('mcp.config_error_title')}</div>
                    <div className="text-xs mt-0.5">{mcp.configError.message}</div>
                    {mcp.configError.serverId && (
                        <div className="text-xs mt-1 font-mono opacity-80">
                            {t('mcp.config_error_server_label')}: {mcp.configError.serverId}
                        </div>
                    )}
                </div>
            )}

            {/* Loading state — first paint before any host message */}
            {mcp.loading && mcp.servers.length === 0 && (
                <div className="px-4 py-6 text-center text-text-secondary text-sm">
                    {t('mcp.loading')}
                </div>
            )}

            {/* Empty state — config loaded, no servers */}
            {!mcp.loading && mcp.servers.length === 0 && !mcp.configError && (
                <div className="px-4 py-6 text-center">
                    <div className="text-text-secondary text-sm">{t('mcp.empty_title')}</div>
                    <div className="text-text-tertiary text-xs mt-2">
                        {t('mcp.empty_hint')}
                    </div>
                </div>
            )}

            {/* Server cards */}
            <div className="overflow-y-auto">
                {mcp.servers.map((server) => {
                    const display = STATUS_DISPLAY[server.status];
                    const StatusIcon = display.Icon;

                    return (
                        <div
                            key={server.id}
                            data-testid={`mcp-server-${server.id}`}
                            data-status={server.status}
                            className={cn(
                                'px-3 py-2.5 border-t border-border-subtle',
                                'hover:bg-surface-sunken/40 transition-colors duration-(--animate-duration-fast)'
                            )}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span
                                    aria-hidden="true"
                                    className={cn('shrink-0 inline-flex items-center', display.color)}
                                    title={statusLabel[server.status]}
                                >
                                    <StatusIcon size={14} className={display.spin ? 'spin' : undefined} />
                                </span>
                                <span className="font-mono text-sm text-text-primary truncate flex-1 min-w-0">
                                    {server.id}
                                </span>
                                <Pill variant={display.pillVariant}>
                                    {statusLabel[server.status]}
                                </Pill>
                            </div>

                            {/* Description, if provided in config */}
                            {server.description && (
                                <div className="ml-5 mt-1 text-xs text-text-secondary">
                                    {server.description}
                                </div>
                            )}

                            {/* Connection summary — what gets spawned (stdio)
                                or connected to (http). */}
                            <div className="ml-5 mt-1 text-xs text-text-tertiary font-mono truncate">
                                {server.transport === 'stdio' ? (
                                    <>
                                        {server.command}
                                        {server.args && server.args.length > 0 && ' '}
                                        {server.args && server.args.join(' ')}
                                    </>
                                ) : (
                                    <>{server.url}</>
                                )}
                            </div>

                            {/* Tools list — populated when status === 'connected'. Empty
                                in P2.1 because the SDK isn't wired yet (TODO MCP-CLIENT). */}
                            {server.status === 'connected' && server.tools.length > 0 && (
                                <div className="ml-5 mt-1 text-xs text-text-secondary">
                                    <span className="text-text-tertiary">{t('mcp.tools_label')}:</span>{' '}
                                    <span className="font-mono">{server.tools.join(', ')}</span>
                                </div>
                            )}

                            {/* Error message — when status === 'error' */}
                            {server.status === 'error' && server.errorMessage && (
                                <div
                                    role="alert"
                                    className="ml-5 mt-1.5 text-xs text-status-blocked bg-status-blocked-bg px-2 py-1 rounded"
                                >
                                    {server.errorMessage}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </Panel>
    );
}