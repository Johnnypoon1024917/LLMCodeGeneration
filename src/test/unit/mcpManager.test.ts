// src/test/unit/mcpManager.test.ts
//
// PR P2.1: tests for McpManager.
//
// Strategy: mock vscode.workspace.fs.readFile to return per-test
// config content, capture the watcher event handlers so we can
// simulate FS changes, inject a fake connectMcpServer so tests don't
// spawn real subprocesses, then assert manager state via
// getServerViews() and via a subscriber.

import { McpManager } from '../../mcp/mcpManager';
import {
    setMcpClientFactoryForTests,
    type McpConnection
} from '../../mcp/mcpClient';
import * as vscode from 'vscode';

// Capture: each call to createFileSystemWatcher is captured here so
// tests can fire change/create/delete events directly.
interface CapturedWatcher {
    onDidChange: jest.Mock;
    onDidCreate: jest.Mock;
    onDidDelete: jest.Mock;
    dispose: jest.Mock;
    fireChange: () => void;
    fireCreate: () => void;
    fireDelete: () => void;
}

function captureWatchers(): CapturedWatcher[] {
    const captured: CapturedWatcher[] = [];
    const factory = vscode.workspace.createFileSystemWatcher as jest.Mock;
    factory.mockImplementation(() => {
        const onDidChange = jest.fn();
        const onDidCreate = jest.fn();
        const onDidDelete = jest.fn();
        const dispose = jest.fn();
        const w: CapturedWatcher = {
            onDidChange,
            onDidCreate,
            onDidDelete,
            dispose,
            fireChange: () => {
                const handler = onDidChange.mock.calls[0]?.[0];
                if (handler) { handler({ fsPath: '/repo/.nexus/mcp-servers.json' }); }
            },
            fireCreate: () => {
                const handler = onDidCreate.mock.calls[0]?.[0];
                if (handler) { handler({ fsPath: '/repo/.nexus/mcp-servers.json' }); }
            },
            fireDelete: () => {
                const handler = onDidDelete.mock.calls[0]?.[0];
                if (handler) { handler({ fsPath: '/repo/.nexus/mcp-servers.json' }); }
            }
        };
        captured.push(w);
        return {
            onDidChange,
            onDidCreate,
            onDidDelete,
            dispose,
            ignoreCreateEvents: false,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false
        };
    });
    return captured;
}

/** Set the next readFile call's response. Multiple consecutive sets
 *  replace earlier ones — this is "what does THE NEXT read return". */
function setConfigContent(content: string | null): void {
    // Cast through `unknown` because the real FileSystem type carries
    // many methods we don't mock — TS rightly refuses the direct cast.
    // The vscode mock at src/test/unit/__mocks__/vscode.ts replaces
    // workspace.fs.readFile with a jest.Mock, so this cast is safe at
    // runtime even though TS can't see across the moduleNameMapper.
    const fs = vscode.workspace.fs as unknown as { readFile: jest.Mock };
    if (content === null) {
        // Simulate "file does not exist" — readFile rejects.
        fs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    } else {
        const bytes = new TextEncoder().encode(content);
        fs.readFile.mockResolvedValueOnce(bytes);
    }
}

/** Tiny helper: wait for any pending microtasks from start() / reloadConfig()
 *  to resolve before asserting state. */
function flushAsync(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a fake McpConnection. Tests that need to simulate specific
 * tool lists or dispatch behavior override the defaults.
 *
 * Defaults: empty tools list, dispatch returns a generic string,
 * close is a no-op.
 */
function buildFakeConnection(opts: {
    tools?: { name: string; description?: string; inputSchema?: unknown }[];
    serverId: string;
    onDispatch?: (toolName: string, args: Record<string, unknown>) => Promise<{ llmContent: string; uiPayload: { kind: 'string'; content: string } | { kind: 'error'; message: string } }>;
    onClose?: () => Promise<void>;
}): McpConnection {
    const toolDefs = (opts.tools ?? []).map((t) => ({
        type: 'function' as const,
        function: {
            name: `mcp__${opts.serverId}__${t.name}`,
            description: t.description ?? `mock`,
            parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object' }
        }
    }));
    const originalNames = (opts.tools ?? []).map((t) => t.name);
    return {
        tools: toolDefs,
        originalToolNames: originalNames,
        dispatch: opts.onDispatch ?? (async (toolName) => ({
            llmContent: `fake dispatch result for ${toolName}`,
            uiPayload: { kind: 'string', content: `fake result for ${toolName}` }
        })),
        close: opts.onClose ?? (async () => { /* no-op */ })
    };
}

/**
 * Install a default fake connect impl that succeeds with empty tools.
 * Most tests just need "the connection succeeded" without caring
 * about specific tools — this gives them a fast default. Tests that
 * need richer behavior override before flushing.
 */
function installDefaultFakeConnect(): void {
    setMcpClientFactoryForTests(async (entry) => buildFakeConnection({ serverId: entry.id }));
}

describe('McpManager — initial load', () => {
    beforeEach(() => {
        installDefaultFakeConnect();
    });

    afterEach(() => {
        McpManager.resetForTests();
        setMcpClientFactoryForTests(null);
        jest.clearAllMocks();
    });

    it('returns empty list when config file is missing', async () => {
        captureWatchers();
        setConfigContent(null);

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        expect(mgr.getServerViews()).toEqual([]);
        expect(mgr.getConfigError()).toBe(null);
    });

    it('parses valid config and records servers', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: {
                fs: { command: 'npx', args: ['-y', 'server-fs'] },
                gh: { command: 'npx', args: ['-y', 'server-github'], disabled: true }
            }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views).toHaveLength(2);
        // Sorted by id: fs, gh
        expect(views[0]!.id).toBe('fs');
        expect(views[1]!.id).toBe('gh');
        expect(views[1]!.status).toBe('disabled');
    });

    it('surfaces config errors WITHOUT crashing', async () => {
        captureWatchers();
        setConfigContent('{ "mcpServers": "not an object" }');

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const err = mgr.getConfigError();
        expect(err).not.toBe(null);
        expect(err!.code).toBe('wrong_shape');
    });

    it('clears configError after a subsequent valid reload', async () => {
        captureWatchers();
        // First load: invalid
        setConfigContent('not json');

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        expect(mgr.getConfigError()).not.toBe(null);

        // Second load: valid
        setConfigContent('{}');
        await mgr.reloadConfig();

        expect(mgr.getConfigError()).toBe(null);
    });
});

describe('McpManager — server lifecycle (SDK integration)', () => {
    beforeEach(() => {
        installDefaultFakeConnect();
    });

    afterEach(() => {
        McpManager.resetForTests();
        setMcpClientFactoryForTests(null);
        jest.clearAllMocks();
    });

    it('enabled server transitions to connected when SDK connect succeeds', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views).toHaveLength(1);
        expect(views[0]!.status).toBe('connected');
        expect(views[0]!.errorMessage).toBeUndefined();
        // Default fake returns empty tools list
        expect(views[0]!.tools).toEqual([]);
    });

    it('connected server reports its tools list (un-namespaced)', async () => {
        captureWatchers();
        setMcpClientFactoryForTests(async (entry) => buildFakeConnection({
            serverId: entry.id,
            tools: [
                { name: 'read_file', description: 'reads a file' },
                { name: 'write_file' }
            ]
        }));
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views[0]!.status).toBe('connected');
        // UI sees un-namespaced names — namespacing is internal
        expect(views[0]!.tools).toEqual(['read_file', 'write_file']);
    });

    it('transitions to error with friendly message on ENOENT', async () => {
        captureWatchers();
        setMcpClientFactoryForTests(async () => {
            throw new Error('spawn npx ENOENT');
        });
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views[0]!.status).toBe('error');
        // ENOENT gets a friendlier "Command not found" rewrap
        expect(views[0]!.errorMessage).toContain('Command not found');
        expect(views[0]!.errorMessage).toContain('npx');
    });

    it('transitions to error with raw message on other connect failures', async () => {
        captureWatchers();
        setMcpClientFactoryForTests(async () => {
            throw new Error('Protocol version mismatch');
        });
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views[0]!.status).toBe('error');
        expect(views[0]!.errorMessage).toContain('Protocol version mismatch');
    });

    it('disabled server stays in disabled state without attempting connection', async () => {
        captureWatchers();
        // Override default to throw — proves we don't even call connect
        let connectCalled = false;
        setMcpClientFactoryForTests(async (entry) => {
            connectCalled = true;
            return buildFakeConnection({ serverId: entry.id });
        });
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx', disabled: true } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const views = mgr.getServerViews();
        expect(views[0]!.status).toBe('disabled');
        expect(views[0]!.errorMessage).toBeUndefined();
        expect(connectCalled).toBe(false);
    });
});

describe('McpManager — config diff on reload', () => {
    beforeEach(() => {
        installDefaultFakeConnect();
    });

    afterEach(() => {
        McpManager.resetForTests();
        setMcpClientFactoryForTests(null);
        jest.clearAllMocks();
    });

    it('adds new server entries on reload', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({ mcpServers: { fs: { command: 'npx' } } }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        expect(mgr.getServerViews()).toHaveLength(1);

        // New config adds a second server
        setConfigContent(JSON.stringify({
            mcpServers: {
                fs: { command: 'npx' },
                gh: { command: 'npx' }
            }
        }));
        await mgr.reloadConfig();

        expect(mgr.getServerViews()).toHaveLength(2);
        expect(mgr.getServerViews().map((s) => s.id)).toEqual(['fs', 'gh']);
    });

    it('removes server entries when they disappear from config', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' }, gh: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        expect(mgr.getServerViews()).toHaveLength(2);

        // Drop fs
        setConfigContent(JSON.stringify({ mcpServers: { gh: { command: 'npx' } } }));
        await mgr.reloadConfig();

        expect(mgr.getServerViews()).toHaveLength(1);
        expect(mgr.getServerViews()[0]!.id).toBe('gh');
    });

    it('reconnects when command changes', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const beforeTimestamp = mgr.getServerViews()[0]!.statusChangedAt;

        // Wait a moment, then change config
        await new Promise((r) => setTimeout(r, 5));
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: '/usr/bin/different-server' } }
        }));
        await mgr.reloadConfig();

        const view = mgr.getServerViews()[0]!;
        expect(view.command).toBe('/usr/bin/different-server');
        // statusChangedAt advanced — proves the connection cycle reset
        expect(view.statusChangedAt).toBeGreaterThan(beforeTimestamp);
    });

    it('reconnects when disabled toggles from true to false', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx', disabled: true } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        expect(mgr.getServerViews()[0]!.status).toBe('disabled');

        // Enable it
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx', disabled: false } }
        }));
        await mgr.reloadConfig();

        // Now connecting → connected (default fake succeeds)
        expect(mgr.getServerViews()[0]!.status).toBe('connected');
    });

    it('does not reconnect when nothing changed', async () => {
        captureWatchers();
        const config = JSON.stringify({
            mcpServers: { fs: { command: 'npx', args: ['-y'], env: { K: 'v' } } }
        });
        setConfigContent(config);

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const beforeTimestamp = mgr.getServerViews()[0]!.statusChangedAt;

        // Wait, then reload with identical config
        await new Promise((r) => setTimeout(r, 5));
        setConfigContent(config);
        await mgr.reloadConfig();

        // statusChangedAt UNCHANGED — proves we didn't churn the connection
        expect(mgr.getServerViews()[0]!.statusChangedAt).toBe(beforeTimestamp);
    });

    it('detects env changes as a reason to reconnect', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx', env: { TOKEN: 'old' } } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        const beforeTimestamp = mgr.getServerViews()[0]!.statusChangedAt;

        await new Promise((r) => setTimeout(r, 5));
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx', env: { TOKEN: 'new' } } }
        }));
        await mgr.reloadConfig();

        expect(mgr.getServerViews()[0]!.statusChangedAt).toBeGreaterThan(beforeTimestamp);
    });
});

describe('McpManager — subscription', () => {
    beforeEach(() => {
        installDefaultFakeConnect();
    });

    afterEach(() => {
        McpManager.resetForTests();
        setMcpClientFactoryForTests(null);
        jest.clearAllMocks();
    });

    it('delivers initial state synchronously to a new subscriber', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        const seen: { count: number; lastViews: any[] } = { count: 0, lastViews: [] };
        const unsub = mgr.subscribe((views) => {
            seen.count++;
            seen.lastViews = views;
        });

        // Initial delivery is synchronous — already happened before
        // unsub returns
        expect(seen.count).toBe(1);
        expect(seen.lastViews).toHaveLength(1);

        unsub();
    });

    it('fires on reload that changes state', async () => {
        captureWatchers();
        setConfigContent(JSON.stringify({ mcpServers: {} }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        let count = 0;
        mgr.subscribe(() => { count++; });
        const initialCount = count;  // 1, the initial delivery

        // Add a server
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));
        await mgr.reloadConfig();

        // At least one additional notification fired (the manager
        // notifies once at end of reload, and the stub error
        // transition fires another)
        expect(count).toBeGreaterThan(initialCount);
    });

    it('unsubscribed callbacks no longer receive updates', async () => {
        captureWatchers();
        setConfigContent('{}');

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        let count = 0;
        const unsub = mgr.subscribe(() => { count++; });
        const afterInitial = count;
        unsub();

        // Reload — should not fire on the unsubscribed callback
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));
        await mgr.reloadConfig();

        expect(count).toBe(afterInitial);
    });

    it('one subscriber throwing does not break others', async () => {
        captureWatchers();
        setConfigContent('{}');

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        let goodCount = 0;
        mgr.subscribe(() => { throw new Error('bad subscriber'); });
        mgr.subscribe(() => { goodCount++; });
        // Both got initial state — at least the good one ran
        expect(goodCount).toBe(1);

        // Reload — good subscriber should still receive
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));
        await mgr.reloadConfig();
        expect(goodCount).toBeGreaterThan(1);
    });
});

describe('McpManager — dispose', () => {
    beforeEach(() => {
        installDefaultFakeConnect();
    });

    afterEach(() => {
        McpManager.resetForTests();
        setMcpClientFactoryForTests(null);
        jest.clearAllMocks();
    });

    it('disposes the watcher and clears state', async () => {
        const watchers = captureWatchers();
        setConfigContent(JSON.stringify({
            mcpServers: { fs: { command: 'npx' } }
        }));

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();
        expect(watchers.length).toBe(1);

        mgr.dispose();

        expect(watchers[0]!.dispose).toHaveBeenCalled();
        expect(mgr.getServerViews()).toEqual([]);
        expect(mgr.getConfigError()).toBe(null);
    });

    it('start() is idempotent and disposes the previous watcher', async () => {
        const watchers = captureWatchers();
        setConfigContent('{}');

        const mgr = McpManager.getInstance();
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        // Calling start() again should dispose the old watcher
        setConfigContent('{}');
        mgr.start({ fsPath: '/repo' } as vscode.Uri);
        await flushAsync();

        // Two watchers were created; the first was disposed
        expect(watchers.length).toBe(2);
        expect(watchers[0]!.dispose).toHaveBeenCalled();
    });
});