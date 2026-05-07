// src/agents/crossTaskMonitor.ts
//
// V2.2 cross-task remediation.
//
// After each task completes successfully, we check whether the project
// still compiles. If new tsc errors appeared that weren't there before
// the task ran, we attribute those errors to the task and synthesize
// a remediation task descriptor that the autonomy queue can dispatch.
//
// Scope is intentionally narrow:
//   - tsc only (the common case for TS/JS projects; the regulated-
//     industry positioning is overwhelmingly TypeScript)
//   - Single-session memory (no persistence across reloads)
//   - Heuristic file attribution (errors point to the file that's now
//     broken; the most-recent task that wrote to that file gets blamed)
//
// What this is NOT:
//   - A test runner. Cross-task test regression is a separate feature.
//   - A semantic verifier. tsc passing doesn't mean the code is right;
//     it means the code typechecks.
//   - Persistent. If the user reloads VS Code mid-session the ledger
//     is lost. That's acceptable — they'd rerun anyway.

import * as path from 'path';
import * as fs from 'fs';
import { IEnvironment } from '../interfaces/IEnvironment';

/**
 * One entry in the session ledger. Created when a task completes
 * successfully and writes one or more files.
 */
export interface CompletedTask {
    /** UI-side key (e.g. "task-3"). Used to thread regression-source
     *  attribution back to the originating task in audit logs. */
    taskKey: string;

    /** Human-readable title from the task object. Surfaced in the
     *  remediation prompt so the LLM knows which earlier task
     *  introduced the breakage. */
    taskTitle: string;

    /** Workspace-relative file paths the task wrote. Used to attribute
     *  new compile errors to the most-recent task that touched the
     *  failing file. Empty when the task was a no-op (rare; we still
     *  log it for ledger completeness). */
    filesTouched: string[];

    /** Time of completion. Used only for tie-breaking when multiple
     *  tasks touched the same file in this session. */
    completedAt: number;
}

/**
 * Errors detected by tsc, parsed into something we can compare set-
 * wise. Keyed file:line:code so we can compute "what's new since the
 * baseline" in O(N).
 */
interface TscError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
}

/**
 * Output of analyzeAfterTask: callers decide what to do with this.
 * The Coordinator/SidebarProvider may dispatch the remediation task,
 * surface it to the user, or queue it for review.
 */
export interface CrossTaskAnalysis {
    /** True if no new errors compared to the baseline. */
    healthy: boolean;

    /** New errors that appeared since the previous task. Empty when
     *  healthy is true. */
    newErrors: TscError[];

    /** When newErrors is non-empty: a remediation task descriptor
     *  ready to be dispatched. Null when healthy or when we couldn't
     *  attribute the errors to a specific file the agent recently
     *  touched (in which case a generic "fix the new errors" prompt
     *  is the best we can do — and we DON'T auto-dispatch that
     *  because the LLM would be flying blind). */
    remediationTask: RemediationTaskDescriptor | null;
}

/**
 * A remediation task. Same shape as a regular task in the autonomy
 * queue but flagged so the UI can render it distinctly ("Auto-
 * remediation"). The kind stays 'code' — it's a normal CoderAgent
 * dispatch, just with synthesized context.
 */
export interface RemediationTaskDescriptor {
    taskKey: string;
    taskTitle: string;
    /** The full prompt to feed to executeTask. Includes:
     *   - Which file is broken
     *   - The new tsc errors verbatim (file:line:code: message)
     *   - Which earlier task introduced them (for context, not blame)
     *   - An instruction to fix only the regression, not refactor */
    prompt: string;
    /** The most-recent task that wrote to the broken file. Used by
     *  the UI to draw an arrow from the source task to the
     *  remediation task. */
    sourceTaskKey: string;
    /** The file the errors point at. */
    targetFile: string;
}

/**
 * Per-session monitor. The SidebarProvider holds one instance for
 * the duration of a chat session; reset when a new session starts.
 */
export class CrossTaskMonitor {
    private readonly workspaceRoot: string;
    private readonly env: IEnvironment;
    private readonly ledger: CompletedTask[] = [];
    private baselineErrorKeys: Set<string> = new Set();
    private baselineCaptured: boolean = false;

    constructor(workspaceRoot: string, env: IEnvironment) {
        this.workspaceRoot = workspaceRoot;
        this.env = env;
    }

    /**
     * Determine if cross-task analysis applies to this workspace.
     * Pure JS / Python / Go projects skip it. We require at least a
     * tsconfig.json — without it tsc will fail for unrelated reasons.
     */
    isApplicable(): boolean {
        try {
            const tsconfig = path.join(this.workspaceRoot, 'tsconfig.json');
            return fs.existsSync(tsconfig);
        } catch {
            return false;
        }
    }

    /**
     * Capture the project's tsc error baseline. Called once at session
     * start (or lazily on first analyzeAfterTask call). Errors present
     * BEFORE the agent did anything are considered ambient and won't
     * trigger remediation.
     *
     * If capture fails (tsc not installed, tsconfig malformed, etc.)
     * we silently disable cross-task analysis for the session — better
     * to be no-op than to false-positive on every task.
     */
    async captureBaseline(): Promise<void> {
        if (this.baselineCaptured) { return; }
        try {
            const errors = await this.runTsc();
            this.baselineErrorKeys = new Set(errors.map(keyOf));
        } catch {
            // Disable for the session by leaving baselineErrorKeys empty
            // and marking captured. Subsequent analyses will treat
            // everything as new — but we also short-circuit in
            // analyzeAfterTask when isApplicable returns false on
            // re-check, so the practical effect is no-op.
            this.baselineErrorKeys = new Set();
        }
        this.baselineCaptured = true;
    }

    /**
     * Record that a task completed and check for new errors.
     * Returns analysis: healthy when no new errors, otherwise a
     * remediation task descriptor.
     */
    async analyzeAfterTask(task: CompletedTask): Promise<CrossTaskAnalysis> {
        // Lazy baseline: capture before any task analysis. This way,
        // sessions that never see a successful task don't pay the
        // cost of running tsc.
        if (!this.baselineCaptured) { await this.captureBaseline(); }

        // Append to ledger first, so attribution can find the just-
        // completed task as a candidate source for breakage.
        this.ledger.push(task);

        const currentErrors = await this.runTscSafely();
        const newErrors = currentErrors.filter(e => !this.baselineErrorKeys.has(keyOf(e)));
        if (newErrors.length === 0) {
            // Healthy. Update baseline so we don't re-flag these errors
            // if a NEXT task happens to introduce different ones.
            // Note: only updates on healthy result — if there are new
            // errors, we keep the old baseline so the user/agent can
            // attempt remediation against the original target.
            this.baselineErrorKeys = new Set(currentErrors.map(keyOf));
            return { healthy: true, newErrors: [], remediationTask: null };
        }

        // Errors appeared. Try to attribute by finding the file with
        // the most new errors and looking up which task wrote it.
        const errorsByFile = new Map<string, TscError[]>();
        for (const err of newErrors) {
            const existing = errorsByFile.get(err.file);
            if (existing) {
                existing.push(err);
            } else {
                errorsByFile.set(err.file, [err]);
            }
        }
        const [topFile, topFileErrors] = mostNumerousEntry(errorsByFile);
        const sourceTask = this.findMostRecentTaskTouching(topFile);

        if (!sourceTask) {
            // No agent task wrote to this file in this session. Could
            // be a transitive break — file A imports file B, B was
            // edited, A now fails to compile. We surface the analysis
            // but don't synthesize a remediation task — the LLM can
            // do better with the user's hand on the wheel here.
            return { healthy: false, newErrors, remediationTask: null };
        }

        const remediationTask: RemediationTaskDescriptor = {
            taskKey: `remediation-${Date.now()}`,
            taskTitle: `Auto-remediate: fix tsc errors in ${path.basename(topFile)}`,
            sourceTaskKey: sourceTask.taskKey,
            targetFile: topFile,
            prompt: this.buildRemediationPrompt(topFile, topFileErrors, sourceTask),
        };

        return { healthy: false, newErrors, remediationTask };
    }

    /**
     * Snapshot of the ledger for diagnostics / UI display. Read-only.
     */
    getLedger(): readonly CompletedTask[] { return this.ledger; }

    /**
     * Clear all session state. Called when the user starts a new
     * chat session.
     */
    reset(): void {
        this.ledger.length = 0;
        this.baselineErrorKeys = new Set();
        this.baselineCaptured = false;
    }

    /** Run tsc, swallowing all errors. Used in analyzeAfterTask where
     *  a tsc failure (e.g. tsc binary missing) shouldn't crash the
     *  task pipeline — we just degrade to "can't analyze." */
    private async runTscSafely(): Promise<TscError[]> {
        try {
            return await this.runTsc();
        } catch {
            return [];
        }
    }

    /** V2.2 hotfix-cleanup-and-rest (#5): multi-language compile check.
     *  Replaces the previous TS-only runTsc.
     *
     *  Strategy:
     *    1. Detect languages present in the workspace
     *    2. For each detected language, run its compiler check
     *    3. Aggregate errors into the unified TscError[] shape
     *
     *  Languages handled:
     *    - TypeScript: `tsc --noEmit` (when tsconfig.json present)
     *    - Python:     `python -m py_compile` (when pyproject.toml or
     *                  *.py files present) — bundled with every Python
     *                  install, no extra deps needed
     *    - Go:         `go build ./...` (when go.mod present)
     *
     *  Languages explicitly NOT handled (yet):
     *    - Rust: cargo check on cold cache can take minutes — bad
     *      cross-task overhead. Add when we have warm-cache support.
     *    - Java: build systems vary too much (Gradle/Maven/Bazel/Ant).
     *      Per-customer config likely needed.
     *    - C/C++: same as Java — too many build systems.
     *
     *  Each language runs independently. If a binary is missing
     *  (e.g., go installed but python isn't), we skip that language
     *  gracefully and only run what we can. Caller sees aggregated
     *  errors from the languages we did check.
     */
    private async runTsc(): Promise<TscError[]> {
        const detected = await this.detectLanguages();
        const allErrors: TscError[] = [];

        if (detected.typescript) {
            try {
                const result = await this.env.runCommand(
                    'npx -p typescript tsc --noEmit',
                    this.workspaceRoot
                );
                const out = result.stdout + '\n' + result.stderr;
                allErrors.push(...parseTscErrors(out));
            } catch {
                // tsc not runnable (npx failed, network blocked).
                // Skip silently; better than throwing the whole check.
            }
        }

        if (detected.python) {
            try {
                // py_compile compiles all .py files under cwd. We
                // use compileall with -q (quiet, only errors) to
                // exercise the whole tree. Errors stream to stderr
                // in a parseable format.
                const result = await this.env.runCommand(
                    'python -m compileall -q .',
                    this.workspaceRoot
                );
                allErrors.push(...parsePythonCompileErrors(result.stdout + '\n' + result.stderr));
            } catch {
                // python not installed or compileall failed. Skip.
            }
        }

        if (detected.go) {
            try {
                // go build ./... compiles all packages. -o /dev/null
                // (or NUL on Windows) discards binaries — we only
                // care about the typecheck/build errors.
                const result = await this.env.runCommand(
                    'go build ./...',
                    this.workspaceRoot
                );
                allErrors.push(...parseGoBuildErrors(result.stdout + '\n' + result.stderr));
            } catch {
                // go not installed. Skip.
            }
        }

        return allErrors;
    }

    /** Detect which languages this workspace uses. Used to scope
     *  cross-task compile checks. Cheap — just stat() a few sentinel
     *  files. Cached implicitly by the OS file cache. */
    private async detectLanguages(): Promise<{ typescript: boolean; python: boolean; go: boolean }> {
        const exists = (rel: string): boolean => {
            try {
                fs.statSync(path.join(this.workspaceRoot, rel));
                return true;
            } catch {
                return false;
            }
        };
        // Fast path: quick stats on canonical manifest files.
        const result = {
            typescript: exists('tsconfig.json'),
            python: exists('pyproject.toml') || exists('setup.py') || exists('requirements.txt'),
            go: exists('go.mod'),
        };
        return result;
    }

    /** Find the most-recent task in the ledger that wrote to the
     *  given file. Returns null if none did. */
    private findMostRecentTaskTouching(file: string): CompletedTask | null {
        // Walk ledger in reverse so the most-recent matching task wins.
        for (let i = this.ledger.length - 1; i >= 0; i--) {
            const t = this.ledger[i]!;
            if (t.filesTouched.some(f => filesEquivalent(f, file))) {
                return t;
            }
        }
        return null;
    }

    /** Build the remediation prompt. Format is deliberate:
     *   - Lead with the WHAT (which file, which errors)
     *   - Then the WHO (which task introduced them)
     *   - End with the SCOPE INSTRUCTION (don't refactor; just fix)
     *  This ordering matches how an experienced engineer reads a
     *  bug report: symptom first, history second, fix-direction last. */
    private buildRemediationPrompt(
        targetFile: string,
        errors: TscError[],
        sourceTask: CompletedTask
    ): string {
        const errorList = errors
            .map(e => `  ${path.basename(e.file)}:${e.line}:${e.column}: ${e.code} ${e.message}`)
            .join('\n');
        return [
            `Auto-Remediation Task — fix new tsc errors in ${targetFile}`,
            ``,
            `These errors appeared after the task "${sourceTask.taskTitle}" completed:`,
            errorList,
            ``,
            `The source task wrote files: ${sourceTask.filesTouched.join(', ')}.`,
            `Your scope: fix ONLY the type errors above. Do not refactor unrelated code.`,
            `Do not change the behavior of the source task — adjust types, imports, or signatures as needed to make tsc happy.`,
            `If a fix would require changing the source task's behavior, STOP and surface the issue rather than silently breaking it.`,
        ].join('\n');
    }
}

/** Stable key for an error so we can compare baseline vs current. */
function keyOf(e: TscError): string {
    return `${e.file}:${e.line}:${e.code}`;
}

/** Find the entry with the most items. Returns [key, items]; assumes
 *  caller has checked the map is non-empty. */
function mostNumerousEntry<V>(m: Map<string, V[]>): [string, V[]] {
    let topKey = '';
    let topVal: V[] = [];
    for (const [k, v] of m) {
        if (v.length > topVal.length) { topKey = k; topVal = v; }
    }
    return [topKey, topVal];
}

/** Compare two file paths tolerantly: workspace-relative vs absolute,
 *  forward vs back slashes (Windows). */
function filesEquivalent(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '');
    return norm(a) === norm(b) || norm(a).endsWith(norm(b)) || norm(b).endsWith(norm(a));
}

/**
 * Parse tsc --noEmit output. Each error line looks like:
 *
 *   path/to/file.ts(15,9): error TS2322: Type 'string' is not assignable to type 'number'.
 *
 * Multi-line errors (rare for tsc) collapse to one entry — we keep the
 * first line as the message. False negatives are acceptable; the goal
 * is "do new errors exist" not "perfect error reproduction."
 *
 * Exported for unit testing; the parser has enough edge cases that
 * direct testing is worth the export.
 */
export function parseTscErrors(output: string): TscError[] {
    const errors: TscError[] = [];
    const lineRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;
    const lines = output.split('\n');
    for (const line of lines) {
        const m = line.match(lineRe);
        if (m && m[1] && m[2] && m[3] && m[4]) {
            errors.push({
                file: m[1],
                line: parseInt(m[2], 10),
                column: parseInt(m[3], 10),
                code: m[4],
                message: (m[5] || '').trim(),
            });
        }
    }
    return errors;
}

/**
 * V2.2 hotfix-cleanup-and-rest (#5): parse python -m compileall output.
 *
 * compileall errors come in multi-line blocks like:
 *
 *   *** Error compiling './foo.py'...
 *     File "./foo.py", line 5
 *       syntax error here
 *           ^
 *   SyntaxError: invalid syntax
 *
 * We scan for the "*** Error compiling" header to find each error
 * block, then look ahead a few lines for the line number and the
 * exception class. compileall doesn't expose error codes (Python
 * doesn't have stable codes the way TS does), so we synthesize
 * 'PY_SYNTAX' as a stable identifier.
 *
 * Tolerates malformed output (e.g., truncated blocks) — anything
 * we can't parse we skip.
 */
export function parsePythonCompileErrors(output: string): TscError[] {
    const errors: TscError[] = [];
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const headerRe = /^\*\*\* Error compiling ['"](.+?)['"]/;
        const m = lines[i]!.match(headerRe);
        if (!m || !m[1]) { continue; }
        const file = m[1];
        // Look ahead up to 6 lines for "File ..., line N" and an
        // exception class. 6 is enough for the typical block; if
        // the error format changes we'll just produce less detail.
        let lineNum = 0;
        let column = 0;
        let message = 'Compile error';
        for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
            const l = lines[j]!;
            const lineRe = /\bline (\d+)\b/;
            const lm = l.match(lineRe);
            if (lm && lm[1]) { lineNum = parseInt(lm[1], 10); }
            // Exception class line: "SyntaxError: ..." or
            // "IndentationError: ...". Capture it as the message.
            const excRe = /^([A-Z][a-zA-Z]*Error):\s*(.*)$/;
            const em = l.match(excRe);
            if (em && em[1] && em[2]) {
                message = `${em[1]}: ${em[2].trim()}`;
                break;
            }
        }
        errors.push({
            file,
            line: lineNum || 0,
            column,
            code: 'PY_SYNTAX',
            message,
        });
    }
    return errors;
}

/**
 * V2.2 hotfix-cleanup-and-rest (#5): parse `go build ./...` output.
 *
 * Go errors are already in a tsc-like format:
 *   ./foo.go:15:9: undefined: BarType
 *   ./foo.go:15:9: cannot use bar (type int) as type string
 *
 * We don't have stable error codes in Go output — synthesize 'GO_BUILD'
 * as a stable identifier so the de-dupe key in keyOf() works.
 *
 * Multi-line errors (some go vet diagnostics span multiple lines) get
 * truncated to the first line. Acceptable trade-off — second line is
 * usually just the failing source code, which we don't need.
 */
export function parseGoBuildErrors(output: string): TscError[] {
    const errors: TscError[] = [];
    // Format: file:line:col: message    OR    file:line: message (no column)
    const withColRe = /^(\S+\.go):(\d+):(\d+):\s+(.+)$/;
    const noColRe = /^(\S+\.go):(\d+):\s+(.+)$/;
    for (const line of output.split('\n')) {
        let m = line.match(withColRe);
        if (m && m[1] && m[2] && m[3] && m[4]) {
            errors.push({
                file: m[1],
                line: parseInt(m[2], 10),
                column: parseInt(m[3], 10),
                code: 'GO_BUILD',
                message: m[4].trim(),
            });
            continue;
        }
        m = line.match(noColRe);
        if (m && m[1] && m[2] && m[3]) {
            errors.push({
                file: m[1],
                line: parseInt(m[2], 10),
                column: 0,
                code: 'GO_BUILD',
                message: m[3].trim(),
            });
        }
    }
    return errors;
}