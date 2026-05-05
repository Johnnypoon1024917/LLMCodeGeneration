// webview-ui/src/test/unit/useDiagnostics.test.ts
//
// PR P3.1 panel: tests for useDiagnostics state hook.

import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiagnostics, type SessionListEntry, type SessionBundle } from '../../state/useDiagnostics';

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

function fireHostMessage(payload: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

describe('useDiagnostics — initial state', () => {
    it('starts with sessionsLoading=true and empty fields', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));
        expect(result.current.sessionsLoading).toBe(true);
        expect(result.current.sessions).toEqual([]);
        expect(result.current.selectedSessionId).toBeNull();
        expect(result.current.bundle).toBeNull();
    });

    it('posts requestSessionList and requestStartupTiming on mount', () => {
        const bridge = makeBridge();
        renderHook(() => useDiagnostics(bridge));
        expect(bridge.messages.some((m) => m.type === 'requestSessionList')).toBe(true);
        expect(bridge.messages.some((m) => m.type === 'requestStartupTiming')).toBe(true);
    });
});

describe('useDiagnostics — sessionListUpdated', () => {
    it('populates the sessions list', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        const sessions: SessionListEntry[] = [
            { sessionId: 's1', startedAt: '2026-05-04T00:00:00Z', endedAt: '2026-05-04T00:01:00Z', eventCount: 5, label: 'first' },
            { sessionId: 's2', startedAt: '2026-05-03T00:00:00Z', endedAt: '2026-05-03T00:00:30Z', eventCount: 3, label: 'second' },
        ];

        act(() => { fireHostMessage({ type: 'sessionListUpdated', sessions }); });

        expect(result.current.sessionsLoading).toBe(false);
        expect(result.current.sessions).toHaveLength(2);
        expect(result.current.sessions[0]!.sessionId).toBe('s1');
    });

    it('drops malformed entries silently', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => {
            fireHostMessage({
                type: 'sessionListUpdated',
                sessions: [
                    { sessionId: 'good', startedAt: 'a', endedAt: 'b', eventCount: 1, label: 'x' },
                    null,
                    { sessionId: 'missing-fields' },
                    'string-not-object',
                    { sessionId: 'wrong-type', startedAt: 'a', endedAt: 'b', eventCount: 'not-a-number', label: 'x' },
                ]
            });
        });

        expect(result.current.sessions).toHaveLength(1);
        expect(result.current.sessions[0]!.sessionId).toBe('good');
    });

    it('ignores messages with non-array sessions field', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));
        // Set an initial valid state
        act(() => {
            fireHostMessage({
                type: 'sessionListUpdated',
                sessions: [{ sessionId: 's1', startedAt: 'a', endedAt: 'b', eventCount: 1, label: 'x' }]
            });
        });
        expect(result.current.sessions).toHaveLength(1);

        // Now send a malformed update — should be ignored, not blow away state
        act(() => {
            fireHostMessage({ type: 'sessionListUpdated', sessions: 'not an array' });
        });
        expect(result.current.sessions).toHaveLength(1);
    });
});

describe('useDiagnostics — selectSession + sessionBundleUpdated', () => {
    it('marks bundleLoading when session is selected', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => { result.current.selectSession('s1'); });

        expect(result.current.selectedSessionId).toBe('s1');
        expect(result.current.bundleLoading).toBe(true);
        expect(bridge.messages.some(
            (m) => m.type === 'requestSessionBundle' && m['sessionId'] === 's1'
        )).toBe(true);
    });

    it('clears state when session is deselected', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => { result.current.selectSession('s1'); });
        act(() => { result.current.selectSession(null); });

        expect(result.current.selectedSessionId).toBeNull();
        expect(result.current.bundle).toBeNull();
        expect(result.current.bundleLoading).toBe(false);
    });

    it('applies bundle response when sessionId matches', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => { result.current.selectSession('s1'); });

        const fakeBundle: SessionBundle = {
            schemaVersion: 1,
            generatedAt: '2026-05-04T00:00:00Z',
            summary: {
                sessionId: 's1',
                startedAt: '2026-05-04T00:00:00Z',
                endedAt: '2026-05-04T00:01:00Z',
                durationMs: 60000,
                eventCounts: { llm_call: 3, tool_call: 5, file_write: 1, spec_edit: 0, config_change: 0, hook_fire: 0 },
                statusCounts: { ok: 9, error: 0, aborted: 0 },
                tokens: {
                    byAgent: {
                        planner: { prompt: 100, completion: 50, calls: 1 },
                        coder: { prompt: 200, completion: 80, calls: 2 },
                        verifier: { prompt: 0, completion: 0, calls: 0 },
                        hook: { prompt: 0, completion: 0, calls: 0 },
                        unknown: { prompt: 0, completion: 0, calls: 0 },
                    },
                    total: { prompt: 300, completion: 130, calls: 3 },
                },
                toolCounts: { read_file: 5 },
            },
            timeline: [],
            records: [],
        };

        act(() => {
            fireHostMessage({
                type: 'sessionBundleUpdated',
                sessionId: 's1',
                bundle: fakeBundle,
            });
        });

        expect(result.current.bundleLoading).toBe(false);
        expect(result.current.bundle).not.toBeNull();
        expect(result.current.bundle!.summary.sessionId).toBe('s1');
    });

    it('ignores out-of-order bundle responses', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => { result.current.selectSession('s1'); });
        act(() => { result.current.selectSession('s2'); });  // user picked s2 while s1 was loading

        // Late s1 response arrives
        act(() => {
            fireHostMessage({
                type: 'sessionBundleUpdated',
                sessionId: 's1',
                bundle: {
                    schemaVersion: 1,
                    generatedAt: '2026-05-04T00:00:00Z',
                    summary: { sessionId: 's1', startedAt: 'a', endedAt: 'b', durationMs: 0, eventCounts: { llm_call: 0, tool_call: 0, file_write: 0, spec_edit: 0, config_change: 0, hook_fire: 0 }, statusCounts: { ok: 0, error: 0, aborted: 0 }, tokens: { byAgent: { planner: { prompt: 0, completion: 0, calls: 0 }, coder: { prompt: 0, completion: 0, calls: 0 }, verifier: { prompt: 0, completion: 0, calls: 0 }, hook: { prompt: 0, completion: 0, calls: 0 }, unknown: { prompt: 0, completion: 0, calls: 0 } }, total: { prompt: 0, completion: 0, calls: 0 } }, toolCounts: {} },
                    timeline: [],
                    records: [],
                },
            });
        });

        // s1 response should NOT have populated the bundle — user is on s2
        expect(result.current.selectedSessionId).toBe('s2');
        expect(result.current.bundle).toBeNull();
        expect(result.current.bundleLoading).toBe(true);
    });

    it('captures bundle errors', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => { result.current.selectSession('s1'); });
        act(() => {
            fireHostMessage({
                type: 'sessionBundleUpdated',
                sessionId: 's1',
                bundle: null,
                error: 'Audit log unreadable',
            });
        });

        expect(result.current.bundleError).toBe('Audit log unreadable');
        expect(result.current.bundle).toBeNull();
        expect(result.current.bundleLoading).toBe(false);
    });
});

describe('useDiagnostics — startupTimingUpdated', () => {
    it('captures timing marks', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => {
            fireHostMessage({
                type: 'startupTimingUpdated',
                marks: [
                    { name: 'activate.start', timestamp: 1000 },
                    { name: 'activate.done', timestamp: 1500 },
                ],
                relative: [
                    { name: 'activate.start', sinceStartMs: 0 },
                    { name: 'activate.done', sinceStartMs: 500 },
                ],
            });
        });

        expect(result.current.timingMarks).toHaveLength(2);
        expect(result.current.timingRelative).toHaveLength(2);
        expect(result.current.timingRelative[1]!.sinceStartMs).toBe(500);
    });

    it('drops malformed mark entries', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        act(() => {
            fireHostMessage({
                type: 'startupTimingUpdated',
                marks: [
                    { name: 'good', timestamp: 100 },
                    { name: 'no-timestamp' },
                    { timestamp: 200 },  // no name
                    null,
                ],
                relative: [{ name: 'good', sinceStartMs: 0 }],
            });
        });

        expect(result.current.timingMarks).toHaveLength(1);
        expect(result.current.timingMarks[0]!.name).toBe('good');
    });
});

describe('useDiagnostics — auditEntryAppended triggers refresh', () => {
    it('refetches session list when a new audit entry arrives', () => {
        const bridge = makeBridge();
        renderHook(() => useDiagnostics(bridge));

        // Filter out the initial requests so we can check that a NEW
        // requestSessionList is posted in response to the auditEntry.
        const initialCount = bridge.messages.filter((m) => m.type === 'requestSessionList').length;

        act(() => { fireHostMessage({ type: 'auditEntryAppended', record: {} }); });

        const newCount = bridge.messages.filter((m) => m.type === 'requestSessionList').length;
        expect(newCount).toBe(initialCount + 1);
    });
});

describe('useDiagnostics — actions', () => {
    it('refreshSessions posts requestSessionList', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        const initialCount = bridge.messages.filter((m) => m.type === 'requestSessionList').length;
        act(() => { result.current.refreshSessions(); });
        const newCount = bridge.messages.filter((m) => m.type === 'requestSessionList').length;
        expect(newCount).toBe(initialCount + 1);
    });

    it('refreshTiming posts requestStartupTiming', () => {
        const bridge = makeBridge();
        const { result } = renderHook(() => useDiagnostics(bridge));

        const initialCount = bridge.messages.filter((m) => m.type === 'requestStartupTiming').length;
        act(() => { result.current.refreshTiming(); });
        const newCount = bridge.messages.filter((m) => m.type === 'requestStartupTiming').length;
        expect(newCount).toBe(initialCount + 1);
    });
});

describe('useDiagnostics — cleanup', () => {
    it('removes the message listener on unmount', () => {
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const bridge = makeBridge();
        const { unmount } = renderHook(() => useDiagnostics(bridge));
        unmount();
        const calls = removeSpy.mock.calls.filter((c) => c[0] === 'message');
        expect(calls.length).toBeGreaterThanOrEqual(1);
        removeSpy.mockRestore();
    });
});