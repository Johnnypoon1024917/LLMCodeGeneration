// webview-ui/src/test/unit/useMcp.test.ts
//
// PR P2.1: tests for the useMcp state hook.
//
// Covers:
//   - Initial state (loading=true, empty arrays)
//   - mcpStatusUpdated message updates state
//   - Defensive validation drops invalid server entries
//   - Defensive validation rejects unknown status / error code values
//   - reload() posts the correct message
//   - Cleanup removes the message listener
//
// Uses renderHook from @testing-library/react and a fake vscode bridge
// that captures posted messages. Same pattern as the existing useHooks
// tests in the project.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMcp, type McpServerView } from '../../state/useMcp';

interface CapturedMessage {
    type: string;
    [k: string]: unknown;
}

function makeBridge(): { postMessage: (m: CapturedMessage) => void; messages: CapturedMessage[] } {
    const messages: CapturedMessage[] = [];
    return {
        postMessage: (m: CapturedMessage) => { messages.push(m); },
        messages
    };
}

/** Fire a host → webview message. The hook's effect attaches a
 *  window-level 'message' listener. */
function fireHostMessage(payload: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

describe('useMcp — initial state', () => {
    it('starts with loading=true and empty servers', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));
        expect(result.current.loading).toBe(true);
        expect(result.current.servers).toEqual([]);
        expect(result.current.configError).toBe(null);
    });

    it('posts requestMcpStatus on mount', () => {
        const bridge = makeBridge();
        renderHook(() => useMcp(bridge));
        expect(bridge.messages.some((m) => m.type === 'requestMcpStatus')).toBe(true);
    });
});

describe('useMcp — message handling', () => {
    it('mcpStatusUpdated updates state and clears loading', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        const validServer: McpServerView = {
            id: 'fs',
            command: 'npx',
            args: ['-y', 'server-fs'],
            status: 'connected',
            statusChangedAt: 1234,
            tools: ['read_file', 'write_file']
        };

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [validServer],
                configError: null
            });
        });

        expect(result.current.loading).toBe(false);
        expect(result.current.servers).toHaveLength(1);
        expect(result.current.servers[0]!.id).toBe('fs');
        expect(result.current.servers[0]!.tools).toEqual(['read_file', 'write_file']);
    });

    it('captures config errors', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [],
                configError: {
                    code: 'invalid_json',
                    message: 'Failed to parse mcp-servers.json'
                }
            });
        });

        expect(result.current.configError).not.toBe(null);
        expect(result.current.configError!.code).toBe('invalid_json');
    });

    it('captures error.serverId when present', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [],
                configError: {
                    code: 'invalid_server_entry',
                    message: 'Server "broken" is missing command',
                    serverId: 'broken'
                }
            });
        });

        expect(result.current.configError!.serverId).toBe('broken');
    });

    it('ignores messages with wrong type', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));
        act(() => {
            fireHostMessage({ type: 'someOtherMessage', servers: [{ id: 'fake' }] });
        });
        expect(result.current.servers).toEqual([]);
    });
});

describe('useMcp — defensive validation', () => {
    it('drops server entries missing required fields', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [
                    // valid
                    {
                        id: 'good',
                        command: 'npx',
                        args: [],
                        status: 'connected',
                        statusChangedAt: 1,
                        tools: []
                    },
                    // missing command
                    {
                        id: 'bad',
                        args: [],
                        status: 'connected',
                        statusChangedAt: 1,
                        tools: []
                    },
                    // missing id
                    {
                        command: 'npx',
                        args: [],
                        status: 'connected',
                        statusChangedAt: 1,
                        tools: []
                    }
                ],
                configError: null
            });
        });

        expect(result.current.servers).toHaveLength(1);
        expect(result.current.servers[0]!.id).toBe('good');
    });

    it('drops entries with unknown status values', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [{
                    id: 'fs',
                    command: 'npx',
                    args: [],
                    status: 'totally-made-up-status',
                    statusChangedAt: 1,
                    tools: []
                }],
                configError: null
            });
        });

        expect(result.current.servers).toEqual([]);
    });

    it('drops non-string args/tools defensively', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [{
                    id: 'fs',
                    command: 'npx',
                    args: ['-y', 42, 'real-arg', null],
                    status: 'connected',
                    statusChangedAt: 1,
                    tools: ['valid_tool', undefined, 99]
                }],
                configError: null
            });
        });

        expect(result.current.servers).toHaveLength(1);
        expect(result.current.servers[0]!.args).toEqual(['-y', 'real-arg']);
        expect(result.current.servers[0]!.tools).toEqual(['valid_tool']);
    });

    it('rejects malformed configError objects', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [],
                configError: { code: 'unknown_code', message: 'whatever' }
            });
        });

        expect(result.current.configError).toBe(null);
    });

    it('treats null configError as no error', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            fireHostMessage({
                type: 'mcpStatusUpdated',
                servers: [],
                configError: null
            });
        });

        expect(result.current.configError).toBe(null);
    });
});

describe('useMcp — actions', () => {
    it('reload posts mcpReload', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        act(() => {
            result.current.reload();
        });

        expect(bridge.messages.some((m) => m.type === 'mcpReload')).toBe(true);
    });

    it('setServersForTest works for tests bypassing the message bus', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useMcp(bridge));

        const server: McpServerView = {
            id: 'test',
            command: 'cmd',
            args: [],
            status: 'configured',
            statusChangedAt: 0,
            tools: []
        };

        act(() => {
            result.current.setServersForTest([server]);
        });

        expect(result.current.servers).toEqual([server]);
        expect(result.current.loading).toBe(false);
    });
});

describe('useMcp — cleanup', () => {
    it('removes the message listener on unmount', () => {
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const bridge = makeBridge();
        const { unmount } = renderHook(() => useMcp(bridge));
        unmount();
        const calls = removeSpy.mock.calls.filter((c) => c[0] === 'message');
        expect(calls.length).toBeGreaterThanOrEqual(1);
        removeSpy.mockRestore();
    });
});