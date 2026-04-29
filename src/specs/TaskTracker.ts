// src/specs/TaskTracker.ts
//
// Single source of truth for task-completion status. Wraps SpecManager and
// owns the parsing & writing of `[ ] / [x] / [!]` markers in tasks.md.
//
// Why this exists:
//   Before this module, task status lived in three places:
//     1. tasks.md         (canonical, via the markdown checkboxes)
//     2. tasks.json       (mirror, via plan.implementationTasks[i].status)
//     3. workspaceState   (UI-synced, key 'nexus_task_statuses')
//
//   The triple source of truth caused a real bug: a task verified manually
//   would update workspaceState but not tasks.md, so closing & reopening
//   VS Code "lost" the completion. Now tasks.md is the canonical reference,
//   the webview rebuilds its taskStatuses map from disk on every load,
//   and the workspaceState 'nexus_task_statuses' key is no longer written.
//
// Format expected (matches what SidebarProvider's generateProjectTasks emits):
//
//     <task id="TASK-001" dependsOn="none" targetFile="src/foo.ts" relatesTo="REQ-001">
//     1. [ ] **Define User Model** (File: `src/foo.ts`)
//        - *Instructions:* <instructions>Build a Pydantic schema...</instructions>
//     </task>
//
// The CANONICAL KEY for a task is its description string (the "Define User
// Model" part), because that's the same key used as `taskKey` throughout
// the webview UI. The `id="TASK-001"` is metadata, not a key.

import { SpecManager } from './SpecManager';

/**
 * The three statuses durably persisted to tasks.md.
 *
 * Note that the UI surfaces additional transient states like 'reviewing',
 * 'error', and 'undone' — those live in React state only and are NOT
 * written to disk. They settle into one of these three at task end.
 */
export type TaskStatus = 'pending' | 'completed' | 'rejected';

export interface ParsedTask {
    /** Task description — the canonical key used everywhere. */
    description: string;
    /** Optional explicit task ID (e.g. "TASK-001") if declared in the markdown. */
    id?: string;
    /** Target file the task modifies, if known. */
    file?: string;
    /** Status derived from the checkbox marker. */
    status: TaskStatus;
}

const STATUS_TO_MARKER: Record<TaskStatus, string> = {
    pending: ' ',
    completed: 'x',
    rejected: '!',
};

const MARKER_TO_STATUS: Record<string, TaskStatus> = {
    ' ': 'pending',
    'x': 'completed',
    'X': 'completed',
    '!': 'rejected',
};

export class TaskTracker {
    constructor(
        private readonly specs: SpecManager,
        private readonly featureSlug?: string
    ) {}

    /**
     * Reads tasks.md and returns every task with its disk-truth status.
     * Returns an empty array if the file doesn't exist or contains no tasks.
     */
    async list(): Promise<ParsedTask[]> {
        const md = await this.specs.readTasksMd(this.featureSlug);
        if (!md) {
            return [];
        }
        return TaskTracker.parse(md);
    }

    /**
     * Returns a `{description: status}` map suitable for hydrating the
     * webview's `taskStatuses` state. Maps disk status to the UI vocabulary
     * the webview already uses ('approved' / 'rejected' / 'pending').
     */
    async statusMap(): Promise<Record<string, string>> {
        const tasks = await this.list();
        const map: Record<string, string> = {};
        for (const t of tasks) {
            map[t.description] = TaskTracker.toUiStatus(t.status);
        }
        return map;
    }

    /**
     * Updates the status for the task whose description matches `description`.
     * Returns `true` if the file was changed, `false` if no matching row was
     * found (in which case nothing is written and the call is a safe no-op).
     */
    async setStatus(description: string, next: TaskStatus): Promise<boolean> {
        const md = await this.specs.readTasksMd(this.featureSlug);
        if (!md) {
            return false;
        }
        const updated = TaskTracker.applyStatus(md, description, next);
        if (updated === md) {
            return false;
        }
        await this.specs.writeTasksMd(updated, this.featureSlug);
        return true;
    }

    // ─── Pure helpers (exported for testability) ────────────────────────

    /**
     * Parses tasks.md into a list of `ParsedTask`s. Tolerates both the
     * XML-wrapped form emitted by `generateProjectTasks` and bare-checkbox
     * lists in case a user hand-edits the file.
     */
    static parse(md: string): ParsedTask[] {
        const tasks: ParsedTask[] = [];
        const lines = md.split('\n');

        // <task id="TASK-001" targetFile="..." ...>  — attributes for the next checkbox
        const tagRe = /<task\s+([^>]*)>/i;

        // A checkbox line. Examples that match:
        //   1. [ ] **Define User Model** (File: `src/foo.ts`)
        //   - [x] Add validation logic
        //   * [!] Failed task
        //   [ ] Plain task no leading marker
        const checkRe = /^\s*(?:\d+\.\s+|[-*]\s+)?\[([ xX!])\]\s*(?:\*\*([^*]+?)\*\*|([^(\n]+?))(?:\s*\(File:\s*`([^`]+)`\))?\s*$/;

        let pendingTag: { id?: string; file?: string } | null = null;

        for (const line of lines) {
            const tagMatch = line.match(tagRe);
            if (tagMatch) {
                if (tagMatch[1] !== undefined) {
                    pendingTag = TaskTracker.parseTaskTagAttrs(tagMatch[1]);
                }
                continue;
            }

            const checkMatch = line.match(checkRe);
            if (!checkMatch) {
                continue;
            }

            const marker = checkMatch[1];
            if (marker === undefined) {
                continue; // the regex's group 1 is required; defensive guard for the type system
            }
            const description = (checkMatch[2] ?? checkMatch[3] ?? '').trim();
            if (!description) {
                continue;
            }

            const taskRecord: ParsedTask = {
                description,
                status: MARKER_TO_STATUS[marker] ?? 'pending',
            };
            if (pendingTag?.id !== undefined) {
                taskRecord.id = pendingTag.id;
            }
            const fileVal = checkMatch[4] ?? pendingTag?.file;
            if (fileVal !== undefined) {
                taskRecord.file = fileVal;
            }
            tasks.push(taskRecord);

            // Each <task>…</task> block has exactly one checkbox; clear after consuming.
            pendingTag = null;
        }

        return tasks;
    }

    /**
     * Returns `md` with the checkbox marker for `description` updated to
     * the marker corresponding to `next`. No-op (returns the input verbatim)
     * when the description isn't found.
     *
     * Tries the bold form (`**desc**`) first, since that's what
     * `generateProjectTasks` emits for object-typed tasks. Falls back to a
     * plain-text match for string-typed tasks.
     */
    static applyStatus(md: string, description: string, next: TaskStatus): string {
        const marker = STATUS_TO_MARKER[next];
        const escDesc = description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Bold form: `[?] **Description**`  (any current marker)
        const boldRe = new RegExp(`\\[[ xX!]\\](\\s*\\*\\*${escDesc}\\*\\*)`);
        if (boldRe.test(md)) {
            return md.replace(boldRe, `[${marker}]$1`);
        }

        // Plain form: `[?] Description`  followed by space, paren, or end-of-line
        const plainRe = new RegExp(`\\[[ xX!]\\](\\s+${escDesc})(?=\\s|\\(|$)`, 'm');
        if (plainRe.test(md)) {
            return md.replace(plainRe, `[${marker}]$1`);
        }

        return md;
    }

    /** Maps the persistent `TaskStatus` to the broader UI vocabulary. */
    static toUiStatus(status: TaskStatus): string {
        switch (status) {
            case 'completed': return 'approved';
            case 'rejected':  return 'rejected';
            case 'pending':
            default:          return 'pending';
        }
    }

    /** Inverse of `toUiStatus` — maps a UI status back to a persistable one. */
    static fromUiStatus(uiStatus: string): TaskStatus {
        switch (uiStatus) {
            case 'approved':
            case 'completed':
                return 'completed';
            case 'rejected':
            case 'error':
                return 'rejected';
            // 'reviewing', 'undone', 'pending', or anything else → pending
            default:
                return 'pending';
        }
    }

    private static parseTaskTagAttrs(attrs: string): { id?: string; file?: string } {
        const out: { id?: string; file?: string } = {};
        const idM = attrs.match(/\bid="([^"]+)"/i);
        if (idM && idM[1] !== undefined) {
            out.id = idM[1];
        }
        const fileM = attrs.match(/\btargetFile="([^"]+)"/i);
        if (fileM && fileM[1] !== undefined) {
            out.file = fileM[1];
        }
        return out;
    }
}