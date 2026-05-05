// webview-ui/src/autonomyQueue.ts
//
// Pure decision logic for autonomy-mode task queue advancement.
//
// The webview's message handler in App.tsx receives `taskCompleted`
// events and needs to decide:
//   - Should I dispatch the next task?
//   - Should I halt with an error?
//   - Should I ignore this event entirely (stale completion, plan-mode
//     click-through, etc.)?
//
// Rather than embed those decisions inline in the handler closure
// (where they're hard to test without spinning up React + the message
// bus), we extract them here as pure functions taking the queue
// snapshot and event facts, returning the next state to apply.

export type TaskFinalStatus = 'approved' | 'rejected' | 'error';

export interface AutonomyAdvanceInput {
    /** Queue at the moment the taskCompleted event arrived. Head is
     *  the currently-executing task. */
    prevQueue: string[];
    /** taskKey from the event. */
    completedTask: string;
    /** Status from the event. Only terminal states drive autonomy
     *  decisions; intermediate `reviewing`/`running` states should
     *  be filtered upstream. */
    status: TaskFinalStatus;
    /** True if user clicked Halt between dispatch and completion.
     *  When true, all advancement is suppressed regardless of status. */
    haltRequested: boolean;
}

export type AutonomyDecision =
    | { action: 'ignore' }                                    // not our event, or halted, or stale
    | { action: 'advance'; nextQueue: string[]; nextTaskKey: string }  // pop head, dispatch next
    | { action: 'finish'; nextQueue: [] }                     // last task approved, queue empty
    | { action: 'halt'; reason: 'rejected' | 'error'; failedTask: string }; // verifier rejected / error

/**
 * Decide what to do with the autonomy queue when a `taskCompleted`
 * event arrives. Pure — no React, no DOM, no time.
 *
 * Decision rules:
 *   1. Halt requested → ignore everything. The user explicitly
 *      asked to stop dispatching; the in-flight task may still
 *      have completed but its result doesn't drive next dispatch.
 *
 *   2. Empty queue or head doesn't match completed task → ignore.
 *      This catches three real cases:
 *        - Stray completions from manually-clicked plan-mode tasks
 *          while autonomy is also running. (Shouldn't happen but
 *          defensive — autonomy disables the dropdown so user can't
 *          mix modes mid-run, but a click-through could still race.)
 *        - Late completion from a task dispatched before halt.
 *        - Completion arriving for a task that wasn't in the queue
 *          at all (different session, etc).
 *
 *   3. Status is approved AND head matches → pop and continue.
 *      If pop empties the queue, return 'finish' so caller can
 *      surface "all done" UI.
 *
 *   4. Status is rejected/error AND head matches → halt with
 *      reason. Caller surfaces a banner; remaining tasks are
 *      discarded because they likely build on the failed work.
 *      Per the design decision (recorded in the V2.0 conversation),
 *      we don't auto-skip — broken task N produces broken task N+1.
 */
export function advanceAutonomyQueue(input: AutonomyAdvanceInput): AutonomyDecision {
    if (input.haltRequested) {
        return { action: 'ignore' };
    }
    if (input.prevQueue.length === 0 || input.prevQueue[0] !== input.completedTask) {
        return { action: 'ignore' };
    }
    if (input.status === 'approved') {
        const remaining = input.prevQueue.slice(1);
        if (remaining.length === 0) {
            return { action: 'finish', nextQueue: [] };
        }
        return { action: 'advance', nextQueue: remaining, nextTaskKey: remaining[0]! };
    }
    // status === 'rejected' or 'error'
    return {
        action: 'halt',
        reason: input.status === 'rejected' ? 'rejected' : 'error',
        failedTask: input.completedTask,
    };
}

/**
 * Build the initial autonomy queue from a task list, skipping tasks
 * that are already in 'approved' state. Used by startAutonomyRun
 * to support resume-from-mid-list semantics: a user might run tasks
 * 1-3 in plan mode, then switch to autonomy and click Run All —
 * we should pick up at task 4, not re-run tasks 1-3.
 *
 * Pure — takes the keys + status snapshot, returns the queue.
 *
 * Status values that re-enter the queue:
 *   - undefined  (never started)
 *   - 'rejected' (previous attempt failed)
 *   - 'error'    (previous attempt errored)
 *   - 'reviewing' (currently running — should never happen at start
 *                  but defensively re-runs rather than getting stuck)
 *
 * Status values that skip:
 *   - 'approved' (already verified ok — re-running would just redo work)
 */
export function buildInitialAutonomyQueue(
    allTaskKeys: readonly string[],
    statusByKey: Readonly<Record<string, string | undefined>>
): string[] {
    return allTaskKeys.filter(key => statusByKey[key] !== 'approved');
}