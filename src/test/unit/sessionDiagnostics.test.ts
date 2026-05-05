// src/test/unit/sessionDiagnostics.test.ts
//
// PR P3.1: tests for the sessionDiagnostics module.
//
// Strategy: pure-function module. Build synthetic AuditRecord arrays
// directly and assert the aggregation outputs. No filesystem, no
// vscode mocks needed.

import {
    buildTimeline,
    inferAgentRole,
    computeTokenBreakdown,
    summarizeSession,
    buildSessionBundle,
    listSessions,
} from '../../audit/sessionDiagnostics';
import type { AuditRecord } from '../../audit/types';

function mkRecord(overrides: Partial<AuditRecord> & Pick<AuditRecord, 'kind' | 'sessionId'>): AuditRecord {
    return {
        id: `r-${Math.random().toString(36).slice(2, 10)}`,
        timestamp: '2026-05-04T00:00:00.000Z',
        actor: 'tester@host',
        sessionId: overrides.sessionId,
        kind: overrides.kind,
        summary: `mock ${overrides.kind}`,
        payload: {},
        prevHash: 'mock-prev-hash',
        ...overrides,
    };
}

// ─── inferAgentRole ──────────────────────────────────────────────────

describe('inferAgentRole', () => {
    it('infers planner from execution_plan in prompt', () => {
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'Generate <execution_plan> for...' },
        });
        expect(inferAgentRole(r)).toBe('planner');
    });

    it('infers verifier from review-the-generated phrasing', () => {
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'Please review the generated implementation against the PRD.' },
        });
        expect(inferAgentRole(r)).toBe('verifier');
    });

    it('infers coder from TASK-NNN reference in prompt', () => {
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'Implement TASK-001 using the available tools below...' },
        });
        expect(inferAgentRole(r)).toBe('coder');
    });

    it('does NOT classify on model-name alone (false-positive guard)', () => {
        // Previously, a model named 'qwen2.5-coder-32b' would auto-
        // classify any LLM call as 'coder' regardless of prompt shape.
        // That produced false positives in the diagnostics panel for
        // casual chat ("Hi who are you" → coder activity). Now we
        // require corroborating prompt-shape evidence, and a generic
        // chat preview falls through to 'unknown'.
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'Hi.', model: 'qwen2.5-coder-32b' },
        });
        expect(inferAgentRole(r)).toBe('unknown');
    });

    it('classifies as coder when prompt has agent-shape evidence (TASK-NNN)', () => {
        // A coder-named model with a coder-shaped prompt is still
        // correctly classified — the change is that BOTH signals
        // contribute, not that the model name is ignored.
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'Implement TASK-042', model: 'qwen2.5-coder-32b' },
        });
        expect(inferAgentRole(r)).toBe('coder');
    });

    it('returns unknown when no signal matches', () => {
        const r = mkRecord({
            kind: 'llm_call',
            sessionId: 's',
            payload: { promptPreview: 'hello world', model: 'qwen2.5' },
        });
        expect(inferAgentRole(r)).toBe('unknown');
    });

    it('returns unknown for non-llm records', () => {
        const r = mkRecord({ kind: 'tool_call', sessionId: 's' });
        expect(inferAgentRole(r)).toBe('unknown');
    });
});

// ─── computeTokenBreakdown ───────────────────────────────────────────

describe('computeTokenBreakdown', () => {
    it('returns zeros for an empty session', () => {
        const result = computeTokenBreakdown([], 'session-x');
        expect(result.total).toEqual({ prompt: 0, completion: 0, calls: 0 });
        expect(result.byAgent.planner).toEqual({ prompt: 0, completion: 0, calls: 0 });
    });

    it('aggregates per-agent token totals', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's1',
                payload: {
                    promptPreview: '<execution_plan>',
                    promptTokens: 100,
                    completionTokens: 50,
                },
            }),
            mkRecord({
                kind: 'llm_call',
                sessionId: 's1',
                payload: {
                    promptPreview: 'Implement TASK-001',
                    promptTokens: 200,
                    completionTokens: 80,
                },
            }),
            mkRecord({
                kind: 'llm_call',
                sessionId: 's1',
                payload: {
                    promptPreview: 'Implement TASK-002',
                    promptTokens: 150,
                    completionTokens: 60,
                },
            }),
        ];
        const result = computeTokenBreakdown(records, 's1');
        expect(result.byAgent.planner.prompt).toBe(100);
        expect(result.byAgent.planner.completion).toBe(50);
        expect(result.byAgent.planner.calls).toBe(1);
        expect(result.byAgent.coder.prompt).toBe(350);
        expect(result.byAgent.coder.completion).toBe(140);
        expect(result.byAgent.coder.calls).toBe(2);
        expect(result.total.prompt).toBe(450);
        expect(result.total.completion).toBe(190);
        expect(result.total.calls).toBe(3);
    });

    it('ignores records from other sessions', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's1',
                payload: { promptPreview: '<execution_plan>', promptTokens: 100, completionTokens: 50 },
            }),
            mkRecord({
                kind: 'llm_call',
                sessionId: 's2',  // different session
                payload: { promptPreview: '<execution_plan>', promptTokens: 999, completionTokens: 999 },
            }),
        ];
        const result = computeTokenBreakdown(records, 's1');
        expect(result.total.prompt).toBe(100);
    });

    it('handles missing token fields as zero', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's1',
                payload: { promptPreview: '<execution_plan>' },  // no token counts
            }),
        ];
        const result = computeTokenBreakdown(records, 's1');
        expect(result.total).toEqual({ prompt: 0, completion: 0, calls: 1 });
    });
});

// ─── buildTimeline ───────────────────────────────────────────────────

describe('buildTimeline', () => {
    it('returns empty for unknown session', () => {
        expect(buildTimeline([], { sessionId: 'nope' })).toEqual([]);
    });

    it('calculates elapsedMs from the first record', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's',
                timestamp: '2026-05-04T00:00:00.000Z',
            }),
            mkRecord({
                kind: 'tool_call',
                sessionId: 's',
                timestamp: '2026-05-04T00:00:01.500Z',
            }),
            mkRecord({
                kind: 'llm_call',
                sessionId: 's',
                timestamp: '2026-05-04T00:00:03.000Z',
            }),
        ];
        const timeline = buildTimeline(records, { sessionId: 's' });
        expect(timeline[0]!.elapsedMs).toBe(0);
        expect(timeline[1]!.elapsedMs).toBe(1500);
        expect(timeline[2]!.elapsedMs).toBe(3000);
    });

    it('infers agent role on llm_call entries only', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's',
                payload: { promptPreview: '<execution_plan>' },
            }),
            mkRecord({ kind: 'tool_call', sessionId: 's' }),
        ];
        const timeline = buildTimeline(records, { sessionId: 's' });
        expect(timeline[0]!.inferredAgent).toBe('planner');
        expect(timeline[1]!.inferredAgent).toBeUndefined();
    });

    it('marks hook_fire entries with agent: hook', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'hook_fire', sessionId: 's' }),
        ];
        const timeline = buildTimeline(records, { sessionId: 's' });
        expect(timeline[0]!.inferredAgent).toBe('hook');
    });

    it('filters by task description when supplied', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 's', summary: 'Working on TASK-001 setup' }),
            mkRecord({ kind: 'llm_call', sessionId: 's', summary: 'Working on TASK-002 setup' }),
            mkRecord({ kind: 'llm_call', sessionId: 's', summary: 'Working on TASK-001 wrapup' }),
        ];
        const timeline = buildTimeline(records, { sessionId: 's', taskDescription: 'TASK-001' });
        expect(timeline).toHaveLength(2);
    });

    it('computes durationMs from gap to next record on llm_call', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's',
                timestamp: '2026-05-04T00:00:00.000Z',
            }),
            mkRecord({
                kind: 'tool_call',
                sessionId: 's',
                timestamp: '2026-05-04T00:00:02.500Z',
            }),
        ];
        const timeline = buildTimeline(records, { sessionId: 's' });
        expect(timeline[0]!.durationMs).toBe(2500);
        // tool_call doesn't get duration (the audit schema doesn't carry it)
        expect(timeline[1]!.durationMs).toBeUndefined();
    });
});

// ─── summarizeSession ────────────────────────────────────────────────

describe('summarizeSession', () => {
    it('returns null for unknown session', () => {
        expect(summarizeSession([], 'nope')).toBeNull();
    });

    it('aggregates eventCounts and statusCounts', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 's', payload: { status: 'ok' } }),
            mkRecord({ kind: 'tool_call', sessionId: 's', payload: { status: 'ok' } }),
            mkRecord({ kind: 'tool_call', sessionId: 's', payload: { status: 'error' } }),
            mkRecord({ kind: 'file_write', sessionId: 's' }),
        ];
        const summary = summarizeSession(records, 's')!;
        expect(summary.eventCounts.llm_call).toBe(1);
        expect(summary.eventCounts.tool_call).toBe(2);
        expect(summary.eventCounts.file_write).toBe(1);
        expect(summary.statusCounts.ok).toBe(2);
        expect(summary.statusCounts.error).toBe(1);
    });

    it('counts tool invocations by name', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'tool_call', sessionId: 's', payload: { tool: 'read_file' } }),
            mkRecord({ kind: 'tool_call', sessionId: 's', payload: { tool: 'read_file' } }),
            mkRecord({ kind: 'tool_call', sessionId: 's', payload: { tool: 'bash_exec' } }),
        ];
        const summary = summarizeSession(records, 's')!;
        expect(summary.toolCounts['read_file']).toBe(2);
        expect(summary.toolCounts['bash_exec']).toBe(1);
    });

    it('computes wall-clock duration from first to last record', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 's', timestamp: '2026-05-04T00:00:00.000Z' }),
            mkRecord({ kind: 'tool_call', sessionId: 's', timestamp: '2026-05-04T00:00:05.500Z' }),
        ];
        const summary = summarizeSession(records, 's')!;
        expect(summary.durationMs).toBe(5500);
    });
});

// ─── buildSessionBundle ──────────────────────────────────────────────

describe('buildSessionBundle', () => {
    it('returns null for unknown session', () => {
        expect(buildSessionBundle([], 'nope')).toBeNull();
    });

    it('produces a complete bundle', () => {
        const records: AuditRecord[] = [
            mkRecord({
                kind: 'llm_call',
                sessionId: 's',
                payload: { promptPreview: '<execution_plan>', promptTokens: 100, completionTokens: 50, status: 'ok' },
            }),
            mkRecord({
                kind: 'tool_call',
                sessionId: 's',
                payload: { tool: 'read_file', status: 'ok' },
            }),
        ];
        const bundle = buildSessionBundle(records, 's')!;
        expect(bundle.schemaVersion).toBe(1);
        expect(typeof bundle.generatedAt).toBe('string');
        expect(bundle.summary.sessionId).toBe('s');
        expect(bundle.timeline).toHaveLength(2);
        expect(bundle.records).toHaveLength(2);
    });

    it('only embeds records from the requested session', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 'wanted' }),
            mkRecord({ kind: 'llm_call', sessionId: 'other' }),
            mkRecord({ kind: 'tool_call', sessionId: 'wanted' }),
        ];
        const bundle = buildSessionBundle(records, 'wanted')!;
        expect(bundle.records).toHaveLength(2);
        expect(bundle.records.every((r) => r.sessionId === 'wanted')).toBe(true);
    });
});

// ─── listSessions ────────────────────────────────────────────────────

describe('listSessions', () => {
    it('returns empty for empty input', () => {
        expect(listSessions([])).toEqual([]);
    });

    it('groups records by sessionId', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 's1', timestamp: '2026-05-01T00:00:00.000Z' }),
            mkRecord({ kind: 'tool_call', sessionId: 's1', timestamp: '2026-05-01T00:00:01.000Z' }),
            mkRecord({ kind: 'llm_call', sessionId: 's2', timestamp: '2026-05-02T00:00:00.000Z' }),
        ];
        const list = listSessions(records);
        expect(list).toHaveLength(2);
        const s1 = list.find((s) => s.sessionId === 's1')!;
        expect(s1.eventCount).toBe(2);
    });

    it('sorts by startedAt descending (most recent first)', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 'old', timestamp: '2026-04-01T00:00:00.000Z' }),
            mkRecord({ kind: 'llm_call', sessionId: 'new', timestamp: '2026-05-01T00:00:00.000Z' }),
        ];
        const list = listSessions(records);
        expect(list[0]!.sessionId).toBe('new');
        expect(list[1]!.sessionId).toBe('old');
    });

    it('uses the first record summary as label, truncated to 80 chars', () => {
        const longSummary = 'x'.repeat(120);
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 's', summary: longSummary }),
        ];
        const list = listSessions(records);
        expect(list[0]!.label).toHaveLength(80);
    });

    it('falls back to a sessionId-based label when first summary is empty', () => {
        const records: AuditRecord[] = [
            mkRecord({ kind: 'llm_call', sessionId: 'abcdef1234567890', summary: '' }),
        ];
        const list = listSessions(records);
        expect(list[0]!.label).toContain('abcdef12');
    });
});