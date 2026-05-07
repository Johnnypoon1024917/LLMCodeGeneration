"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.planConflicts = planConflicts;
exports.applyTemplate = applyTemplate;
const path = __importStar(require("path"));
const logger_1 = require("../logger");
/**
 * Walk the template's `files/` tree and classify every destination.
 * Read-only — does not write to the workspace. Pure function of the
 * filesystem state at call time (so the caller should treat the
 * result as a snapshot, not a guarantee — we re-check in apply).
 */
function planConflicts(template, workspaceRoot, fs) {
    const filesRoot = path.join(template.rootPath, 'files');
    if (!fs.isDirectory(filesRoot)) {
        // Template has no files/ — return an empty plan so apply
        // is a no-op. Logged because this is usually a misconfigured
        // template (template.json with no actual files to ship).
        logger_1.log.warn(`[Scaffold] Template ${template.id} has no files/ directory at ${filesRoot}`);
        return {
            entries: [],
            hasBlockingConflicts: false,
            counts: { safe: 0, identical: 0, empty: 0, blocking: 0 },
        };
    }
    const relativeFiles = fs.listFilesRecursive(filesRoot);
    const entries = [];
    const counts = {
        safe: 0, identical: 0, empty: 0, blocking: 0,
    };
    for (const relativePath of relativeFiles) {
        const absoluteSourcePath = path.join(filesRoot, relativePath);
        const absoluteDestPath = path.join(workspaceRoot, relativePath);
        const existing = fs.readFile(absoluteDestPath);
        let kind;
        if (existing === null) {
            kind = 'safe';
        }
        else if (existing.length === 0) {
            kind = 'empty';
        }
        else {
            const templateContent = fs.readFile(absoluteSourcePath);
            if (templateContent === null) {
                // Template file disappeared between listing and read —
                // race condition, treat as blocking so we don't silently
                // half-apply. Real-world: someone deleted the template
                // mid-flight, very rare.
                logger_1.log.warn(`[Scaffold] Template file missing at apply-time: ${absoluteSourcePath}`);
                kind = 'blocking';
            }
            else if (templateContent === existing) {
                kind = 'identical';
            }
            else {
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
function applyTemplate(template, workspaceRoot, fs, options = {}) {
    const plan = planConflicts(template, workspaceRoot, fs);
    if (plan.hasBlockingConflicts && !options.force) {
        const blockingFiles = plan.entries
            .filter(e => e.kind === 'blocking')
            .map(e => e.relativePath);
        throw new Error(`Scaffold refused: ${blockingFiles.length} file(s) would be overwritten: ` +
            blockingFiles.slice(0, 5).join(', ') +
            (blockingFiles.length > 5 ? `, ... (+${blockingFiles.length - 5} more)` : ''));
    }
    const result = { written: [], skipped: [], forced: [] };
    const normalizedRoot = path.resolve(workspaceRoot);
    for (const entry of plan.entries) {
        // Path-traversal guard. After resolving to absolute, the
        // destination MUST be under workspaceRoot. If it isn't, the
        // template is malformed (or hostile) and we abort the entire
        // apply — partial writes would be worse than nothing.
        const resolvedDest = path.resolve(entry.absoluteDestPath);
        if (!resolvedDest.startsWith(normalizedRoot + path.sep) && resolvedDest !== normalizedRoot) {
            throw new Error(`Scaffold refused: template path escapes workspace root: ${entry.relativePath}`);
        }
        if (entry.kind === 'identical') {
            result.skipped.push(entry.relativePath);
            continue;
        }
        const sourceContent = fs.readFile(entry.absoluteSourcePath);
        if (sourceContent === null) {
            // Source disappeared between plan and apply. Treat as
            // hard error — partial scaffolds are worse than none.
            throw new Error(`Scaffold failed: template file missing at apply-time: ${entry.relativePath}`);
        }
        fs.writeFile(entry.absoluteDestPath, sourceContent);
        if (entry.kind === 'blocking' && options.force) {
            result.forced.push(entry.relativePath);
        }
        else {
            result.written.push(entry.relativePath);
        }
    }
    return result;
}
//# sourceMappingURL=scaffoldApplier.js.map