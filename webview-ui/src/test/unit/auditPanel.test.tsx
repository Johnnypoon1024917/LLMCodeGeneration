// webview-ui/src/test/unit/auditPanel.test.tsx
//
// Smoke tests for PR 2.4 — usePanel, useAuditLog, Panel chrome,
// AuditLogPanel. Same isolation pattern as bashApprovalCard.test.tsx:
// file-local afterEach(cleanup) so we don't depend on setup.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, act, within } from '@testing-library/react';
import { usePanel } from '../../state/usePanel';
import { useAuditLog, type AuditRecord } from '../../state/useAuditLog';
import { Panel } from '../../layout/Panel';
import { AuditLogPanel } from '../../views/audit/AuditLogPanel';

afterEach(() => {
    cleanup();
});

// ─── helpers ─────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
        id: overrides.id ?? 'rec-1',
        timestamp: overrides.timestamp ?? '2026-05-02T10:30:00.000Z',
        actor: overrides.actor ?? 'johnny@hk-dev',
        sessionId: overrides.sessionId ?? 'sess-abc-123',
        kind: overrides.kind ?? 'tool_call',
        summary: overrides.summary ?? 'read_file(src/foo.ts)',
        payload: overrides.payload ?? {},
        prevHash: overrides.prevHash ?? 'a'.repeat(64),
        ...(overrides.parentId !== undefined ? { parentId: overrides.parentId } : {})
    };
}

// ─── usePanel ────────────────────────────────────────────────────────

describe('usePanel', () => {
    it('starts closed by default', () => {
        const { result } = renderHook(() => usePanel());
        expect(result.current.isOpen).toBe(false);
        expect(result.current.kind).toBe('audit');
    });

    it('open() sets isOpen=true and kind', () => {
        const { result } = renderHook(() => usePanel());
        act(() => result.current.open('audit'));
        expect(result.current.isOpen).toBe(true);
        expect(result.current.kind).toBe('audit');
    });

    it('close() sets isOpen=false but preserves kind', () => {
        const { result } = renderHook(() => usePanel());
        act(() => result.current.open('hooks'));
        act(() => result.current.close());
        expect(result.current.isOpen).toBe(false);
        expect(result.current.kind).toBe('hooks');
    });

    it('toggle() with same kind closes when open', () => {
        const { result } = renderHook(() => usePanel());
        act(() => result.current.open('audit'));
        act(() => result.current.toggle('audit'));
        expect(result.current.isOpen).toBe(false);
    });

    it('toggle() with different kind swaps in place (stays open)', () => {
        const { result } = renderHook(() => usePanel());
        act(() => result.current.open('audit'));
        act(() => result.current.toggle('hooks'));
        expect(result.current.isOpen).toBe(true);
        expect(result.current.kind).toBe('hooks');
    });
});

// ─── useAuditLog ─────────────────────────────────────────────────────

describe('useAuditLog', () => {
    it('starts with empty records and chainValid=true', () => {
        const { result } = renderHook(() => useAuditLog());
        expect(result.current.records).toEqual([]);
        expect(result.current.chainValid).toBe(true);
        expect(result.current.totalSeen).toBe(0);
    });

    it('appendForDemo adds a record and increments totalSeen', () => {
        const { result } = renderHook(() => useAuditLog());
        const record = makeRecord();
        act(() => result.current.appendForDemo(record));
        expect(result.current.records).toHaveLength(1);
        expect(result.current.records[0]?.id).toBe('rec-1');
        expect(result.current.totalSeen).toBe(1);
    });

    it('reset() clears records but not chainValid', () => {
        const { result } = renderHook(() => useAuditLog());
        act(() => result.current.appendForDemo(makeRecord()));
        act(() => result.current.reset());
        expect(result.current.records).toEqual([]);
        expect(result.current.totalSeen).toBe(0);
    });

    it('chainValid flips false on a record with empty prevHash', () => {
        const { result } = renderHook(() => useAuditLog());
        const bad = makeRecord({ id: 'bad', prevHash: '' });
        act(() => result.current.appendForDemo(bad));
        expect(result.current.chainValid).toBe(false);
    });

    it('responds to window auditEntryAppended messages', () => {
        const { result } = renderHook(() => useAuditLog());
        const record = makeRecord({ id: 'from-host', summary: 'host-sent' });
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'auditEntryAppended', record }
                })
            );
        });
        expect(result.current.records).toHaveLength(1);
        expect(result.current.records[0]?.id).toBe('from-host');
    });

    it('ignores malformed messages without crashing', () => {
        const { result } = renderHook(() => useAuditLog());
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'auditEntryAppended', record: 'not-an-object' }
                })
            );
            window.dispatchEvent(
                new MessageEvent('message', { data: { type: 'unrelated' } })
            );
        });
        expect(result.current.records).toEqual([]);
    });
});

// ─── Panel chrome ────────────────────────────────────────────────────

describe('Panel', () => {
    it('renders title + subtitle + close button', () => {
        const { container } = render(
            <Panel title="Audit log" subtitle="42 entries · chain valid" onClose={() => {}}>
                <div>body</div>
            </Panel>
        );
        expect(container).toHaveTextContent('Audit log');
        expect(container).toHaveTextContent('42 entries · chain valid');
        expect(within(container).getByRole('button', { name: /close panel/i })).toBeInTheDocument();
    });

    it('close button fires onClose', () => {
        const onClose = vi.fn();
        const { container } = render(
            <Panel title="X" onClose={onClose}>
                <div>body</div>
            </Panel>
        );
        fireEvent.click(within(container).getByRole('button', { name: /close panel/i }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses role="complementary" for the aside', () => {
        const { container } = render(
            <Panel title="X" onClose={() => {}}>
                <div>body</div>
            </Panel>
        );
        expect(container.querySelector('[role="complementary"]')).toBeInTheDocument();
    });
});

// ─── AuditLogPanel ───────────────────────────────────────────────────

describe('AuditLogPanel', () => {
    it('renders empty state when no records', () => {
        const { container } = render(
            <AuditLogPanel
                audit={{
                    records: [],
                    chainValid: true,
                    totalSeen: 0,
                    appendForDemo: () => {},
                    reset: () => {}
                }}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent(/no activity yet/i);
    });

    it('renders one row per record with summary text', () => {
        const records = [
            makeRecord({ id: 'r1', summary: 'read_file(a.ts)' }),
            makeRecord({ id: 'r2', summary: 'write_file(b.ts)', kind: 'file_write' })
        ];
        const { container } = render(
            <AuditLogPanel
                audit={{
                    records,
                    chainValid: true,
                    totalSeen: 2,
                    appendForDemo: () => {},
                    reset: () => {}
                }}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent('read_file(a.ts)');
        expect(container).toHaveTextContent('write_file(b.ts)');
    });

    it('shows chain-broken alert when chainValid is false', () => {
        const { container } = render(
            <AuditLogPanel
                audit={{
                    records: [makeRecord()],
                    chainValid: false,
                    totalSeen: 1,
                    appendForDemo: () => {},
                    reset: () => {}
                }}
                onClose={() => {}}
            />
        );
        // alert role announces tampering
        expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    });

    it('clear button calls reset()', () => {
        const reset = vi.fn();
        const { container } = render(
            <AuditLogPanel
                audit={{
                    records: [makeRecord()],
                    chainValid: true,
                    totalSeen: 1,
                    appendForDemo: () => {},
                    reset
                }}
                onClose={() => {}}
            />
        );
        const clearBtn = within(container).getByRole('button', { name: /clear audit panel/i });
        fireEvent.click(clearBtn);
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it('orders records newest-first', () => {
        const older = makeRecord({ id: 'older', summary: 'older entry', timestamp: '2026-05-02T10:00:00.000Z' });
        const newer = makeRecord({ id: 'newer', summary: 'newer entry', timestamp: '2026-05-02T11:00:00.000Z' });
        const { container } = render(
            <AuditLogPanel
                audit={{
                    records: [older, newer], // appended in time order
                    chainValid: true,
                    totalSeen: 2,
                    appendForDemo: () => {},
                    reset: () => {}
                }}
                onClose={() => {}}
            />
        );
        const html = container.innerHTML;
        // 'newer entry' should appear before 'older entry' in the DOM
        const newerIdx = html.indexOf('newer entry');
        const olderIdx = html.indexOf('older entry');
        expect(newerIdx).toBeGreaterThan(-1);
        expect(olderIdx).toBeGreaterThan(-1);
        expect(newerIdx).toBeLessThan(olderIdx);
    });
});