// src/scaffold/scaffoldApplier.ts
//
// V2.1.2a — apply a discovered template into a workspace.
//
// Two phases, intentionally separated:
//
//   1. planConflicts(template, workspaceRoot)
//      Read-only. Walks the template's `files/` tree and reports
//      which destinations already exist with non-trivially-different
//      content. Caller (the confirmation dialog flow) uses this to
//      decide whether to proceed, refuse, or warn the user.
//
//   2. applyTemplate(template, workspaceRoot, options)
//      Writes files. Refuses if the conflict-plan from step 1 has
//      any "blocking" conflicts. The split keeps the dangerous path
//      (filesystem writes) gated behind an explicit conflict check.
//
// Both functions take an `extensionFs` adapter for testability — the
// tests inject an in-memory FS so we don't need real disk for unit
// tests. Production callers pass a thin wrapper around node `fs`.
//
// Conflict policy:
//   - Destination doesn't exist → SAFE (will be created)
//   - Destination exists, byte-identical to template → IDENTICAL (skip silently)
//   - Destination exists, empty (0 bytes) → SAFE (will be overwritten)
//   - Destination exists, different content → BLOCKING (apply refuses)
//
// The "empty destination is safe" rule covers the common case where
// the user has an empty placeholder file (e.g. `git init` created
// .gitignore as empty). Refusing on those would frustrate users for
// no real safety benefit.

import * as path from 'path';
import { log } from '../logger';
import type { TemplateMetadata } from './templateLoader';

/**
 * Filesystem operations the applier needs. Decoupled from `fs` so
 * tests can inject in-memory implementations. Production code uses
 * `nodeFsAdapter` (defined below) which is a thin wrapper over `fs`.
 *
 * All paths are absolute. The adapter doesn't validate — caller is
 * responsible for keeping paths inside the workspace root (we add
 * a defense-in-depth check in `applyTemplate` regardless).
 */
export interface ScaffoldFs {
    /** Read file contents as utf-8 string. Returns null if file
     *  doesn't exist. Other errors (permission, etc.) throw. */
    readFile(absPath: string): string | null;
    /** Write utf-8 string content, creating parent dirs as needed.
     *  Throws on any write error — caller treats as fatal. */
    writeFile(absPath: string, content: string): void;
    /** Check directory exists. Used at template-root level only. */
    isDirectory(absPath: string): boolean;
    /** List files (recursively) under absPath, returning paths
     *  relative to absPath. Used to walk the template's files/ tree.
     *  Returns [] if path doesn't exist. */
    listFilesRecursive(absPath: string): string[];
}

/**
 * Per-file conflict classification. The dialog UI uses this to
 * decide whether to proceed cleanly, warn the user, or refuse.
 */
export type ConflictKind =
    | 'safe'         // destination doesn't exist; will be created
    | 'identical'    // destination matches template byte-for-byte; skip
    | 'empty'        // destination exists but is empty; will overwrite
    | 'blocking';    // destination has different content; refuse

/**
 * Per-file plan entry. One per file in the template's files/ tree.
 */
export interface ConflictPlanEntry {
    /** Path relative to workspace root, e.g. `src/index.ts`. */
    relativePath: string;
    /** Absolute path the file would be written to. */
    absoluteDestPath: string;
    /** Absolute path of the source file in the template. */
    absoluteSourcePath: string;
    /** Classification per the table in the module docstring. */
    kind: ConflictKind;
}

/**
 * Aggregate conflict-plan result. Caller checks `hasBlockingConflicts`
 * to decide whether to refuse the scaffold.
 */
export interface ConflictPlan {
    /** All entries, including safe ones — the apply step uses the
     *  same list so we don't walk the template twice. */
    entries: ConflictPlanEntry[];
    /** Quick check: any entries of kind 'blocking'? */
    hasBlockingConflicts: boolean;
    /** Conflict counts by kind, for UI summary. */
    counts: Record<ConflictKind, number>;
}

/**
 * Walk the template's `files/` tree and classify every destination.
 * Read-only — does not write to the workspace. Pure function of the
 * filesystem state at call time (so the caller should treat the
 * result as a snapshot, not a guarantee — we re-check in apply).
 */
export function planConflicts(
    template: TemplateMetadata,
    workspaceRoot: string,
    fs: ScaffoldFs
): ConflictPlan {
    const filesRoot = path.join(template.rootPath, 'files');
    if (!fs.isDirectory(filesRoot)) {
        // Template has no files/ — return an empty plan so apply
        // is a no-op. Logged because this is usually a misconfigured
        // template (template.json with no actual files to ship).
        log.warn(`[Scaffold] Template ${template.id} has no files/ directory at ${filesRoot}`);
        return {
            entries: [],
            hasBlockingConflicts: false,
            counts: { safe: 0, identical: 0, empty: 0, blocking: 0 },
        };
    }

    const relativeFiles = fs.listFilesRecursive(filesRoot);
    const entries: ConflictPlanEntry[] = [];
    const counts: Record<ConflictKind, number> = {
        safe: 0, identical: 0, empty: 0, blocking: 0,
    };

    for (const relativePath of relativeFiles) {
        const absoluteSourcePath = path.join(filesRoot, relativePath);
        const absoluteDestPath = path.join(workspaceRoot, relativePath);
        const existing = fs.readFile(absoluteDestPath);
        let kind: ConflictKind;
        if (existing === null) {
            kind = 'safe';
        } else if (existing.length === 0) {
            kind = 'empty';
        } else {
            const templateContent = fs.readFile(absoluteSourcePath);
            if (templateContent === null) {
                // Template file disappeared between listing and read —
                // race condition, treat as blocking so we don't silently
                // half-apply. Real-world: someone deleted the template
                // mid-flight, very rare.
                log.warn(`[Scaffold] Template file missing at apply-time: ${absoluteSourcePath}`);
                kind = 'blocking';
            } else if (templateContent === existing) {
                kind = 'identical';
            } else {
                kind = 'blocking';
            }
        }
        entries.push({ relativePath, absoluteDestPath, absoluteSourcePath, kind });
        counts[kind]++;
    }

    return {
        entries,
        hasBlockingConflicts: counts.blocking > 0,
        counts,
    };
}

/**
 * Apply options. `force` is a deliberate footgun — if a future
 * V2.1.5 admin-portal ships a "force overwrite" path, that's the
 * one place that should set this flag. v2.1.2 callers always leave
 * it false; the conflict plan is the safety net.
 */
export interface ApplyOptions {
    force?: boolean;
}

export interface ApplyResult {
    /** Files actually written (kind=safe or kind=empty). */
    written: string[];
    /** Files skipped because they were byte-identical. */
    skipped: string[];
    /** Should always be empty unless force=true; populated only as
     *  a record of forced overwrites for the audit log. */
    forced: string[];
}

/**
 * Apply the template into the workspace. Refuses (throws) if the
 * conflict plan has any blocking entries unless force=true.
 *
 * Defense in depth:
 *   - Re-runs planConflicts internally rather than trusting a
 *     caller-supplied plan (which could be stale).
 *   - Checks each destination is inside workspaceRoot before writing.
 *     The path-traversal guard isn't strictly necessary — templates
 *     ship with relative paths under files/ which can't escape with
 *     normal path.join — but a malformed template with `..` segments
 *     would otherwise be a real risk. Better to refuse than to write
 *     outside the workspace.
 */
export function applyTemplate(
    template: TemplateMetadata,
    workspaceRoot: string,
    fs: ScaffoldFs,
    options: ApplyOptions = {}
): ApplyResult {
    const plan = planConflicts(template, workspaceRoot, fs);
    if (plan.hasBlockingConflicts && !options.force) {
        const blockingFiles = plan.entries
            .filter(e => e.kind === 'blocking')
            .map(e => e.relativePath);
        throw new Error(
            `Scaffold refused: ${blockingFiles.length} file(s) would be overwritten: ` +
            blockingFiles.slice(0, 5).join(', ') +
            (blockingFiles.length > 5 ? `, ... (+${blockingFiles.length - 5} more)` : '')
        );
    }

    const result: ApplyResult = { written: [], skipped: [], forced: [] };
    const normalizedRoot = path.resolve(workspaceRoot);

    for (const entry of plan.entries) {
        // Path-traversal guard. After resolving to absolute, the
        // destination MUST be under workspaceRoot. If it isn't, the
        // template is malformed (or hostile) and we abort the entire
        // apply — partial writes would be worse than nothing.
        const resolvedDest = path.resolve(entry.absoluteDestPath);
        if (!resolvedDest.startsWith(normalizedRoot + path.sep) && resolvedDest !== normalizedRoot) {
            throw new Error(
                `Scaffold refused: template path escapes workspace root: ${entry.relativePath}`
            );
        }

        if (entry.kind === 'identical') {
            result.skipped.push(entry.relativePath);
            continue;
        }

        const sourceContent = fs.readFile(entry.absoluteSourcePath);
        if (sourceContent === null) {
            // Source disappeared between plan and apply. Treat as
            // hard error — partial scaffolds are worse than none.
            throw new Error(
                `Scaffold failed: template file missing at apply-time: ${entry.relativePath}`
            );
        }

        fs.writeFile(entry.absoluteDestPath, sourceContent);
        if (entry.kind === 'blocking' && options.force) {
            result.forced.push(entry.relativePath);
        } else {
            result.written.push(entry.relativePath);
        }
    }

    return result;
}