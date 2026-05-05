// src/audit/sessionDiagnostics.ts
//
// PR P3.1: telemetry + diagnostics over the existing audit log.
//
// What this module produces, all from AuditRecord[] (no new event
// kinds added — pure aggregation over what the audit log already
// captures):
//
//   1. Per-task timeline — chronological view of every audit
//      record that belongs to a given task, with elapsed-time
//      annotations. The webview's diagnostics tab will render this;
//      the support-bundle export embeds it.
//
//   2. Token usage breakdown per agent — planner / coder / verifier
//      tokens separately. The audit records carry `model` but not
//      "which agent invoked the model" — we infer the agent role
//      from heuristics on the prompt preview + the parent-child
//      record structure. Best-effort, not exact; sufficient for
//      "where are my tokens going" diagnostics.
//
//   3. Session bundle — a single JSON object containing all of the
//      above plus session-level metadata (duration, total tokens,
//      tool-call counts, error counts). One copy-paste-able blob
//      for support tickets.
//
// What this module does NOT do:
//   - Write anything. Every function here is read-only.
//   - Talk to vscode APIs. Pure data in, pure data out — testable
//     without a vscode mock.
//   - Define new audit event kinds. The schema is stable; new
//     consumers like this one work over the existing kinds.

import type { AuditRecord, LlmCallPayload, ToolCallPayload } from './types';

// ─── Per-task timeline ───────────────────────────────────────────────

/**
 * One row in the timeline view. Mirrors the fields the audit panel
 * already renders, plus a few derived display helpers.
 */
export interface TimelineEntry {
    /** Original audit record id. Lets the UI link back. */
    id: string;
    /** ISO timestamp from the underlying record. */
    timestamp: string;
    /** Milliseconds since the first record in this timeline. The first
     *  entry is always 0. Useful for "how long did this take" timelines. */
    elapsedMs: number;
    /** Duration of this individual entry where measurable. For LLM
     *  calls we use the gap to the next sibling record as a rough
     *  estimate; for tool calls the audit record itself doesn't carry
     *  duration today, so this is undefined for tools. (Future audit
     *  schema work could add it.) */
    durationMs?: number;
    /** The audit-record kind, forwarded for UI styling. */
    kind: AuditRecord['kind'];
    /** Same one-line summary the audit record carries. */
    summary: string;
    /** For LLM calls: which agent we infer this came from. */
    inferredAgent?: AgentRole;
}

/** Agent role inference categories. 'unknown' when we can't tell. */
export type AgentRole = 'planner' | 'coder' | 'verifier' | 'hook' | 'unknown';

/**
 * Build a timeline for the records that belong to one task.
 *
 * The "task" identification heuristic: we accept a session id and
 * an optional task description. If a task description is given, we
 * filter to records whose summary contains the description (best-
 * effort match — the audit summaries embed task descriptions for
 * tool/LLM calls fired during a task).
 *
 * If no task description: return the full session timeline. Tasks
 * within a session can still be visually segmented in the UI by
 * looking at gaps in elapsedMs.
 */
export function buildTimeline(
    records: readonly AuditRecord[],
    opts: { sessionId: string; taskDescription?: string }
): TimelineEntry[] {
    const sessionRecords = records.filter((r) => r.sessionId === opts.sessionId);
    const filtered = opts.taskDescription
        ? sessionRecords.filter((r) => r.summary.includes(opts.taskDescription!))
        : sessionRecords;

    if (filtered.length === 0) { return []; }

    // The first record is the timeline anchor — every elapsedMs is
    // measured relative to its timestamp. We don't sort the input;
    // the caller is expected to pass records in audit order, which
    // readRecords() already does.
    const anchorTs = Date.parse(filtered[0]!.timestamp);
    const out: TimelineEntry[] = [];

    for (let i = 0; i < filtered.length; i++) {
        const r = filtered[i]!;
        const ts = Date.parse(r.timestamp);
        const elapsedMs = Number.isFinite(ts - anchorTs) ? ts - anchorTs : 0;

        const entry: TimelineEntry = {
            id: r.id,
            timestamp: r.timestamp,
            elapsedMs,
            kind: r.kind,
            summary: r.summary,
        };

        // Duration for LLM calls = gap to the next sibling LLM/tool
        // record. Tool calls don't carry duration in the audit schema
        // today; once they do, mirror the same logic here.
        if (r.kind === 'llm_call' && i + 1 < filtered.length) {
            const nextTs = Date.parse(filtered[i + 1]!.timestamp);
            if (Number.isFinite(nextTs - ts) && nextTs >= ts) {
                entry.durationMs = nextTs - ts;
            }
        }

        if (r.kind === 'llm_call') {
            entry.inferredAgent = inferAgentRole(r);
        } else if (r.kind === 'hook_fire') {
            entry.inferredAgent = 'hook';
        }

        out.push(entry);
    }

    return out;
}

// ─── Agent role inference ────────────────────────────────────────────

/**
 * Infer which agent (planner/coder/verifier) made an LLM call.
 *
 * The audit record doesn't carry an explicit "agent" field — adding
 * one would be a schema change and is being deferred until we're
 * sure the inference is too noisy. The heuristic uses two signals:
 *
 *   1. Prompt preview content. PlannerAgent's system prompt mentions
 *      "execution_plan", VerifierAgent's mentions "review the
 *      generated implementation", CoderAgent's typically references
 *      "TASK-" + a tool list.
 *
 *   2. Model field, BUT only as a corroborating signal when there's
 *      ALSO some prompt-shape evidence of agent activity. Why the
 *      tighter rule: a user-configured `qwen3.6-27b` model name
 *      shouldn't bucket every casual chat message as Coder activity.
 *      The model-name fallback was firing false positives like
 *      "Hi who are you" → coder, which is misleading in the
 *      diagnostics panel.
 *
 * Returns 'unknown' when no signal matches. Callers should treat
 * 'unknown' as "don't break the breakdown view, just bucket
 * separately."
 */
export function inferAgentRole(record: AuditRecord): AgentRole {
    if (record.kind !== 'llm_call') { return 'unknown'; }
    const payload = record.payload as Partial<LlmCallPayload>;

    // Signal 1: prompt preview content. The Planner emits
    // <execution_plan>, the Verifier evaluates a finished
    // implementation, the Coder executes a single TASK-NNN.
    const preview = payload.promptPreview ?? '';
    const previewLower = preview.toLowerCase();
    if (previewLower.includes('execution_plan') || previewLower.includes('execution plan')) {
        return 'planner';
    }
    if (previewLower.includes('verify') || previewLower.includes('review the generated')) {
        return 'verifier';
    }
    // CoderAgent prompts reference "TASK-NNN" identifiers AND include
    // a tools section header. Either one alone is enough to identify
    // it as coder activity; the model-name match is no longer
    // sufficient on its own (false positives on user-configured
    // model names like `qwen3.6-27b` for chat).
    const looksLikeCoderPrompt =
        /task-\d+/i.test(preview) || previewLower.includes('available tools:');
    if (looksLikeCoderPrompt) {
        return 'coder';
    }

    // No prompt-shape signal found. We could fall back to the model
    // name, but that produces false positives for user-configured
    // models (e.g. `qwen3.6-27b` answering casual chat). Bucket as
    // 'unknown' instead — the diagnostics panel handles unknown as
    // a first-class category, so honest unknowns are better than
    // misleading classifications.
    return 'unknown';
}

// ─── Token usage breakdown ───────────────────────────────────────────

/**
 * Per-agent token totals. Tokens for which the agent role can't be
 * inferred land in `unknown`. Sum of all roles = grand total.
 */
export interface TokenBreakdown {
    /** Map from agent role to its prompt + completion totals. */
    byAgent: Record<AgentRole, { prompt: number; completion: number; calls: number }>;
    /** Grand totals across all agents. */
    total: { prompt: number; completion: number; calls: number };
}

/**
 * Compute the token breakdown for a session. Returns zeros when the
 * session has no llm_call records, rather than throwing — empty
 * sessions are normal during early development.
 */
export function computeTokenBreakdown(
    records: readonly AuditRecord[],
    sessionId: string
): TokenBreakdown {
    const empty = (): { prompt: number; completion: number; calls: number } => ({
        prompt: 0, completion: 0, calls: 0
    });

    const byAgent: TokenBreakdown['byAgent'] = {
        planner: empty(),
        coder: empty(),
        verifier: empty(),
        hook: empty(),
        unknown: empty(),
    };
    const total = empty();

    for (const r of records) {
        if (r.sessionId !== sessionId) { continue; }
        if (r.kind !== 'llm_call') { continue; }
        const payload = r.payload as Partial<LlmCallPayload>;
        const role = inferAgentRole(r);
        const promptTokens = typeof payload.promptTokens === 'number' ? payload.promptTokens : 0;
        const completionTokens = typeof payload.completionTokens === 'number' ? payload.completionTokens : 0;

        byAgent[role].prompt += promptTokens;
        byAgent[role].completion += completionTokens;
        byAgent[role].calls += 1;

        total.prompt += promptTokens;
        total.completion += completionTokens;
        total.calls += 1;
    }

    return { byAgent, total };
}

// ─── Session bundle (support ticket payload) ─────────────────────────

/**
 * Top-line stats about a session, suitable for the bundle's header
 * + the diagnostics-panel summary.
 */
export interface SessionSummary {
    sessionId: string;
    /** ISO of the first record. */
    startedAt: string;
    /** ISO of the last record. */
    endedAt: string;
    /** Wall-clock from first to last record in milliseconds. */
    durationMs: number;
    /** Counts grouped by audit kind. Useful at a glance. */
    eventCounts: Record<AuditRecord['kind'], number>;
    /** Counts grouped by status field on llm_call / tool_call records. */
    statusCounts: { ok: number; error: number; aborted: number };
    /** Aggregated token usage (sum of all roles). */
    tokens: TokenBreakdown;
    /** Tool call counts by tool name. Helps spot e.g. "100 read_file calls
     *  in 30 seconds" patterns that indicate runaway agents. */
    toolCounts: Record<string, number>;
}

/**
 * Compute a summary for a single session. The session is identified
 * by sessionId; records belonging to other sessions are ignored.
 */
export function summarizeSession(
    records: readonly AuditRecord[],
    sessionId: string
): SessionSummary | null {
    const sessionRecords = records.filter((r) => r.sessionId === sessionId);
    if (sessionRecords.length === 0) { return null; }

    const startedAt = sessionRecords[0]!.timestamp;
    const endedAt = sessionRecords[sessionRecords.length - 1]!.timestamp;
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));

    const eventCounts: Record<AuditRecord['kind'], number> = {
        llm_call: 0,
        tool_call: 0,
        file_write: 0,
        spec_edit: 0,
        config_change: 0,
        hook_fire: 0,
    };
    const statusCounts = { ok: 0, error: 0, aborted: 0 };
    const toolCounts: Record<string, number> = {};

    for (const r of sessionRecords) {
        eventCounts[r.kind] = (eventCounts[r.kind] ?? 0) + 1;

        if (r.kind === 'llm_call' || r.kind === 'tool_call') {
            const status = (r.payload as { status?: string }).status;
            if (status === 'ok') { statusCounts.ok++; }
            else if (status === 'error') { statusCounts.error++; }
            else if (status === 'aborted') { statusCounts.aborted++; }
        }

        if (r.kind === 'tool_call') {
            const tool = (r.payload as Partial<ToolCallPayload>).tool;
            if (typeof tool === 'string') {
                toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
            }
        }
    }

    return {
        sessionId,
        startedAt,
        endedAt,
        durationMs,
        eventCounts,
        statusCounts,
        tokens: computeTokenBreakdown(records, sessionId),
        toolCounts,
    };
}

/**
 * The full session bundle — single JSON object. Embedded in support
 * tickets, copy-pastable in full.
 *
 * Schema-versioned so future bundle consumers can detect format
 * changes. Increment when the shape changes meaningfully.
 */
export interface SessionBundle {
    /** Bundle schema version. Bump on breaking changes. */
    schemaVersion: 1;
    /** When the bundle was generated (not the session timestamp). */
    generatedAt: string;
    /** Session-level summary stats. */
    summary: SessionSummary;
    /** Full timeline: every audit record in the session. */
    timeline: TimelineEntry[];
    /** The raw audit records, included verbatim so consumers don't
     *  have to re-derive anything. Bundle size proportional to session
     *  size; not paginated — sessions are bounded by single agent runs. */
    records: AuditRecord[];
}

/**
 * Build the support bundle for a session. Returns null when the
 * session has no records (caller decides whether that's an error
 * or a no-op).
 */
export function buildSessionBundle(
    records: readonly AuditRecord[],
    sessionId: string
): SessionBundle | null {
    const summary = summarizeSession(records, sessionId);
    if (!summary) { return null; }

    const sessionRecords = records.filter((r) => r.sessionId === sessionId);

    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary,
        timeline: buildTimeline(sessionRecords, { sessionId }),
        records: [...sessionRecords],
    };
}

// ─── Session listing ─────────────────────────────────────────────────

/**
 * Each known session as it appears in the audit log, with enough
 * metadata for a picker UI to show a meaningful list.
 */
export interface SessionListEntry {
    sessionId: string;
    startedAt: string;
    endedAt: string;
    eventCount: number;
    /** Best-effort label: the first non-empty summary string we find,
     *  truncated to 80 chars. Helps users pick the right session
     *  from a list without having to remember UUIDs. */
    label: string;
}

/**
 * Walk records once and produce the unique-session list. Sessions
 * are sorted by startedAt descending (most recent first) — matches
 * what diagnostics pickers want.
 */
export function listSessions(records: readonly AuditRecord[]): SessionListEntry[] {
    const map = new Map<string, SessionListEntry>();

    for (const r of records) {
        const existing = map.get(r.sessionId);
        if (!existing) {
            const label = (r.summary ?? '').slice(0, 80) || `session ${r.sessionId.slice(0, 8)}`;
            map.set(r.sessionId, {
                sessionId: r.sessionId,
                startedAt: r.timestamp,
                endedAt: r.timestamp,
                eventCount: 1,
                label,
            });
        } else {
            existing.eventCount++;
            // endedAt always advances — readRecords returns records
            // in chronological order, so the last one we see for a
            // session id is the latest.
            existing.endedAt = r.timestamp;
        }
    }

    return Array.from(map.values()).sort((a, b) =>
        a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
    );
}