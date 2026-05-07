// webview-ui/src/timeline/reducer.ts
//
// P3.1 — Telemetry + diagnostics, bundle 1.
//
// Pure function: raw JSONL event stream → TimelineModel for the
// Timeline tab. Lives separately from the React component so it's
// testable and reusable.
//
// Input shape: an array of recorded events as they appear in
// .nexus/sessions/<feature>/events-*.jsonl. Each line is a JSON
// object with at minimum: type, timestamp, sessionStamp, and the
// rest of the original webview-message payload.
//
// Output shape: TimelineModel — sessions[].tasks[].attempts[].
//
// Tolerance: malformed events are skipped silently. The reducer
// never throws on bad input.

export interface RawEvent {
    type: string;
    timestamp?: number;
    /** Filename stamp of the session this event came from. Used to
     *  group events by session boundary. The host injects this when
     *  reading events-*.jsonl files for the "all sessions" span. */
    sessionStamp?: string;
    /** All other fields from the original message — task, taskKey,
     *  toolCallId, name, args, etc. Type loose because the event
     *  vocabulary is wide and evolving. */
    [k: string]: unknown;
}

export interface ToolCallEntry {
    id: string;
    name: string;
    /** Best-effort first-line summary of the tool's args (e.g. file
     *  path for read_file). For UI display only — not authoritative. */
    argsSummary: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected';
    /** True if this tool was an approval-gated tool (write_file etc.)
     *  and the user explicitly approved or rejected. Drives a small
     *  badge in the UI. */
    wasApprovalGated?: boolean;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
}

export interface AttemptEntry {
    attemptN: number;
    /** Phase that owned this attempt. Most attempts are 'coder'. */
    phase: 'planner' | 'coder' | 'verifier' | 'unknown';
    toolCalls: ToolCallEntry[];
    /** Reasoning text accumulated from streamReasoning events
     *  during this attempt. Truncated for display. */
    reasoningPreview: string;
    /** Verdict from the verifier when this attempt finished. */
    verdict?: 'pass' | 'fail';
    failureMessage?: string;
    startedAt: number;
    endedAt?: number;
    /** P3.1 bundle 2: token usage for this attempt. Sum of all
     *  tokenUsage events that arrived while this attempt was current.
     *  Zero if no events arrived (or attribution failed). */
    tokens: TokenUsage;
}

export interface TaskEntry {
    /** Stable key for the task — typically the task descriptor or
     *  taskKey from the planner's task list (e.g. "task-3"). */
    taskKey: string;
    /** Human-readable title. Derived from the first agentStep event
     *  for this task, or falls back to taskKey if missing. */
    title: string;
    status: 'completed' | 'failed' | 'running' | 'unknown';
    startedAt: number;
    endedAt?: number;
    attempts: AttemptEntry[];
    /** P3.1 bundle 2: aggregated token usage across all attempts.
     *  Computed at reduce-time so the UI doesn't have to re-sum. */
    tokensTotal: TokenUsage;
    /** Per-phase breakdown for the task chip. Only includes phases
     *  that contributed; missing keys are treated as zero. */
    tokensByPhase: Partial<Record<'planner' | 'coder' | 'verifier' | 'unknown', TokenUsage>>;
}

export interface SessionEntry {
    sessionStamp: string;
    /** Parsed datetime for sorting + display. */
    startedAt: number;
    tasks: TaskEntry[];
    /** Number of events ingested into this session — useful for the
     *  UI to show "(empty session — no recordable activity)". */
    rawEventCount: number;
}

export interface TimelineModel {
    sessions: SessionEntry[];
    /** Total events processed across all sessions (debug stat). */
    rawEventCount: number;
}

// ---------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------

/**
 * Turn raw events into a structured timeline. The function is pure
 * and tolerant — anything weird gets skipped.
 *
 * Algorithm:
 *   1. Bucket events by sessionStamp. Events without a sessionStamp
 *      go into a synthetic 'unknown' session at the end.
 *   2. Inside each session, walk events in timestamp order.
 *   3. Track the "current task" — set by agentStep events with a
 *      task field, cleared by approveTask / cancelTask / fail.
 *   4. Track the "current attempt" — incremented by taskRetry events.
 *   5. Tool lifecycle events (toolCallEvent) populate the current
 *      attempt's toolCalls.
 *
 * State diagram (per task):
 *
 *   no task → agentStep(task=X) → task X running, attempt 1
 *           → toolCallEvent → attempt 1 toolCalls[]
 *           → taskRetry → task X attempt 2
 *           → approveTask → task X completed
 *           → fail → task X failed
 */
export function eventsToTimelineModel(events: RawEvent[]): TimelineModel {
    // Pass 1: group by sessionStamp.
    const bySession = new Map<string, RawEvent[]>();
    for (const ev of events) {
        if (!ev || typeof ev.type !== 'string') { continue; }
        const stamp = typeof ev.sessionStamp === 'string' ? ev.sessionStamp : 'unknown';
        let bucket = bySession.get(stamp);
        if (!bucket) {
            bucket = [];
            bySession.set(stamp, bucket);
        }
        bucket.push(ev);
    }

    // Pass 2: build SessionEntry per group.
    const sessions: SessionEntry[] = [];
    for (const [sessionStamp, bucket] of bySession.entries()) {
        // Sort events within a session by timestamp (defensively —
        // they should be in order on disk but we don't trust it).
        bucket.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        const session = reduceSession(sessionStamp, bucket);
        sessions.push(session);
    }

    // Sort sessions by startedAt descending — newest first.
    sessions.sort((a, b) => b.startedAt - a.startedAt);

    return { sessions, rawEventCount: events.length };
}

function reduceSession(sessionStamp: string, events: RawEvent[]): SessionEntry {
    const startedAt = parseSessionStamp(sessionStamp) ?? (Number(events[0]?.timestamp) || Date.now());
    const tasksByKey = new Map<string, TaskEntry>();
    let currentTaskKey: string | null = null;
    let currentAttempt: AttemptEntry | null = null;

    const ensureTask = (key: string, hint?: { title?: string; phase?: AttemptEntry['phase']; ts?: number }): TaskEntry => {
        let task = tasksByKey.get(key);
        if (!task) {
            task = {
                taskKey: key,
                title: hint?.title || key,
                status: 'running',
                startedAt: hint?.ts ?? Date.now(),
                attempts: [],
                tokensTotal: { promptTokens: 0, completionTokens: 0 },
                tokensByPhase: {},
            };
            tasksByKey.set(key, task);
        } else if (hint?.title && task.title === task.taskKey) {
            // Upgrade title from key to a better one if we got a hint
            // later in the stream.
            task.title = hint.title;
        }
        return task;
    };

    const ensureAttempt = (task: TaskEntry, phase: AttemptEntry['phase'], ts: number): AttemptEntry => {
        if (currentAttempt && task.attempts[task.attempts.length - 1] === currentAttempt) {
            return currentAttempt;
        }
        const attempt: AttemptEntry = {
            attemptN: task.attempts.length + 1,
            phase,
            toolCalls: [],
            reasoningPreview: '',
            startedAt: ts,
            tokens: { promptTokens: 0, completionTokens: 0 },
        };
        task.attempts.push(attempt);
        currentAttempt = attempt;
        return attempt;
    };

    const closeAttempt = (verdict: 'pass' | 'fail', failureMessage: string | undefined, ts: number) => {
        if (!currentAttempt) { return; }
        currentAttempt.verdict = verdict;
        if (failureMessage) { currentAttempt.failureMessage = failureMessage; }
        currentAttempt.endedAt = ts;
    };

    for (const ev of events) {
        const ts = Number(ev.timestamp) || 0;

        switch (ev.type) {
            case 'agentStep': {
                // agentStep events tell us a step is starting in some phase.
                // task field identifies which task. description gives the title.
                const taskKey = stringField(ev, 'task') || stringField(ev, 'taskKey');
                if (!taskKey) { break; }
                currentTaskKey = taskKey;
                const stepType = stringField(ev, 'stepType') ?? '';
                const phase: AttemptEntry['phase'] =
                    stepType.includes('plan') ? 'planner' :
                    stepType.includes('verif') ? 'verifier' :
                    stepType.includes('code') || stepType.includes('coder') ? 'coder' :
                    'unknown';
                const description = stringField(ev, 'description') || stringField(ev, 'message') || taskKey;
                const task = ensureTask(taskKey, { title: description, ts });
                ensureAttempt(task, phase, ts);
                break;
            }

            case 'taskRetry': {
                // Retry boundary — close current attempt as failed,
                // start a new attempt under the same task.
                const taskKey = stringField(ev, 'task') || stringField(ev, 'taskKey') || currentTaskKey;
                if (!taskKey) { break; }
                const task = ensureTask(taskKey, { ts });
                closeAttempt('fail', stringField(ev, 'reason'), ts);
                currentAttempt = null;
                ensureAttempt(task, 'coder', ts);
                break;
            }

            case 'approveTask':
            case 'taskComplete': {
                const tk: string | null = stringField(ev, 'task') || stringField(ev, 'taskKey') || currentTaskKey;
                if (!tk) { break; }
                const task = tasksByKey.get(tk);
                if (!task) { break; }
                task.status = 'completed';
                task.endedAt = ts;
                closeAttempt('pass', undefined, ts);
                if (currentTaskKey === tk) { currentTaskKey = null; }
                currentAttempt = null;
                break;
            }

            case 'rejectTask':
            case 'taskFailed': {
                const tk: string | null = stringField(ev, 'task') || stringField(ev, 'taskKey') || currentTaskKey;
                if (!tk) { break; }
                const task = tasksByKey.get(tk);
                if (!task) { break; }
                task.status = 'failed';
                task.endedAt = ts;
                closeAttempt('fail', stringField(ev, 'reason') || stringField(ev, 'critique'), ts);
                if (currentTaskKey === tk) { currentTaskKey = null; }
                currentAttempt = null;
                break;
            }

            case 'crossTaskRegression': {
                // Cross-task regression detected after a task completed.
                // We surface it as a synthetic note on the source task.
                const sourceTaskKey = stringField(ev, 'sourceTaskKey');
                if (!sourceTaskKey) { break; }
                const task = tasksByKey.get(sourceTaskKey);
                if (!task) { break; }
                // Append a note to the last attempt's failureMessage.
                const lastAttempt = task.attempts[task.attempts.length - 1];
                if (lastAttempt) {
                    const note = `[cross-task regression: ${stringField(ev, 'errors') || 'compile errors detected'}]`;
                    lastAttempt.failureMessage = lastAttempt.failureMessage
                        ? `${lastAttempt.failureMessage}\n${note}`
                        : note;
                }
                break;
            }

            case 'toolCallEvent': {
                // Tool lifecycle. Each event has a phase: 'started' |
                // 'completed' | 'failed' | 'argChunk'. We only care
                // about started/completed/failed for the timeline.
                const phase = stringField(ev, 'phase');
                const toolCallId = stringField(ev, 'toolCallId');
                if (!toolCallId || !currentAttempt) { break; }
                // After the guard above, currentAttempt is non-null.
                // TS's flow analysis loses the narrowing across the
                // for-loop iterations because closures (closeAttempt,
                // ensureAttempt) mutate it. We re-assert here.
                const att = currentAttempt as AttemptEntry;
                let entry = att.toolCalls.find((t: ToolCallEntry) => t.id === toolCallId);
                if (phase === 'started') {
                    if (!entry) {
                        const name = stringField(ev, 'name') || 'unknown';
                        const args = (ev as Record<string, unknown>)['args'];
                        entry = {
                            id: toolCallId,
                            name,
                            argsSummary: summarizeArgs(args),
                            startedAt: ts,
                            status: 'running',
                            wasApprovalGated: name === 'write_file' || name === 'edit_file',
                        };
                        att.toolCalls.push(entry);
                    }
                } else if (phase === 'completed') {
                    if (!entry) { break; }
                    entry.endedAt = ts;
                    if (entry.startedAt) { entry.durationMs = ts - entry.startedAt; }
                    entry.status = 'completed';
                } else if (phase === 'failed') {
                    if (!entry) { break; }
                    entry.endedAt = ts;
                    if (entry.startedAt) { entry.durationMs = ts - entry.startedAt; }
                    entry.status = 'failed';
                }
                break;
            }

            case 'streamReasoning': {
                // Accumulate reasoning text into the current attempt
                // for the preview. Cap length so very long reasoning
                // doesn't blow up the model size.
                if (!currentAttempt) { break; }
                const att = currentAttempt as AttemptEntry;
                const token = stringField(ev, 'token');
                if (!token) { break; }
                if (att.reasoningPreview.length < 2000) {
                    att.reasoningPreview += token;
                }
                break;
            }

            case 'tokenUsage': {
                // P3.1 bundle 2: token usage event tagged with the
                // agent phase that produced it (host adds `phase` at
                // emit time; older events without it default to
                // 'unknown' which we still track).
                //
                // We read the standard OpenAI usage shape:
                //   { prompt_tokens, completion_tokens, total_tokens }
                // The `usage` field is the inner object.
                const usage = (ev as Record<string, unknown>)['usage'];
                if (!usage || typeof usage !== 'object') { break; }
                const u = usage as Record<string, unknown>;
                const promptTokens = typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0;
                const completionTokens = typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0;
                const phaseRaw = stringField(ev, 'phase') ?? 'unknown';
                const phase: 'planner' | 'coder' | 'verifier' | 'unknown' =
                    phaseRaw === 'planner' || phaseRaw === 'coder' || phaseRaw === 'verifier' ? phaseRaw : 'unknown';

                // Resolve the task. Prefer event.task; fall back to
                // currentTaskKey. If neither resolves, drop — we
                // can't attribute.
                const taskKey: string | null = stringField(ev, 'task') || currentTaskKey;
                if (!taskKey) { break; }
                const task = tasksByKey.get(taskKey);
                if (!task) { break; }

                // Update task aggregates.
                task.tokensTotal.promptTokens += promptTokens;
                task.tokensTotal.completionTokens += completionTokens;
                const existingPhaseTotal = task.tokensByPhase[phase];
                if (existingPhaseTotal) {
                    existingPhaseTotal.promptTokens += promptTokens;
                    existingPhaseTotal.completionTokens += completionTokens;
                } else {
                    task.tokensByPhase[phase] = { promptTokens, completionTokens };
                }

                // Update current attempt if there is one. Some
                // tokenUsage events arrive between attempts (e.g.,
                // between Coder and Verifier) — those we let fall
                // into task aggregate only.
                if (currentAttempt) {
                    const att = currentAttempt as AttemptEntry;
                    att.tokens.promptTokens += promptTokens;
                    att.tokens.completionTokens += completionTokens;
                }
                break;
            }

            // Other event types (chatToken, statusUpdate, etc.) don't
            // affect the structural timeline — skip silently.
            default:
                break;
        }
    }

    // Finalize: any task without explicit terminal event is "running"
    // (or "unknown" if it has no attempts at all).
    const tasks = Array.from(tasksByKey.values());
    for (const task of tasks) {
        if (task.attempts.length === 0) {
            task.status = 'unknown';
        }
    }

    // Sort tasks by startedAt ascending — chronological within a
    // session matches how the user lived through them.
    tasks.sort((a, b) => a.startedAt - b.startedAt);

    return {
        sessionStamp,
        startedAt,
        tasks,
        rawEventCount: events.length,
    };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function stringField(obj: RawEvent, key: string): string | undefined {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
}

/**
 * Best-effort one-line summary of tool args for display. Strategy:
 *   - For string-keyed objects, prefer common fields: path, command,
 *     file, name, query.
 *   - Fall back to a JSON-stringify capped at 80 chars.
 */
function summarizeArgs(args: unknown): string {
    if (typeof args !== 'object' || args === null) {
        return typeof args === 'string' ? args.slice(0, 80) : '';
    }
    const obj = args as Record<string, unknown>;
    for (const key of ['path', 'command', 'file', 'filepath', 'name', 'query', 'pattern']) {
        if (typeof obj[key] === 'string') {
            return `${key}=${(obj[key] as string).slice(0, 80)}`;
        }
    }
    try {
        const s = JSON.stringify(args);
        return s.length > 80 ? s.slice(0, 77) + '...' : s;
    } catch {
        return '[object]';
    }
}

/**
 * Parse the session's filename stamp ("2026-05-06T11-42-13-mmm") back
 * into epoch ms. Returns null on parse failure.
 */
function parseSessionStamp(stamp: string): number | null {
    if (!stamp || stamp === 'unknown') { return null; }
    const isoLike = stamp.replace(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/,
        (_m, date, h, mm, s, ms) => `${date}T${h}:${mm}:${s}${ms ? '.' + ms : ''}Z`
    );
    const ts = Date.parse(isoLike);
    return Number.isNaN(ts) ? null : ts;
}