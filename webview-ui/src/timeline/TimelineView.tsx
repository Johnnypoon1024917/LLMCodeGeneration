// webview-ui/src/timeline/TimelineView.tsx
//
// P3.1 — Timeline tab.
//
// Renders the per-task timeline derived from the session event log.
// Span: all sessions for the active feature (per Johnny's choice).
// Refresh: on-demand (button click + initial mount).
//
// Layout:
//   ┌────────────────────────────────────────────────────┐
//   │  Timeline                            [↻ Refresh]   │
//   │  4 sessions · 23 tasks · loaded 2m ago             │
//   ├────────────────────────────────────────────────────┤
//   │  ▼ Session 2026-05-06T14:30                        │
//   │    ┌──────────────────────────────────────────────┐│
//   │    │ ✓ task-3: Implement BookingService            │
//   │    │   2 attempts · 1.4s total                     │
//   │    │   ▼ Attempt 1 (coder) — failed               │
//   │    │     read_file path=src/types.ts (200ms) ✓     │
//   │    │     write_file path=src/...service.ts (1.1s)✓│
//   │    │     verdict: fail                            │
//   │    │     "TS2339: Property 'status' does not..."  │
//   │    │   ▶ Attempt 2 (coder) — passed               │
//   │    └──────────────────────────────────────────────┘│
//   │    ...
//   │  ▶ Session 2026-05-06T11:42                        │
//   └────────────────────────────────────────────────────┘

import { useState, useEffect } from 'react';
import {
    eventsToTimelineModel,
    type TimelineModel,
    type SessionEntry,
    type TaskEntry,
    type AttemptEntry,
} from './reducer';

interface TimelineViewProps {
    /** Live ref to incoming `timelineEvents` payloads. App.tsx
     *  receives these from the host and forwards them via the
     *  setTimelineEvents callback. */
    incomingEvents: { type: string; [k: string]: unknown }[] | null;
    /** Loading state owned by App.tsx — true between request and
     *  response. */
    loading: boolean;
    /** Trigger a refresh. App.tsx wraps this to set loading state
     *  before posting the message. */
    onRefresh: () => void;
}

export function TimelineView({ incomingEvents, loading, onRefresh }: TimelineViewProps) {
    const [model, setModel] = useState<TimelineModel | null>(null);
    const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
    // Per-session and per-task expansion state. Default: newest
    // session expanded, all others collapsed; tasks collapsed by
    // default.
    const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
    const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
    const [expandedAttempts, setExpandedAttempts] = useState<Set<string>>(new Set());

    // Re-derive the model whenever incomingEvents changes.
    useEffect(() => {
        if (!incomingEvents) { return; }
        const next = eventsToTimelineModel(incomingEvents);
        setModel(next);
        setLastRefreshAt(Date.now());
        // Auto-expand newest session for at-a-glance utility.
        if (next.sessions.length > 0) {
            const newest = next.sessions[0]!.sessionStamp;
            setExpandedSessions(new Set([newest]));
        }
    }, [incomingEvents]);

    // Initial fetch on mount.
    useEffect(() => {
        onRefresh();
        // Intentionally fire only once. The user can manually refresh.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleSession = (stamp: string) => {
        setExpandedSessions(prev => {
            const next = new Set(prev);
            if (next.has(stamp)) { next.delete(stamp); } else { next.add(stamp); }
            return next;
        });
    };

    const toggleTask = (key: string) => {
        setExpandedTasks(prev => {
            const next = new Set(prev);
            if (next.has(key)) { next.delete(key); } else { next.add(key); }
            return next;
        });
    };

    const toggleAttempt = (key: string) => {
        setExpandedAttempts(prev => {
            const next = new Set(prev);
            if (next.has(key)) { next.delete(key); } else { next.add(key); }
            return next;
        });
    };

    const totalTasks = model?.sessions.reduce((sum, s) => sum + s.tasks.length, 0) ?? 0;

    return (
        <div style={{ padding: '14px 18px', overflowY: 'auto', height: '100%' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                <div>
                    <div style={{ fontSize: '15px', fontWeight: 600 }}>Timeline</div>
                    <div style={{ fontSize: '11px', opacity: 0.7, marginTop: '2px' }}>
                        {model
                            ? `${model.sessions.length} session${model.sessions.length === 1 ? '' : 's'} · ${totalTasks} task${totalTasks === 1 ? '' : 's'}${
                                lastRefreshAt ? ` · loaded ${formatRelativeTime(lastRefreshAt)}` : ''
                            }`
                            : (loading ? 'Loading...' : 'Click Refresh to load')}
                    </div>
                </div>
                <button
                    className="nexus-btn-secondary"
                    style={{ fontSize: '11px', padding: '4px 10px' }}
                    disabled={loading}
                    onClick={onRefresh}>
                    {loading ? 'Loading...' : '↻ Refresh'}
                </button>
            </div>

            {/* Empty / loading states */}
            {!model && loading && (
                <div style={{ padding: '32px', textAlign: 'center', opacity: 0.7 }}>
                    Loading timeline data...
                </div>
            )}
            {model && model.sessions.length === 0 && (
                <div style={{ padding: '32px', textAlign: 'center', opacity: 0.7 }}>
                    No sessions recorded yet for this feature.
                    <div style={{ fontSize: '11px', marginTop: '8px' }}>
                        Run some tasks and come back — the timeline records reasoning,
                        tool calls, and verifier verdicts as they happen.
                    </div>
                </div>
            )}

            {/* Sessions */}
            {model && model.sessions.length > 0 && (
                <div>
                    {model.sessions.map((session) => (
                        <SessionCard
                            key={session.sessionStamp}
                            session={session}
                            expanded={expandedSessions.has(session.sessionStamp)}
                            onToggle={() => toggleSession(session.sessionStamp)}
                            expandedTasks={expandedTasks}
                            toggleTask={toggleTask}
                            expandedAttempts={expandedAttempts}
                            toggleAttempt={toggleAttempt}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Session card ───────────────────────────────────────────────────

function SessionCard({
    session,
    expanded,
    onToggle,
    expandedTasks,
    toggleTask,
    expandedAttempts,
    toggleAttempt,
}: {
    session: SessionEntry;
    expanded: boolean;
    onToggle: () => void;
    expandedTasks: Set<string>;
    toggleTask: (key: string) => void;
    expandedAttempts: Set<string>;
    toggleAttempt: (key: string) => void;
}) {
    const taskCount = session.tasks.length;
    const completedCount = session.tasks.filter(t => t.status === 'completed').length;
    const failedCount = session.tasks.filter(t => t.status === 'failed').length;
    return (
        <div style={{ marginBottom: '14px', border: '1px solid var(--vscode-widget-border)', borderRadius: '6px', overflow: 'hidden' }}>
            <button
                onClick={onToggle}
                style={{
                    width: '100%',
                    background: 'var(--vscode-editor-inactiveSelectionBackground, transparent)',
                    border: 'none',
                    padding: '8px 12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: 'var(--vscode-foreground)',
                    fontSize: '12px',
                    textAlign: 'left',
                }}>
                <span style={{ opacity: 0.7 }}>{expanded ? '▼' : '▶'}</span>
                <span style={{ fontWeight: 600 }}>
                    Session {formatStamp(session.sessionStamp)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '11px', opacity: 0.7 }}>
                    {taskCount} task{taskCount === 1 ? '' : 's'}
                    {completedCount > 0 && ` · ${completedCount} ✓`}
                    {failedCount > 0 && ` · ${failedCount} ✗`}
                    {session.rawEventCount > 0 && ` · ${session.rawEventCount} events`}
                </span>
            </button>
            {expanded && (
                <div style={{ padding: '8px 12px' }}>
                    {session.tasks.length === 0 ? (
                        <div style={{ fontSize: '11px', opacity: 0.6, padding: '8px 0' }}>
                            No tasks recorded in this session.
                        </div>
                    ) : (
                        session.tasks.map(task => (
                            <TaskCard
                                key={`${session.sessionStamp}::${task.taskKey}`}
                                task={task}
                                sessionStamp={session.sessionStamp}
                                expanded={expandedTasks.has(`${session.sessionStamp}::${task.taskKey}`)}
                                onToggle={() => toggleTask(`${session.sessionStamp}::${task.taskKey}`)}
                                expandedAttempts={expandedAttempts}
                                toggleAttempt={toggleAttempt}
                            />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Task card ──────────────────────────────────────────────────────

function TaskCard({
    task,
    sessionStamp,
    expanded,
    onToggle,
    expandedAttempts,
    toggleAttempt,
}: {
    task: TaskEntry;
    sessionStamp: string;
    expanded: boolean;
    onToggle: () => void;
    expandedAttempts: Set<string>;
    toggleAttempt: (key: string) => void;
}) {
    const statusColor =
        task.status === 'completed' ? 'var(--vscode-testing-iconPassed, #4caf50)' :
        task.status === 'failed' ? 'var(--vscode-testing-iconFailed, #e53935)' :
        task.status === 'running' ? 'var(--vscode-testing-runAction, #1976d2)' :
        'var(--vscode-foreground)';
    const statusIcon = task.status === 'completed' ? '✓' :
                       task.status === 'failed' ? '✗' :
                       task.status === 'running' ? '↻' : '·';
    const totalDuration = task.endedAt && task.startedAt
        ? task.endedAt - task.startedAt
        : null;
    return (
        <div style={{ marginBottom: '6px', borderLeft: `3px solid ${statusColor}`, paddingLeft: '10px' }}>
            <button
                onClick={onToggle}
                style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    padding: '6px 0',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: 'var(--vscode-foreground)',
                    fontSize: '12px',
                    textAlign: 'left',
                }}>
                <span style={{ opacity: 0.7, fontSize: '10px' }}>{expanded ? '▼' : '▶'}</span>
                <span style={{ color: statusColor, fontWeight: 600 }}>{statusIcon}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {task.title}
                </span>
                <span style={{ fontSize: '10px', opacity: 0.6, whiteSpace: 'nowrap' }}>
                    {task.attempts.length} attempt{task.attempts.length === 1 ? '' : 's'}
                    {totalDuration !== null && ` · ${formatDuration(totalDuration)}`}
                    {(task.tokensTotal.promptTokens + task.tokensTotal.completionTokens) > 0 && (
                        ` · ${formatTokenCount(task.tokensTotal.promptTokens + task.tokensTotal.completionTokens)} tok`
                    )}
                </span>
            </button>
            {expanded && task.attempts.length > 0 && (
                <div style={{ paddingLeft: '20px', paddingTop: '4px' }}>
                    {Object.keys(task.tokensByPhase).length > 0 && (
                        <div style={{
                            marginBottom: '6px',
                            display: 'flex',
                            gap: '8px',
                            flexWrap: 'wrap',
                            fontSize: '10px',
                            opacity: 0.75,
                        }}>
                            {(['planner', 'coder', 'verifier', 'unknown'] as const).map(phase => {
                                const usage = task.tokensByPhase[phase];
                                if (!usage || (usage.promptTokens + usage.completionTokens) === 0) { return null; }
                                return (
                                    <span key={phase} style={{
                                        padding: '1px 6px',
                                        borderRadius: '3px',
                                        background: 'var(--vscode-badge-background)',
                                        color: 'var(--vscode-badge-foreground)',
                                    }}>
                                        {phase}: {formatTokenCount(usage.promptTokens + usage.completionTokens)} tok
                                    </span>
                                );
                            })}
                        </div>
                    )}                    {task.attempts.map(attempt => (
                        <AttemptBlock
                            key={`${sessionStamp}::${task.taskKey}::${attempt.attemptN}`}
                            attempt={attempt}
                            attemptKey={`${sessionStamp}::${task.taskKey}::${attempt.attemptN}`}
                            expanded={expandedAttempts.has(`${sessionStamp}::${task.taskKey}::${attempt.attemptN}`)}
                            onToggle={() => toggleAttempt(`${sessionStamp}::${task.taskKey}::${attempt.attemptN}`)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Attempt block ──────────────────────────────────────────────────

function AttemptBlock({
    attempt,
    attemptKey: _attemptKey,
    expanded,
    onToggle,
}: {
    attempt: AttemptEntry;
    attemptKey: string;
    expanded: boolean;
    onToggle: () => void;
}) {
    const verdictColor =
        attempt.verdict === 'pass' ? 'var(--vscode-testing-iconPassed, #4caf50)' :
        attempt.verdict === 'fail' ? 'var(--vscode-testing-iconFailed, #e53935)' :
        'var(--vscode-foreground)';
    return (
        <div style={{ marginBottom: '6px', fontSize: '11px' }}>
            <button
                onClick={onToggle}
                style={{
                    width: '100%',
                    background: 'transparent',
                    border: 'none',
                    padding: '4px 0',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    color: 'var(--vscode-foreground)',
                    fontSize: '11px',
                    textAlign: 'left',
                }}>
                <span style={{ opacity: 0.7, fontSize: '9px' }}>{expanded ? '▼' : '▶'}</span>
                <span style={{ fontWeight: 600 }}>Attempt {attempt.attemptN}</span>
                <span style={{
                    padding: '1px 6px',
                    fontSize: '10px',
                    borderRadius: '3px',
                    background: 'var(--vscode-badge-background)',
                    color: 'var(--vscode-badge-foreground)',
                }}>
                    {attempt.phase}
                </span>
                {attempt.verdict && (
                    <span style={{ color: verdictColor, fontSize: '10px', marginLeft: '4px' }}>
                        — {attempt.verdict === 'pass' ? 'passed' : 'failed'}
                    </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '10px', opacity: 0.6 }}>
                    {attempt.toolCalls.length} tool call{attempt.toolCalls.length === 1 ? '' : 's'}
                </span>
            </button>
            {expanded && (
                <div style={{ paddingLeft: '14px', paddingTop: '2px' }}>
                    {attempt.reasoningPreview && (
                        <div style={{
                            marginBottom: '6px',
                            padding: '6px 8px',
                            background: 'var(--vscode-textBlockQuote-background, rgba(0,0,0,0.05))',
                            borderLeft: '2px solid var(--vscode-textBlockQuote-border, var(--vscode-widget-border))',
                            fontSize: '10px',
                            opacity: 0.85,
                            whiteSpace: 'pre-wrap',
                            fontStyle: 'italic',
                        }}>
                            {attempt.reasoningPreview.length > 400
                                ? attempt.reasoningPreview.slice(0, 400) + '...'
                                : attempt.reasoningPreview}
                        </div>
                    )}
                    {(attempt.tokens.promptTokens + attempt.tokens.completionTokens) > 0 && (
                        <div style={{
                            marginBottom: '4px',
                            fontSize: '10px',
                            opacity: 0.7,
                            fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        }}>
                            Tokens: {formatTokenCount(attempt.tokens.promptTokens + attempt.tokens.completionTokens)} (prompt {formatTokenCount(attempt.tokens.promptTokens)} / completion {formatTokenCount(attempt.tokens.completionTokens)})
                        </div>
                    )}
                    {attempt.toolCalls.length > 0 && (
                        <div style={{ marginBottom: '4px' }}>
                            {attempt.toolCalls.map((tc) => (
                                <ToolCallRow key={tc.id} tc={tc} />
                            ))}
                        </div>
                    )}
                    {attempt.failureMessage && (
                        <div style={{
                            marginTop: '6px',
                            padding: '6px 8px',
                            background: 'rgba(229, 57, 53, 0.08)',
                            borderLeft: '2px solid var(--vscode-testing-iconFailed, #e53935)',
                            fontSize: '10px',
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        }}>
                            {attempt.failureMessage}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Tool call row ──────────────────────────────────────────────────

function ToolCallRow({ tc }: { tc: AttemptEntry['toolCalls'][number] }) {
    const statusIcon =
        tc.status === 'completed' ? '✓' :
        tc.status === 'failed' ? '✗' :
        tc.status === 'rejected' ? '⊘' :
        tc.status === 'running' ? '↻' : '·';
    const statusColor =
        tc.status === 'completed' ? 'var(--vscode-testing-iconPassed, #4caf50)' :
        tc.status === 'failed' ? 'var(--vscode-testing-iconFailed, #e53935)' :
        tc.status === 'rejected' ? 'var(--vscode-testing-iconFailed, #e53935)' :
        'var(--vscode-foreground)';
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0', fontSize: '10px' }}>
            <span style={{ color: statusColor, width: '12px', textAlign: 'center' }}>{statusIcon}</span>
            <span style={{ fontWeight: 600 }}>{tc.name}</span>
            <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {tc.argsSummary}
            </span>
            {tc.durationMs !== undefined && (
                <span style={{ opacity: 0.5 }}>{formatDuration(tc.durationMs)}</span>
            )}
            {tc.wasApprovalGated && (
                <span style={{
                    padding: '0 4px',
                    fontSize: '9px',
                    borderRadius: '3px',
                    background: 'var(--vscode-badge-background)',
                    color: 'var(--vscode-badge-foreground)',
                    opacity: 0.7,
                }}>gate</span>
            )}
        </div>
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    if (ms < 1000) { return `${ms}ms`; }
    if (ms < 60_000) { return `${(ms / 1000).toFixed(1)}s`; }
    return `${(ms / 60_000).toFixed(1)}m`;
}

/** Compact token count for chips: 1234 → "1.2k", 12345 → "12k", under
 *  1000 → as-is. Returns "0" rather than "0.0k" for clean zero case. */
function formatTokenCount(n: number): string {
    if (n === 0) { return '0'; }
    if (n < 1000) { return n.toLocaleString(); }
    if (n < 10_000) { return `${(n / 1000).toFixed(1)}k`; }
    return `${Math.round(n / 1000)}k`;
}

function formatRelativeTime(epochMs: number): string {
    const diffMs = Date.now() - epochMs;
    if (diffMs < 5_000) { return 'just now'; }
    if (diffMs < 60_000) { return `${Math.floor(diffMs / 1000)}s ago`; }
    if (diffMs < 3_600_000) { return `${Math.floor(diffMs / 60_000)}m ago`; }
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
}

function formatStamp(stamp: string): string {
    // 2026-05-06T11-42-13-mmm → 2026-05-06 11:42:13
    const m = stamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) { return stamp; }
    return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
}