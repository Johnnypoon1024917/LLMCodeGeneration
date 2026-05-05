// webview-ui/src/state/useDiagnostics.ts
//
// PR P3.1 panel: webview-side state for the diagnostics panel.
//
// Subscribes to three host messages:
//   - sessionListUpdated     — refreshed list of known sessions
//   - sessionBundleUpdated   — full data for one session (response
//                              to requestSessionBundle)
//   - startupTimingUpdated   — host-side activation phase marks
//
// On mount, posts requestSessionList + requestStartupTiming so the
// panel has data immediately. When the user picks a session from the
// list, posts requestSessionBundle to fetch its details.
//
// What this does NOT do:
//   - Maintain a ring buffer of incoming records. The audit log is
//     the source of truth on disk; this hook re-requests on demand.
//   - Compute aggregates client-side. The host runs sessionDiagnostics
//     and ships the already-aggregated structures over the wire.
//
// The structural types here mirror the host's types intentionally —
// the webview is a separate compile unit so we re-declare rather
// than import. Field stability is part of the contract.

import { useCallback, useEffect, useReducer } from 'react';

// ─── Types mirrored from host ────────────────────────────────────────

export type AgentRole = 'planner' | 'coder' | 'verifier' | 'hook' | 'unknown';

export type AuditEventKind =
    | 'llm_call' | 'tool_call' | 'file_write' | 'spec_edit'
    | 'config_change' | 'hook_fire';

export interface SessionListEntry {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    eventCount: number;
    label: string;
}

export interface TimelineEntry {
    id: string;
    timestamp: string;
    elapsedMs: number;
    durationMs?: number;
    kind: AuditEventKind;
    summary: string;
    inferredAgent?: AgentRole;
}

export interface AgentTokenStats {
    prompt: number;
    completion: number;
    calls: number;
}

export interface TokenBreakdown {
    byAgent: Record<AgentRole, AgentTokenStats>;
    total: AgentTokenStats;
}

export interface SessionSummary {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    eventCounts: Record<AuditEventKind, number>;
    statusCounts: { ok: number; error: number; aborted: number };
    tokens: TokenBreakdown;
    toolCounts: Record<string, number>;
}

export interface SessionBundle {
    schemaVersion: 1;
    generatedAt: string;
    summary: SessionSummary;
    timeline: TimelineEntry[];
    // The records field is intentionally typed loose — the panel
    // doesn't render individual records (the timeline view does),
    // it just embeds them in the downloadable export.
    records: Array<Record<string, unknown>>;
}

export interface TimingMark {
    name: string;
    timestamp: number;
}

export interface RelativeMark {
    name: string;
    sinceStartMs: number;
}

// ─── State ───────────────────────────────────────────────────────────

interface DiagnosticsState {
    /** Known sessions, most recent first. Empty array until first load. */
    sessions: SessionListEntry[];
    /** Loading state for the session list. True until first response. */
    sessionsLoading: boolean;
    /** Currently-inspected session id. Null when nothing is selected. */
    selectedSessionId: string | null;
    /** Bundle for the selected session. Null until response arrives. */
    bundle: SessionBundle | null;
    /** Loading state for the bundle. True after request, false on response. */
    bundleLoading: boolean;
    /** If a bundle request errored, the message lives here. */
    bundleError: string | null;
    /** Host-side activation phase marks. */
    timingMarks: TimingMark[];
    /** Same marks normalised to t=0 = first mark. */
    timingRelative: RelativeMark[];
}

type DiagnosticsAction =
    | { type: 'sessions_updated'; sessions: SessionListEntry[] }
    | { type: 'session_selected'; sessionId: string | null }
    | { type: 'bundle_updated'; sessionId: string; bundle: SessionBundle | null; error: string | null }
    | { type: 'timing_updated'; marks: TimingMark[]; relative: RelativeMark[] };

function reducer(state: DiagnosticsState, action: DiagnosticsAction): DiagnosticsState {
    switch (action.type) {
        case 'sessions_updated':
            return { ...state, sessions: action.sessions, sessionsLoading: false };
        case 'session_selected':
            return {
                ...state,
                selectedSessionId: action.sessionId,
                bundle: null,
                bundleError: null,
                bundleLoading: action.sessionId !== null,
            };
        case 'bundle_updated':
            // Only apply if the response matches the currently-selected
            // session. Out-of-order responses (user picked B while A
            // was loading) shouldn't overwrite the newer selection.
            if (state.selectedSessionId !== action.sessionId) {
                return state;
            }
            return {
                ...state,
                bundle: action.bundle,
                bundleError: action.error,
                bundleLoading: false,
            };
        case 'timing_updated':
            return { ...state, timingMarks: action.marks, timingRelative: action.relative };
        default:
            return state;
    }
}

const initialState: DiagnosticsState = {
    sessions: [],
    sessionsLoading: true,
    selectedSessionId: null,
    bundle: null,
    bundleLoading: false,
    bundleError: null,
    timingMarks: [],
    timingRelative: [],
};

// ─── Bridge contract ─────────────────────────────────────────────────

interface VsCodeBridge {
    postMessage: (message: { type: string; [k: string]: unknown }) => void;
}

export interface UseDiagnosticsResult extends DiagnosticsState {
    /** Re-request session list. Idempotent — host re-reads on each call. */
    refreshSessions: () => void;
    /** Select a session and request its bundle. Pass null to clear. */
    selectSession: (sessionId: string | null) => void;
    /** Re-request startup timing data. */
    refreshTiming: () => void;
    /** Test-only helpers. */
    setStateForTest: (partial: Partial<DiagnosticsState>) => void;
}

// ─── Defensive validation ────────────────────────────────────────────

const VALID_KINDS: ReadonlySet<AuditEventKind> = new Set([
    'llm_call', 'tool_call', 'file_write', 'spec_edit', 'config_change', 'hook_fire'
]);

const VALID_ROLES: ReadonlySet<AgentRole> = new Set([
    'planner', 'coder', 'verifier', 'hook', 'unknown'
]);

function validateSessionListEntry(raw: unknown): SessionListEntry | null {
    if (typeof raw !== 'object' || raw === null) { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o['sessionId'] !== 'string') { return null; }
    if (typeof o['startedAt'] !== 'string') { return null; }
    if (typeof o['endedAt'] !== 'string') { return null; }
    if (typeof o['eventCount'] !== 'number') { return null; }
    if (typeof o['label'] !== 'string') { return null; }
    return {
        sessionId: o['sessionId'] as string,
        startedAt: o['startedAt'] as string,
        endedAt: o['endedAt'] as string,
        eventCount: o['eventCount'] as number,
        label: o['label'] as string,
    };
}

function validateTimingMark(raw: unknown): TimingMark | null {
    if (typeof raw !== 'object' || raw === null) { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o['name'] !== 'string') { return null; }
    if (typeof o['timestamp'] !== 'number') { return null; }
    return { name: o['name'] as string, timestamp: o['timestamp'] as number };
}

function validateRelativeMark(raw: unknown): RelativeMark | null {
    if (typeof raw !== 'object' || raw === null) { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o['name'] !== 'string') { return null; }
    if (typeof o['sinceStartMs'] !== 'number') { return null; }
    return { name: o['name'] as string, sinceStartMs: o['sinceStartMs'] as number };
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useDiagnostics(vscode: VsCodeBridge): UseDiagnosticsResult {
    const [state, dispatch] = useReducer(reducer, initialState);

    useEffect(() => {
        const handler = (event: MessageEvent<unknown>) => {
            const data = event.data as { type?: unknown; [k: string]: unknown } | null;
            if (!data || typeof data !== 'object') { return; }

            if (data.type === 'sessionListUpdated') {
                if (!Array.isArray(data['sessions'])) { return; }
                const validated: SessionListEntry[] = [];
                for (const raw of data['sessions'] as unknown[]) {
                    const entry = validateSessionListEntry(raw);
                    if (entry) { validated.push(entry); }
                }
                dispatch({ type: 'sessions_updated', sessions: validated });
                return;
            }

            if (data.type === 'sessionBundleUpdated') {
                const sessionId = data['sessionId'];
                if (typeof sessionId !== 'string') { return; }
                const error = typeof data['error'] === 'string' ? (data['error'] as string) : null;
                // The bundle/summary/timeline/breakdown shapes are
                // structurally trusted from the host (we own both
                // sides of the contract). Light shape check only.
                const rawBundle = data['bundle'];
                let bundle: SessionBundle | null = null;
                if (rawBundle && typeof rawBundle === 'object') {
                    bundle = rawBundle as SessionBundle;
                }
                dispatch({ type: 'bundle_updated', sessionId, bundle, error });
                return;
            }

            if (data.type === 'startupTimingUpdated') {
                const rawMarks = Array.isArray(data['marks']) ? data['marks'] : [];
                const rawRelative = Array.isArray(data['relative']) ? data['relative'] : [];
                const marks: TimingMark[] = [];
                for (const r of rawMarks) {
                    const m = validateTimingMark(r);
                    if (m) { marks.push(m); }
                }
                const relative: RelativeMark[] = [];
                for (const r of rawRelative) {
                    const m = validateRelativeMark(r);
                    if (m) { relative.push(m); }
                }
                dispatch({ type: 'timing_updated', marks, relative });
                return;
            }

            // Live audit-record append: refetch session list so a
            // new session shows up. Cheap to refetch (host reads
            // JSONL into memory, runs listSessions, posts back).
            if (data.type === 'auditEntryAppended') {
                vscode.postMessage({ type: 'requestSessionList' });
                return;
            }
        };

        window.addEventListener('message', handler);

        // Initial fetches. Both are idempotent on the host side.
        vscode.postMessage({ type: 'requestSessionList' });
        vscode.postMessage({ type: 'requestStartupTiming' });

        return () => window.removeEventListener('message', handler);
    }, [vscode]);

    const refreshSessions = useCallback(() => {
        vscode.postMessage({ type: 'requestSessionList' });
    }, [vscode]);

    const selectSession = useCallback(
        (sessionId: string | null) => {
            dispatch({ type: 'session_selected', sessionId });
            if (sessionId !== null) {
                vscode.postMessage({ type: 'requestSessionBundle', sessionId });
            }
        },
        [vscode]
    );

    const refreshTiming = useCallback(() => {
        vscode.postMessage({ type: 'requestStartupTiming' });
    }, [vscode]);

    const setStateForTest = useCallback((partial: Partial<DiagnosticsState>) => {
        // Tests bypass the message bus and patch state directly. We
        // implement this via dispatching a series of concrete actions
        // so reducer invariants stay intact.
        if (partial.sessions !== undefined) {
            dispatch({ type: 'sessions_updated', sessions: partial.sessions });
        }
        if (partial.selectedSessionId !== undefined) {
            dispatch({ type: 'session_selected', sessionId: partial.selectedSessionId });
        }
        if (partial.bundle !== undefined) {
            const sid = partial.selectedSessionId ?? state.selectedSessionId;
            if (sid !== null && sid !== undefined) {
                dispatch({
                    type: 'bundle_updated',
                    sessionId: sid,
                    bundle: partial.bundle,
                    error: partial.bundleError ?? null,
                });
            }
        }
        if (partial.timingMarks !== undefined || partial.timingRelative !== undefined) {
            dispatch({
                type: 'timing_updated',
                marks: partial.timingMarks ?? state.timingMarks,
                relative: partial.timingRelative ?? state.timingRelative,
            });
        }
    }, [state.selectedSessionId, state.timingMarks, state.timingRelative]);

    return {
        ...state,
        refreshSessions,
        selectSession,
        refreshTiming,
        setStateForTest,
    };
}