"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskTracker = void 0;
exports.topologicalOrder = topologicalOrder;
exports.findDependencyIssues = findDependencyIssues;
const STATUS_TO_MARKER = {
    pending: ' ',
    completed: 'x',
    rejected: '!',
};
const MARKER_TO_STATUS = {
    ' ': 'pending',
    'x': 'completed',
    'X': 'completed',
    '!': 'rejected',
};
class TaskTracker {
    specs;
    featureSlug;
    constructor(specs, featureSlug) {
        this.specs = specs;
        this.featureSlug = featureSlug;
    }
    /**
     * Reads tasks.md and returns every task with its disk-truth status.
     * Returns an empty array if the file doesn't exist or contains no tasks.
     */
    async list() {
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
    async statusMap() {
        const tasks = await this.list();
        const map = {};
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
    async setStatus(description, next) {
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
    static parse(md) {
        const tasks = [];
        const lines = md.split('\n');
        // <task id="TASK-001" targetFile="..." ...>  — attributes for the next checkbox
        const tagRe = /<task\s+([^>]*)>/i;
        // A checkbox line. Examples that match:
        //   1. [ ] **Define User Model** (File: `src/foo.ts`)
        //   - [x] Add validation logic
        //   * [!] Failed task
        //   [ ] Plain task no leading marker
        const checkRe = /^\s*(?:\d+\.\s+|[-*]\s+)?\[([ xX!])\]\s*(?:\*\*([^*]+?)\*\*|([^(\n]+?))(?:\s*\(File:\s*`([^`]+)`\))?\s*$/;
        let pendingTag = null;
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
            const taskRecord = {
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
    static applyStatus(md, description, next) {
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
    static toUiStatus(status) {
        switch (status) {
            case 'completed': return 'approved';
            case 'rejected': return 'rejected';
            case 'pending':
            default: return 'pending';
        }
    }
    /** Inverse of `toUiStatus` — maps a UI status back to a persistable one. */
    static fromUiStatus(uiStatus) {
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
    static parseTaskTagAttrs(attrs) {
        const out = { dependencies: [] };
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
exports.TaskTracker = TaskTracker;
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
function topologicalOrder(tasks) {
    const issues = [];
    // Build id → task index. Tasks without ids can't be referenced by
    // other tasks — that's fine, they just won't appear in any
    // dependency graph.
    const idToTask = new Map();
    for (const t of tasks) {
        if (t.id) {
            idToTask.set(t.id, t);
        }
    }
    // Stage 1: find unknown / self references. These don't break the
    // sort — we just drop them from the dependency graph and report.
    const cleanedDeps = new Map();
    for (const t of tasks) {
        const deps = [];
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
    const indegree = new Map();
    const dependents = new Map();
    for (const t of tasks) {
        indegree.set(t, (cleanedDeps.get(t) ?? []).length);
        dependents.set(t, []);
    }
    for (const t of tasks) {
        for (const depId of cleanedDeps.get(t) ?? []) {
            const dep = idToTask.get(depId);
            if (dep) {
                dependents.get(dep).push(t);
            }
        }
    }
    const ordered = [];
    const ready = [];
    for (const t of tasks) {
        if ((indegree.get(t) ?? 0) === 0) {
            ready.push(t);
        }
    }
    while (ready.length > 0) {
        const next = ready.shift();
        ordered.push(next);
        for (const dep of dependents.get(next) ?? []) {
            const newDeg = (indegree.get(dep) ?? 0) - 1;
            indegree.set(dep, newDeg);
            if (newDeg === 0) {
                ready.push(dep);
            }
        }
    }
    // Stage 3: cycle detection. Anything not in `ordered` after
    // Kahn's is part of a cycle. Walk the residual subgraph to
    // recover one representative cycle per SCC.
    if (ordered.length < tasks.length) {
        const remaining = tasks.filter((t) => !ordered.includes(t));
        const reportedInCycle = new Set();
        for (const start of remaining) {
            if (reportedInCycle.has(start)) {
                continue;
            }
            const cycle = findCycleFrom(start, idToTask, cleanedDeps);
            if (cycle && cycle.length > 0) {
                for (const t of cycle) {
                    reportedInCycle.add(t);
                }
                issues.push({
                    taskId: cycle[0].id ?? cycle[0].description,
                    kind: 'cycle',
                    detail: cycle.map((t) => t.id ?? t.description),
                });
            }
        }
        // Emit the cycle members in their original input order so the
        // caller sees a complete list. Ordering inside a cycle is
        // ambiguous by definition; input order is the least surprising.
        for (const t of remaining) {
            ordered.push(t);
        }
    }
    return { ordered, issues };
}
/**
 * Lighter-weight validator. Same checks as topologicalOrder but
 * returns issues without producing an order. Useful for UI lint
 * paths that don't need to commit to an execution sequence.
 */
function findDependencyIssues(tasks) {
    return topologicalOrder(tasks).issues;
}
/** Internal: DFS from `start` to find a cycle it participates in. */
function findCycleFrom(start, idToTask, cleanedDeps) {
    // DFS with a path stack. When we hit a node already on the stack,
    // slice from its first occurrence to the current end — that's the
    // cycle.
    const stack = [];
    const inStack = new Set();
    const seen = new Set();
    function dfs(node) {
        stack.push(node);
        inStack.add(node);
        seen.add(node);
        for (const depId of cleanedDeps.get(node) ?? []) {
            const dep = idToTask.get(depId);
            if (!dep) {
                continue;
            }
            if (inStack.has(dep)) {
                const i = stack.indexOf(dep);
                return stack.slice(i).concat([dep]);
            }
            if (!seen.has(dep)) {
                const found = dfs(dep);
                if (found) {
                    return found;
                }
            }
        }
        stack.pop();
        inStack.delete(node);
        return null;
    }
    return dfs(start);
}
//# sourceMappingURL=TaskTracker.js.map