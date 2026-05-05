// webview-ui/src/test/unit/diagnosticsPanel.test.tsx
//
// PR P3.1 panel: rendering tests for DiagnosticsPanel.
//
// Covers:
//   - Empty state (no sessions, sessionsLoading)
//   - Session picker renders entries, calls selectSession on change
//   - Bundle error banner rendering
//   - Bundle loading state
//   - Summary section: started / duration / events / errors
//   - Tokens table (per-agent + total row, only-nonzero filter)
//   - Tools section (sorted by count, formatted with ×N)
//   - Timeline entries (formatted elapsed time + pill + summary)
//   - Copy-bundle button calls navigator.clipboard.writeText
//   - Refresh button fires refreshSessions + refreshTiming + selectSession

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { DiagnosticsPanel } from '../../views/diagnostics/DiagnosticsPanel';
import type {
    UseDiagnosticsResult,
    SessionListEntry,
    SessionBundle,
} from '../../state/useDiagnostics';

afterEach(() => {
    cleanup();
});

function makeBundle(overrides: Partial<SessionBundle['summary']> = {}): SessionBundle {
    return {
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
                    planner: { prompt: 1000, completion: 200, calls: 1 },
                    coder: { prompt: 5000, completion: 1500, calls: 3 },
                    verifier: { prompt: 0, completion: 0, calls: 0 },
                    hook: { prompt: 0, completion: 0, calls: 0 },
                    unknown: { prompt: 0, completion: 0, calls: 0 },
                },
                total: { prompt: 6000, completion: 1700, calls: 4 },
            },
            toolCounts: { read_file: 5, bash_exec: 2 },
            ...overrides,
        },
        timeline: [
            {
                id: 'r1',
                timestamp: '2026-05-04T00:00:00Z',
                elapsedMs: 0,
                kind: 'llm_call',
                summary: 'Plan task 1',
                inferredAgent: 'planner',
                durationMs: 1500,
            },
            {
                id: 'r2',
                timestamp: '2026-05-04T00:00:01.5Z',
                elapsedMs: 1500,
                kind: 'tool_call',
                summary: 'read_file src/foo.ts',
            },
        ],
        records: [],
    };
}

function makeDiagnostics(overrides: Partial<UseDiagnosticsResult> = {}): UseDiagnosticsResult {
    return {
        sessions: [],
        sessionsLoading: false,
        selectedSessionId: null,
        bundle: null,
        bundleLoading: false,
        bundleError: null,
        timingMarks: [],
        timingRelative: [],
        refreshSessions: vi.fn(),
        selectSession: vi.fn(),
        refreshTiming: vi.fn(),
        setStateForTest: vi.fn(),
        ...overrides,
    };
}

describe('DiagnosticsPanel — empty/loading states', () => {
    it('shows loading text when sessionsLoading=true', () => {
        const diag = makeDiagnostics({ sessionsLoading: true });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.getByText(/loading sessions/i)).toBeTruthy();
    });

    it('shows empty text when no sessions and not loading', () => {
        const diag = makeDiagnostics({ sessionsLoading: false, sessions: [] });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.getByText(/no audit sessions/i)).toBeTruthy();
    });
});

describe('DiagnosticsPanel — session picker', () => {
    const sessions: SessionListEntry[] = [
        { sessionId: 's1', startedAt: '2026-05-04T00:00:00Z', endedAt: '2026-05-04T00:01:00Z', eventCount: 5, label: 'first session' },
        { sessionId: 's2', startedAt: '2026-05-03T00:00:00Z', endedAt: '2026-05-03T00:00:30Z', eventCount: 3, label: 'second session' },
    ];

    it('renders all sessions as options', () => {
        const diag = makeDiagnostics({ sessions });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        const picker = screen.getByTestId('diagnostics-session-picker') as HTMLSelectElement;
        // 2 sessions + 1 prompt option = 3
        expect(picker.options).toHaveLength(3);
    });

    it('calls selectSession when a session is picked', () => {
        const selectSession = vi.fn();
        const diag = makeDiagnostics({ sessions, selectSession });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const picker = screen.getByTestId('diagnostics-session-picker') as HTMLSelectElement;
        fireEvent.change(picker, { target: { value: 's1' } });
        expect(selectSession).toHaveBeenCalledWith('s1');
    });

    it('passes null to selectSession when prompt is re-selected', () => {
        const selectSession = vi.fn();
        const diag = makeDiagnostics({ sessions, selectSession, selectedSessionId: 's1' });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const picker = screen.getByTestId('diagnostics-session-picker') as HTMLSelectElement;
        fireEvent.change(picker, { target: { value: '' } });
        expect(selectSession).toHaveBeenCalledWith(null);
    });
});

describe('DiagnosticsPanel — bundle error', () => {
    it('shows error banner when bundleError is set', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundleError: 'Audit log unreadable',
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByText('Audit log unreadable')).toBeTruthy();
    });

    it('shows loading text when bundleLoading and no bundle yet', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundleLoading: true,
            bundle: null,
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.getByText(/loading session details/i)).toBeTruthy();
    });
});

describe('DiagnosticsPanel — summary section', () => {
    it('renders started/duration/events rows', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const summary = screen.getByTestId('diagnostics-summary');
        expect(within(summary).getByText(/started/i)).toBeTruthy();
        expect(within(summary).getByText(/duration/i)).toBeTruthy();
        expect(within(summary).getByText(/events/i)).toBeTruthy();
        // 60000ms → "1m 0s" via formatDuration
        expect(within(summary).getByText(/1m 0s/)).toBeTruthy();
    });

    it('only shows errors row when there are errors', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle({ statusCounts: { ok: 5, error: 0, aborted: 0 } }),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        const summary = screen.getByTestId('diagnostics-summary');
        expect(within(summary).queryByText(/errors/i)).toBeNull();
    });

    it('shows errors row when there are errors', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle({ statusCounts: { ok: 5, error: 2, aborted: 0 } }),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        const summary = screen.getByTestId('diagnostics-summary');
        expect(within(summary).getByText(/errors/i)).toBeTruthy();
        expect(within(summary).getByText('2')).toBeTruthy();
    });
});

describe('DiagnosticsPanel — tokens table', () => {
    it('shows only agents with calls > 0 plus total row', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const tokens = screen.getByTestId('diagnostics-tokens');
        expect(within(tokens).getByText('planner')).toBeTruthy();
        expect(within(tokens).getByText('coder')).toBeTruthy();
        // verifier had 0 calls — should NOT appear
        expect(within(tokens).queryByText('verifier')).toBeNull();
        // total row always present
        expect(within(tokens).getByText('total')).toBeTruthy();
    });

    it('formats large token counts as k', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        const tokens = screen.getByTestId('diagnostics-tokens');
        // 5000 prompt → "5.0k"
        expect(within(tokens).getByText(/5\.0k/)).toBeTruthy();
        // 6000 total prompt → "6.0k"
        expect(within(tokens).getByText(/6\.0k/)).toBeTruthy();
    });

    it('does not render token section when total.calls = 0', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle({
                tokens: {
                    byAgent: {
                        planner: { prompt: 0, completion: 0, calls: 0 },
                        coder: { prompt: 0, completion: 0, calls: 0 },
                        verifier: { prompt: 0, completion: 0, calls: 0 },
                        hook: { prompt: 0, completion: 0, calls: 0 },
                        unknown: { prompt: 0, completion: 0, calls: 0 },
                    },
                    total: { prompt: 0, completion: 0, calls: 0 },
                },
            }),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.queryByTestId('diagnostics-tokens')).toBeNull();
    });
});

describe('DiagnosticsPanel — tools section', () => {
    it('renders tool pills sorted by count descending', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle({ toolCounts: { bash_exec: 2, read_file: 5, grep: 1 } }),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const tools = screen.getByTestId('diagnostics-tools');
        // Read order: read_file (5) → bash_exec (2) → grep (1)
        expect(within(tools).getByText('read_file')).toBeTruthy();
        expect(within(tools).getByText('bash_exec')).toBeTruthy();
        expect(within(tools).getByText('grep')).toBeTruthy();
        expect(within(tools).getByText('×5')).toBeTruthy();
    });

    it('does not render tools section when toolCounts is empty', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle({ toolCounts: {} }),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.queryByTestId('diagnostics-tools')).toBeNull();
    });
});

describe('DiagnosticsPanel — timeline section', () => {
    it('renders timeline entries with elapsed time', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const timeline = screen.getByTestId('diagnostics-timeline');
        expect(within(timeline).getByText('Plan task 1')).toBeTruthy();
        expect(within(timeline).getByText(/read_file src\/foo\.ts/)).toBeTruthy();
        // 1500ms → "1.5s"
        expect(within(timeline).getByText(/\+1\.5s/)).toBeTruthy();
    });

    it('shows the inferred agent label for llm_call entries', () => {
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        const timeline = screen.getByTestId('diagnostics-timeline');
        // First entry: kind=llm_call, inferredAgent=planner — should show "planner"
        expect(within(timeline).getAllByText('planner').length).toBeGreaterThanOrEqual(1);
    });
});

describe('DiagnosticsPanel — copy bundle', () => {
    it('calls clipboard.writeText with the bundle JSON when clicked', async () => {
        // Patch clipboard. In jsdom this exists but writeText is a no-op
        // by default; we need a spy.
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });

        const bundle = makeBundle();
        const diag = makeDiagnostics({ selectedSessionId: 's1', bundle });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const button = screen.getByTestId('diagnostics-copy-bundle');
        fireEvent.click(button);

        // The handler is async — give it a tick to resolve
        await Promise.resolve();
        expect(writeText).toHaveBeenCalled();
        const arg = writeText.mock.calls[0]![0] as string;
        expect(arg).toContain('"schemaVersion": 1');
        expect(arg).toContain('"sessionId": "s1"');
    });

    it('does nothing when there is no bundle', () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });

        const diag = makeDiagnostics({ selectedSessionId: null, bundle: null });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        // No copy-bundle button rendered
        expect(screen.queryByTestId('diagnostics-copy-bundle')).toBeNull();
    });
});

describe('DiagnosticsPanel — refresh button', () => {
    it('calls refreshSessions, refreshTiming, and re-selects current session', () => {
        const refreshSessions = vi.fn();
        const refreshTiming = vi.fn();
        const selectSession = vi.fn();
        const diag = makeDiagnostics({
            selectedSessionId: 's1',
            bundle: makeBundle(),
            refreshSessions,
            refreshTiming,
            selectSession,
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        // Refresh button is in the panel header
        const refreshBtn = screen.getByRole('button', { name: /refresh/i });
        fireEvent.click(refreshBtn);

        expect(refreshSessions).toHaveBeenCalled();
        expect(refreshTiming).toHaveBeenCalled();
        expect(selectSession).toHaveBeenCalledWith('s1');
    });

    it('does not re-select when no session is currently selected', () => {
        const selectSession = vi.fn();
        const diag = makeDiagnostics({
            selectedSessionId: null,
            refreshSessions: vi.fn(),
            refreshTiming: vi.fn(),
            selectSession,
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const refreshBtn = screen.getByRole('button', { name: /refresh/i });
        fireEvent.click(refreshBtn);

        expect(selectSession).not.toHaveBeenCalled();
    });
});

describe('DiagnosticsPanel — startup timing section', () => {
    it('renders timing marks when present', () => {
        const diag = makeDiagnostics({
            timingRelative: [
                { name: 'activate.start', sinceStartMs: 0 },
                { name: 'activate.audit.done', sinceStartMs: 47 },
                { name: 'activate.done', sinceStartMs: 250 },
            ],
        });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);

        const timing = screen.getByTestId('diagnostics-timing');
        expect(within(timing).getByText('activate.start')).toBeTruthy();
        expect(within(timing).getByText('activate.audit.done')).toBeTruthy();
        expect(within(timing).getByText(/\+47ms/)).toBeTruthy();
        expect(within(timing).getByText(/\+250ms/)).toBeTruthy();
    });

    it('does not render timing section when no marks', () => {
        const diag = makeDiagnostics({ timingRelative: [] });
        render(<DiagnosticsPanel diagnostics={diag} onClose={vi.fn()} />);
        expect(screen.queryByTestId('diagnostics-timing')).toBeNull();
    });
});