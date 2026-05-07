// src/sessions/SessionEventStore.ts
//
// V2.2 hotfix #2 — session replay foundation (sub-bundle 2a).
//
// Persistent event log for replaying agent activity across VS Code
// reloads / webview reconnects. Without this, when the user reloads
// VS Code mid-task, the host's still-running agent has no way to
// re-show its tool cards / reasoning / approvals to the new webview
// instance — and the user sees a stuck "Drafting..." spinner with
// no underlying state to inspect.
//
// Architecture:
//
//   .nexus/sessions/<feature>/
//     current.txt                       — pointer to active log file
//     events-2026-05-06T11-42-13.jsonl  — append-only event log
//     events-2026-05-06T13-15-00.jsonl  — newer session (each Start Over
//                                         or app launch starts a new one)
//
// Write path: postMessage interception in SidebarProvider calls
// recordEvent() with whitelisted event types. Writes are async and
// fire-and-forget — UI dispatch never waits for disk IO. A serial
// queue inside the store ensures appends happen in order even if
// many events are emitted in the same tick.
//
// Read path (used by 2b replay): readActiveLog() returns the parsed
// event array for the active session, or null if no log exists.
//
// What gets recorded vs not:
//   YES: toolCallEvent, chatToken, structureResponse,
//        featureChanged, phaseStateUpdated, taskStarted, taskCompleted,
//        taskFailed, taskRetry, requestToolApproval, approvalResolved,
//        crossTaskRegression, statusUpdate, allTasksCompleted
//   NO:  initState (replay's job), error toasts, debug logs

import * as vscode from 'vscode';
import { log } from '../logger';

/**
 * Event types whose payloads belong in the replay log. Anything not
 * in this set bypasses the recorder. Adding a new event type here is
 * the standard way to make it replayable.
 *
 * Note: this is checked against the message's `type` field. Event
 * types use camelCase consistently across the codebase.
 */
const RECORDABLE_EVENT_TYPES = new Set<string>([
    // Streamed agent output (chat tokens emitted during planning,
    // coding, and verifier execution).
    'chatToken',

    // V2.2 hotfix-cleanup-and-rest (2c): live-stream tokens that were
    // previously not recorded. Without these, replay after reload
    // showed tool cards but no reasoning narrative. Now the
    // reasoning text replays alongside cards.
    'streamReasoning',
    'agentStep',

    // P3.1 bundle 2: token usage events. Persisted so:
    //   1. Timeline shows accurate totals after reload
    //   2. Future admin portal can read usage from disk for org-wide
    //      reporting (read-only consumer of .nexus/sessions/)
    // Each event includes phase tagging (planner/coder/verifier) so
    // breakdown by agent is computable downstream.
    'tokenUsage',

    // Tool lifecycle (read_file, write_file, list_directory, bash etc.).
    // Each tool call produces 2-3 events: started, optional output, completed.
    'toolCallEvent',

    // High-level task lifecycle.
    'taskStarted',
    'taskCompleted',
    'taskFailed',
    'taskRetry',
    'allTasksCompleted',

    // Plan generation.
    'structureResponse',

    // Spec / phase state transitions.
    'featureChanged',
    'phaseStateUpdated',

    // Approval flow.
    'requestToolApproval',
    'approvalResolved',

    // V2.2 cross-task analysis.
    'crossTaskRegression',

    // Status text shown in status bar — useful for replay context.
    'statusUpdate',
]);

/** Recorded event with a wall-clock timestamp for replay ordering. */
export interface RecordedEvent {
    /** ISO timestamp at recordEvent() time. */
    ts: string;
    /** The event payload as posted to the webview. */
    payload: { type: string; [k: string]: unknown };
}

/**
 * Returns true if the given message payload should be persisted.
 * Lightweight check used by the postMessage wrapper.
 */
export function isRecordable(payload: unknown): payload is { type: string } {
    if (!payload || typeof payload !== 'object') { return false; }
    const t = (payload as { type?: unknown }).type;
    return typeof t === 'string' && RECORDABLE_EVENT_TYPES.has(t);
}

/**
 * Per-feature event log writer. One instance per running SidebarProvider.
 * Internally manages a serial write queue so appends never interleave.
 */
export class SessionEventStore {
    private readonly workspaceRoot: vscode.Uri;
    /** Slug of the feature we're currently recording for. Cached so
     *  every recordEvent() doesn't have to ask the SpecManager. Updated
     *  via setActiveFeature() on featureChanged. */
    private activeFeature: string;
    /** Resolved log file URI for the active session. Computed lazily
     *  on first write — avoids creating empty log files for sessions
     *  that never see a recordable event (rare but possible). */
    private activeLogUri: vscode.Uri | null = null;
    /** Serial write queue. We chain promises so each appendFile call
     *  waits for the previous one to finish. Without this, parallel
     *  awaits could interleave bytes mid-line and corrupt JSONL. */
    private writeChain: Promise<void> = Promise.resolve();
    /** Fixed at construction time — used in log filename for new
     *  sessions that don't yet have a current.txt pointer. */
    private readonly sessionStamp: string;

    constructor(workspaceRoot: vscode.Uri, activeFeature: string) {
        this.workspaceRoot = workspaceRoot;
        this.activeFeature = activeFeature;
        // Filesystem-safe ISO stamp: replace : with - so the filename
        // works on Windows. Resolution to seconds is sufficient.
        this.sessionStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
    }

    /** Update which feature future recordEvent() calls log under. */
    setActiveFeature(featureSlug: string): void {
        if (featureSlug !== this.activeFeature) {
            this.activeFeature = featureSlug;
            // Force re-resolution of the log URI on next write.
            this.activeLogUri = null;
        }
    }

    /**
     * Begin a fresh session for the active feature. Used by Start Over
     * and after the webview restores fully from a previous log (a
     * "fresh page" cue). Writes a new current.txt pointer and creates
     * the new log file lazily on the first recorded event.
     *
     * V2.2 hotfix-cleanup-and-rest (2d): also runs rotation. Old
     * session logs that exceed the retention policy get deleted to
     * keep .nexus/sessions/ bounded. Without this, heavy use over
     * weeks would accrete tens of MB. Cleanup is best-effort — failures
     * are logged but don't block session creation.
     */
    async startNewSession(): Promise<void> {
        const featureDir = this.featureDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
        const newLogUri = vscode.Uri.joinPath(featureDir, `events-${stamp}.jsonl`);
        const pointerUri = vscode.Uri.joinPath(featureDir, 'current.txt');
        try {
            await vscode.workspace.fs.createDirectory(featureDir);
            await vscode.workspace.fs.writeFile(pointerUri, Buffer.from(stamp, 'utf8'));
            this.activeLogUri = newLogUri;
        } catch (e) {
            log.warn('[startNewSession] failed:', String(e));
        }
        // Cleanup runs after the new session is in place. We don't
        // await this — the caller doesn't care, and if cleanup is slow
        // (lots of files) it shouldn't delay startup of the new session.
        this.runRotation().catch((e) => log.warn('[runRotation] failed:', String(e)));
    }

    /**
     * Rotation policy for old session logs.
     *
     * Rules (applied in order):
     *   1. Delete any log older than MAX_AGE_DAYS based on its embedded
     *      timestamp (extracted from "events-<stamp>.jsonl").
     *   2. After age-based cleanup, if we still have more than
     *      MAX_LOGS_PER_FEATURE logs, delete the oldest ones until
     *      we're at the cap.
     *
     * The current.txt pointer is never deleted — that would orphan the
     * active session.
     *
     * Why timestamp from filename rather than file mtime:
     *   - Remote workspaces (SSH, dev containers) may report wrong mtime
     *   - Easier to reason about and test
     *   - The filename stamp is set at session start, which is the
     *     "logical age" we actually care about
     */
    private async runRotation(): Promise<void> {
        const MAX_LOGS_PER_FEATURE = 5;
        const MAX_AGE_DAYS = 30;
        const cutoffMs = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const featureDir = this.featureDir();

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(featureDir);
        } catch {
            return; // Directory doesn't exist; nothing to clean.
        }

        // Filter to event log files only (not current.txt or other).
        // Parse the embedded timestamp for age sorting.
        const logs: { name: string; uri: vscode.Uri; ts: number }[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File) { continue; }
            if (!name.startsWith('events-') || !name.endsWith('.jsonl')) { continue; }
            // Filename: events-2026-05-06T11-42-13-mmm.jsonl
            // Extract everything between "events-" and ".jsonl", reverse
            // the dash-replacement we did at write time.
            const stamp = name.slice('events-'.length, -'.jsonl'.length);
            // Restore the colons/dot we replaced in sessionStamp construction:
            // "2026-05-06T11-42-13-mmm" → "2026-05-06T11:42:13.mmm".
            // We rebuild a parseable Date string. If parsing fails (e.g.,
            // an unrelated file slipped through), skip the log.
            const isoLike = stamp.replace(
                /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?$/,
                (_m, date, h, mm, s, ms) => `${date}T${h}:${mm}:${s}${ms ? '.' + ms : ''}Z`
            );
            const ts = Date.parse(isoLike);
            if (Number.isNaN(ts)) { continue; }
            logs.push({ name, uri: vscode.Uri.joinPath(featureDir, name), ts });
        }

        // Pass 1: age-based deletion.
        const survivedAge: typeof logs = [];
        for (const entry of logs) {
            if (entry.ts < cutoffMs) {
                try {
                    await vscode.workspace.fs.delete(entry.uri);
                    log.info(`[SessionEventStore] rotated out (age): ${entry.name}`);
                } catch (e) {
                    log.warn(`[SessionEventStore] failed to delete ${entry.name}:`, String(e));
                    survivedAge.push(entry); // Keep in count if we can't delete.
                }
            } else {
                survivedAge.push(entry);
            }
        }

        // Pass 2: count-based deletion. Keep the N newest.
        if (survivedAge.length > MAX_LOGS_PER_FEATURE) {
            // Sort newest first.
            survivedAge.sort((a, b) => b.ts - a.ts);
            const toDelete = survivedAge.slice(MAX_LOGS_PER_FEATURE);
            for (const entry of toDelete) {
                try {
                    await vscode.workspace.fs.delete(entry.uri);
                    log.info(`[SessionEventStore] rotated out (count): ${entry.name}`);
                } catch (e) {
                    log.warn(`[SessionEventStore] failed to delete ${entry.name}:`, String(e));
                }
            }
        }
    }

    /**
     * Append an event to the active log. Fire-and-forget from the
     * caller's perspective — internally chained so writes serialize.
     * Errors are caught and logged; we never crash the host on a
     * recording failure. Worst case: replay shows a partial session.
     */
    recordEvent(payload: { type: string; [k: string]: unknown }): void {
        const event: RecordedEvent = {
            ts: new Date().toISOString(),
            payload,
        };
        // Serialize ahead of the chain so payload mutations after
        // recordEvent() returns don't affect what's persisted.
        const line = JSON.stringify(event) + '\n';
        this.writeChain = this.writeChain.then(() => this.appendLine(line)).catch((e) => {
            log.warn('[recordEvent] write failed:', String(e));
        });
    }

    /**
     * Read all events from the active session log. Returns null if
     * no log exists for this feature. Used by 2b replay path on
     * webview connect.
     *
     * Parse failures (corrupt lines from interrupted writes) are
     * logged and skipped — we return whatever we could parse rather
     * than throwing. Better partial replay than no replay.
     */
    async readActiveLog(): Promise<RecordedEvent[] | null> {
        try {
            const logUri = await this.resolveActiveLogUri();
            if (!logUri) { return null; }
            const data = await vscode.workspace.fs.readFile(logUri);
            const text = new TextDecoder().decode(data);
            const events: RecordedEvent[] = [];
            for (const line of text.split('\n')) {
                if (!line.trim()) { continue; }
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object' && parsed.payload) {
                        events.push(parsed as RecordedEvent);
                    }
                } catch (e) {
                    // Corrupt line. Most likely an interrupted write
                    // mid-flush. Skip and keep going.
                    log.warn('[readActiveLog] skipping corrupt line:', String(e));
                }
            }
            return events;
        } catch (e) {
            // ENOENT or similar — log doesn't exist yet.
            return null;
        }
    }

    /**
     * P3.1 (telemetry timeline): read every event log in the active
     * feature's session directory and return them as a flat list,
     * each event tagged with the sessionStamp it came from.
     *
     * Used by the Timeline tab when the user picks "all sessions
     * for this feature" span. Bounded by the V2.2 rotation policy
     * (max 5 logs per feature) so worst case is 5 small file reads.
     *
     * Each returned event has the standard RecordedEvent shape plus
     * a `sessionStamp` field on the payload — the reducer uses this
     * to group events by session boundary. We tag the payload
     * because it's what flows through to the webview reducer; the
     * outer ts is preserved for ordering.
     *
     * Best-effort: per-file read failures are logged and skipped;
     * we return whatever we could read. Empty array if no logs
     * exist or the directory is missing.
     */
    async readAllLogsForFeature(): Promise<RecordedEvent[]> {
        const featureDir = this.featureDir();
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(featureDir);
        } catch {
            return []; // Directory doesn't exist or unreadable.
        }

        // Filter to event log files only and extract their session
        // stamp from the filename (matches runRotation()'s extraction).
        const logs: { name: string; uri: vscode.Uri; stamp: string }[] = [];
        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File) { continue; }
            if (!name.startsWith('events-') || !name.endsWith('.jsonl')) { continue; }
            const stamp = name.slice('events-'.length, -'.jsonl'.length);
            logs.push({ name, uri: vscode.Uri.joinPath(featureDir, name), stamp });
        }

        // Read each log and concatenate. Each event gets its source
        // sessionStamp injected on the payload so the reducer can
        // group by session.
        const allEvents: RecordedEvent[] = [];
        for (const log_ of logs) {
            try {
                const data = await vscode.workspace.fs.readFile(log_.uri);
                const text = new TextDecoder().decode(data);
                for (const line of text.split('\n')) {
                    if (!line.trim()) { continue; }
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed && typeof parsed === 'object' && parsed.payload) {
                            // Inject sessionStamp on the payload so
                            // the downstream reducer can group.
                            const payload = parsed.payload as Record<string, unknown>;
                            payload['sessionStamp'] = log_.stamp;
                            // Also inject the parsed timestamp as a
                            // numeric epoch — the reducer uses it
                            // for ordering. The outer ts is ISO; we
                            // convert here once.
                            payload['timestamp'] = Date.parse(parsed.ts);
                            allEvents.push(parsed as RecordedEvent);
                        }
                    } catch {
                        // Corrupt line; skip silently. Already covered
                        // by readActiveLog's logging path.
                    }
                }
            } catch (e) {
                log.warn(`[readAllLogsForFeature] read failed for ${log_.name}:`, String(e));
            }
        }

        return allEvents;
    }

    /**
     * Forget the in-memory pointer to the current log file. Used by
     * Start Over after `startNewSession` has been called, to make
     * sure the next recordEvent goes to the new file (defense in
     * depth — startNewSession already updates activeLogUri).
     */
    invalidateCachedPointer(): void {
        this.activeLogUri = null;
    }

    // ─── Internals ──────────────────────────────────────────────────

    private featureDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceRoot, '.nexus', 'sessions', this.activeFeature);
    }

    /**
     * Resolve where the next event should be written. Steps:
     *   1. If we have a cached activeLogUri, return it.
     *   2. Read current.txt pointer for the feature. If present,
     *      construct the path and cache.
     *   3. If no pointer, write a new one with the constructor stamp
     *      (this is the natural "first session in this VS Code instance"
     *      path). Cache the result.
     */
    private async resolveActiveLogUri(): Promise<vscode.Uri | null> {
        if (this.activeLogUri) { return this.activeLogUri; }
        const featureDir = this.featureDir();
        const pointerUri = vscode.Uri.joinPath(featureDir, 'current.txt');
        try {
            const data = await vscode.workspace.fs.readFile(pointerUri);
            const stamp = new TextDecoder().decode(data).trim();
            if (stamp) {
                this.activeLogUri = vscode.Uri.joinPath(featureDir, `events-${stamp}.jsonl`);
                return this.activeLogUri;
            }
        } catch {
            // Pointer doesn't exist. Create one.
        }
        try {
            await vscode.workspace.fs.createDirectory(featureDir);
            await vscode.workspace.fs.writeFile(pointerUri, Buffer.from(this.sessionStamp, 'utf8'));
            this.activeLogUri = vscode.Uri.joinPath(featureDir, `events-${this.sessionStamp}.jsonl`);
            return this.activeLogUri;
        } catch (e) {
            log.warn('[resolveActiveLogUri] failed to create session dir:', String(e));
            return null;
        }
    }

    /**
     * Append a single line (already JSON-serialized + newline-terminated)
     * to the active log file. Uses read-modify-write because vscode's
     * FS API doesn't expose true append; in practice the workspace FS
     * abstraction routes through Node's fs which CAN append, but we
     * stay on the workspace API for symlink-safety + remote workspace
     * support. The serial writeChain keeps RMW races impossible.
     */
    private async appendLine(line: string): Promise<void> {
        const uri = await this.resolveActiveLogUri();
        if (!uri) { return; }
        let existing: Uint8Array;
        try {
            existing = await vscode.workspace.fs.readFile(uri);
        } catch {
            existing = new Uint8Array();
        }
        const newContent = new Uint8Array(existing.length + line.length);
        newContent.set(existing, 0);
        newContent.set(new TextEncoder().encode(line), existing.length);
        await vscode.workspace.fs.writeFile(uri, newContent);
    }
}