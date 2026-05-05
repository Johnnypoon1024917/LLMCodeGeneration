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
    /**
     * P1.2 deferred-infra: task IDs this task depends on, parsed from
     * the `dependsOn` attribute on the <task> tag. The PlannerAgent's
     * markup contract has carried this attribute since the spec was
     * written, but downstream code wasn't extracting it. Empty array
     * if `dependsOn="none"`, the attribute is absent, or it parses to
     * a non-list value.
     *
     * Format on the wire: comma-separated task IDs.
     *   <task id="TASK-003" dependsOn="TASK-001,TASK-002">
     *
     * The strings here are raw IDs; resolving them to ParsedTask
     * objects (and detecting unknown / cyclic references) lives in
     * `topologicalOrder()` below — separation of concerns: the parser
     * captures, the orderer validates.
     */
    dependencies: string[];
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

        let pendingTag: { id?: string; file?: string; dependencies: string[] } | null = null;

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
                dependencies: pendingTag?.dependencies ?? [],
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

    private static parseTaskTagAttrs(attrs: string): { id?: string; file?: string; dependencies: string[] } {
        const out: { id?: string; file?: string; dependencies: string[] } = { dependencies: [] };
        const idM = attrs.match(/\bid="([^"]+)"/i);
        if (idM && idM[1] !== undefined) {
            out.id = idM[1];
        }
        const fileM = attrs.match(/\btargetFile="([^"]+)"/i);
        if (fileM && fileM[1] !== undefined) {
            out.file = fileM[1];
        }
        // P1.2 deferred-infra: parse dependsOn. The conventional
        // value for "no dependencies" is the literal string "none";
        // missing attribute is also no-deps. Anything else is a
        // comma-separated list of task IDs.
        const depM = attrs.match(/\bdependsOn="([^"]+)"/i);
        if (depM && depM[1] !== undefined) {
            const raw = depM[1].trim();
            if (raw && raw.toLowerCase() !== 'none') {
                out.dependencies = raw
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
            }
        }
        return out;
    }
}

// ─── Topological ordering (cross-task dependency awareness) ────────────────
//
// The PlannerAgent emits tasks with optional `dependsOn` declarations.
// Until now those declarations were silently dropped at parse time —
// this section makes them queryable.
//
// What lives here:
//   - topologicalOrder(): sort tasks so all dependencies precede their
//     dependents. Surfaces cycles + dangling references as data, never
//     throws.
//   - findDependencyIssues(): pure validator; returns a structured
//     report without producing an order. Used by UI / linting paths
//     that want to flag bad plans without committing to an execution
//     order.
//
// What does NOT live here:
//   - Any LLM prompt tuning. The PlannerAgent prompt that asks the
//     model to emit `dependsOn` is the part that needs real fixture
//     iteration. This file is the data side of that contract; it
//     starts paying off the instant the planner emits anything other
//     than `dependsOn="none"`.
//   - Any execution-side use. Coordinator / TaskRunner integration
//     comes in a follow-up PR once the planner emits dependencies
//     reliably enough to trust.

export interface DependencyIssue {
    /** Task whose dependsOn list contains the problem. */
    taskId: string;
    /** What's wrong with the declaration. */
    kind: 'unknown_id' | 'cycle' | 'self_reference';
    /** For 'unknown_id': the ID that wasn't found.
     *  For 'cycle': the chain (e.g. ['TASK-001', 'TASK-002', 'TASK-001']).
     *  For 'self_reference': the offending self-id. */
    detail: string | string[];
}

export interface TopologicalResult {
    /** Tasks in execution-safe order, OR the input order if there
     *  were issues that prevented a valid sort. Always returns SOME
     *  order so callers can render the list even on a bad plan. */
    ordered: ParsedTask[];
    /** Validation findings. Empty array means a clean DAG. */
    issues: DependencyIssue[];
}

/**
 * Topologically sort tasks by their declared dependencies.
 *
 * Tasks without an `id` or with empty `dependencies` are treated as
 * roots. Tasks whose deps reference an unknown id are still included
 * in the output (in their original relative position) and the issue
 * is surfaced via `issues`. Cycles are detected and broken
 * deterministically — every cycle entry is reported as an issue and
 * the participating tasks are emitted in their original input order.
 *
 * Pure function. Does not throw. Does not mutate input.
 */
export function topologicalOrder(tasks: readonly ParsedTask[]): TopologicalResult {
    const issues: DependencyIssue[] = [];

    // Build id → task index. Tasks without ids can't be referenced by
    // other tasks — that's fine, they just won't appear in any
    // dependency graph.
    const idToTask = new Map<string, ParsedTask>();
    for (const t of tasks) {
        if (t.id) {
            idToTask.set(t.id, t);
        }
    }

    // Stage 1: find unknown / self references. These don't break the
    // sort — we just drop them from the dependency graph and report.
    const cleanedDeps = new Map<ParsedTask, string[]>();
    for (const t of tasks) {
        const deps: string[] = [];
        for (const depId of t.dependencies) {
            if (t.id && depId === t.id) {
                issues.push({ taskId: t.id, kind: 'self_reference', detail: depId });
                continue;
            }
            if (!idToTask.has(depId)) {
                issues.push({
                    taskId: t.id ?? `(unnamed: "${t.description}")`,
                    kind: 'unknown_id',
                    detail: depId,
                });
                continue;
            }
            deps.push(depId);
        }
        cleanedDeps.set(t, deps);
    }

    // Stage 2: Kahn's algorithm. Stable iteration order over `tasks`
    // means ties (multiple tasks with no remaining deps) are emitted
    // in input order — important so the UI sees a deterministic
    // result on every parse.
    const indegree = new Map<ParsedTask, number>();
    const dependents = new Map<ParsedTask, ParsedTask[]>();
    for (const t of tasks) {
        indegree.set(t, (cleanedDeps.get(t) ?? []).length);
        dependents.set(t, []);
    }
    for (const t of tasks) {
        for (const depId of cleanedDeps.get(t) ?? []) {
            const dep = idToTask.get(depId);
            if (dep) {
                dependents.get(dep)!.push(t);
            }
        }
    }

    const ordered: ParsedTask[] = [];
    const ready: ParsedTask[] = [];
    for (const t of tasks) {
        if ((indegree.get(t) ?? 0) === 0) { ready.push(t); }
    }

    while (ready.length > 0) {
        const next = ready.shift()!;
        ordered.push(next);
        for (const dep of dependents.get(next) ?? []) {
            const newDeg = (indegree.get(dep) ?? 0) - 1;
            indegree.set(dep, newDeg);
            if (newDeg === 0) { ready.push(dep); }
        }
    }

    // Stage 3: cycle detection. Anything not in `ordered` after
    // Kahn's is part of a cycle. Walk the residual subgraph to
    // recover one representative cycle per SCC.
    if (ordered.length < tasks.length) {
        const remaining = tasks.filter((t) => !ordered.includes(t));
        const reportedInCycle = new Set<ParsedTask>();
        for (const start of remaining) {
            if (reportedInCycle.has(start)) { continue; }
            const cycle = findCycleFrom(start, idToTask, cleanedDeps);
            if (cycle && cycle.length > 0) {
                for (const t of cycle) { reportedInCycle.add(t); }
                issues.push({
                    taskId: cycle[0]!.id ?? cycle[0]!.description,
                    kind: 'cycle',
                    detail: cycle.map((t) => t.id ?? t.description),
                });
            }
        }
        // Emit the cycle members in their original input order so the
        // caller sees a complete list. Ordering inside a cycle is
        // ambiguous by definition; input order is the least surprising.
        for (const t of remaining) { ordered.push(t); }
    }

    return { ordered, issues };
}

/**
 * Lighter-weight validator. Same checks as topologicalOrder but
 * returns issues without producing an order. Useful for UI lint
 * paths that don't need to commit to an execution sequence.
 */
export function findDependencyIssues(tasks: readonly ParsedTask[]): DependencyIssue[] {
    return topologicalOrder(tasks).issues;
}

/** Internal: DFS from `start` to find a cycle it participates in. */
function findCycleFrom(
    start: ParsedTask,
    idToTask: Map<string, ParsedTask>,
    cleanedDeps: Map<ParsedTask, string[]>
): ParsedTask[] | null {
    // DFS with a path stack. When we hit a node already on the stack,
    // slice from its first occurrence to the current end — that's the
    // cycle.
    const stack: ParsedTask[] = [];
    const inStack = new Set<ParsedTask>();
    const seen = new Set<ParsedTask>();

    function dfs(node: ParsedTask): ParsedTask[] | null {
        stack.push(node);
        inStack.add(node);
        seen.add(node);
        for (const depId of cleanedDeps.get(node) ?? []) {
            const dep = idToTask.get(depId);
            if (!dep) { continue; }
            if (inStack.has(dep)) {
                const i = stack.indexOf(dep);
                return stack.slice(i).concat([dep]);
            }
            if (!seen.has(dep)) {
                const found = dfs(dep);
                if (found) { return found; }
            }
        }
        stack.pop();
        inStack.delete(node);
        return null;
    }

    return dfs(start);
}