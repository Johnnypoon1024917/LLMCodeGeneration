"use strict";
// src/context/traceabilityCache.ts
//
// V2.1.2 spec-fix-7: persistent cache for the traceability matrix.
//
// Why this exists:
//   The traceability matrix in the code map page is built from per-feature
//   LLM calls — parseRequirementGraph + parseDesignGraph for each spec.
//   With 5 specs that's 10 LLM calls per refresh, ~80 seconds at Qwen 3.6
//   speed. Without persistence, every VS Code reload throws away that work
//   and the user waits 80 seconds again to see their matrix.
//
//   This module persists each feature's parsed graphs to
//   `.nexus/cache/traceability.json`, keyed by content hash so we can
//   invalidate per-feature when only one spec changes.
//
// Why per-feature instead of whole-matrix:
//   The single most common edit pattern is "change one spec, refresh map."
//   Whole-matrix invalidation would force re-parsing all 5 specs because
//   one changed. Per-feature only re-parses what changed.
//
// Why on-disk instead of workspaceState:
//   - Visible to the user (can gitignore, can manually delete if needed)
//   - Same .nexus/* convention as specs/ + steering/
//   - No size limit concerns (workspaceState has soft 1MB cap)
//   - Survives if the workspace is moved/copied
//
// Failure modes (all degrade to "cache miss" → rebuild):
//   - File doesn't exist (first run)
//   - File is corrupt JSON
//   - Schema version mismatch (we shipped a new format)
//   - Individual feature entry has missing/wrong-typed fields
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
exports.TraceabilityCache = void 0;
exports.hashContent = hashContent;
const vscode = __importStar(require("vscode"));
const logger_1 = require("../logger");
const CACHE_FILE = 'traceability.json';
const CACHE_SCHEMA_VERSION = 1;
/**
 * Cheap content hash. We don't need cryptographic strength — collision
 * resistance for typical edit patterns is what matters. djb2 is well-
 * tested for this and produces a stable hex string.
 */
function hashContent(content) {
    if (!content) {
        return '';
    }
    let h = 5381;
    for (let i = 0; i < content.length; i++) {
        h = ((h << 5) + h + content.charCodeAt(i)) | 0;
    }
    // Convert to unsigned hex for readability
    return (h >>> 0).toString(16);
}
/**
 * Persistent traceability cache, scoped to one workspace via the
 * provided cache-directory URI. Construct once per cache request and
 * call load() before reading; the in-memory state is hydrated lazily.
 *
 * Concurrency: callers should serialize reads/writes through the
 * SidebarProvider's existing request-graph code path. We don't lock
 * the file because there's only one extension instance per workspace.
 */
class TraceabilityCache {
    cacheUri;
    features = new Map();
    loaded = false;
    constructor(cacheDir) {
        this.cacheUri = vscode.Uri.joinPath(cacheDir, CACHE_FILE);
    }
    /**
     * Read the cache file and hydrate in-memory state. Idempotent —
     * subsequent calls are no-ops. Defensive against every common
     * failure mode (missing file, corrupt JSON, schema mismatch);
     * any failure produces an empty cache rather than throwing, so
     * callers can use the result unconditionally.
     */
    async load() {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        let raw;
        try {
            raw = await vscode.workspace.fs.readFile(this.cacheUri);
        }
        catch {
            // File doesn't exist — first run, or user manually deleted.
            // Empty cache is the correct state.
            logger_1.log.debug('[TraceabilityCache] No cache file found; starting fresh.');
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        }
        catch (e) {
            logger_1.log.warn('[TraceabilityCache] Cache file is corrupt JSON; ignoring:', e instanceof Error ? e.message : String(e));
            return;
        }
        if (!parsed || typeof parsed !== 'object') {
            logger_1.log.warn('[TraceabilityCache] Cache file is not an object; ignoring.');
            return;
        }
        if (parsed.version !== CACHE_SCHEMA_VERSION) {
            logger_1.log.info(`[TraceabilityCache] Cache schema version ${parsed.version} != ${CACHE_SCHEMA_VERSION}; treating as miss.`);
            return;
        }
        if (!parsed.features || typeof parsed.features !== 'object') {
            logger_1.log.warn('[TraceabilityCache] Cache file has no features map; ignoring.');
            return;
        }
        // Hydrate, validating each entry. Skip individual entries that
        // look malformed rather than rejecting the whole cache.
        let loaded = 0;
        for (const [slug, entryUnknown] of Object.entries(parsed.features)) {
            const entry = entryUnknown;
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            // Minimal validation — fields can be empty strings/null but
            // must have the right shape.
            if (typeof entry.reqHash !== 'string' || typeof entry.designHash !== 'string' || typeof entry.tasksHash !== 'string') {
                logger_1.log.warn(`[TraceabilityCache] Skipping malformed entry for "${slug}".`);
                continue;
            }
            this.features.set(slug, {
                reqHash: entry.reqHash,
                reqGraph: entry.reqGraph || null,
                designHash: entry.designHash,
                designGraph: entry.designGraph || null,
                tasksHash: entry.tasksHash,
                tasksJson: entry.tasksJson || null,
            });
            loaded++;
        }
        logger_1.log.info(`[TraceabilityCache] Loaded ${loaded} feature entr${loaded === 1 ? 'y' : 'ies'} from disk.`);
    }
    /** Return the cached entry for a feature slug, or null if missing.
     *  Callers must call load() first. */
    get(slug) {
        return this.features.get(slug) ?? null;
    }
    /** Write or replace the entry for a feature. Doesn't persist to
     *  disk — call save() when done with all updates to batch the
     *  filesystem write. */
    set(slug, entry) {
        this.features.set(slug, entry);
    }
    /** Remove an entry — used when a feature is deleted (currently no
     *  UI surface for that, but defensive). */
    delete(slug) {
        return this.features.delete(slug);
    }
    /** Persist the in-memory cache to disk. Atomic-ish: VS Code's
     *  workspace.fs.writeFile does the underlying replace. We don't
     *  do tmp-file-and-rename because the cache failing to write isn't
     *  a correctness issue (we'll just rebuild next time). */
    async save(cacheDir) {
        const payload = {
            version: CACHE_SCHEMA_VERSION,
            features: Object.fromEntries(this.features.entries()),
            updatedAt: new Date().toISOString(),
        };
        try {
            // Ensure the directory exists before writing.
            await vscode.workspace.fs.createDirectory(cacheDir);
            await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
            logger_1.log.debug(`[TraceabilityCache] Saved ${this.features.size} feature entries to disk.`);
        }
        catch (e) {
            // Cache write failure is non-fatal — we'll rebuild next refresh.
            logger_1.log.warn('[TraceabilityCache] Failed to save:', e instanceof Error ? e.message : String(e));
        }
    }
    /** Clear all cached entries. Doesn't persist — caller decides whether
     *  to save() afterwards (typically yes). Used by the "force refresh"
     *  path in the SidebarProvider. */
    clear() {
        this.features.clear();
    }
    /** Stats for diagnostic logging / status messages. */
    size() {
        return this.features.size;
    }
}
exports.TraceabilityCache = TraceabilityCache;
//# sourceMappingURL=traceabilityCache.js.map