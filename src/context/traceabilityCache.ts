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

import * as vscode from 'vscode';
import { log } from '../logger';
import type { GraphData } from './traceabilityGraph';

const CACHE_FILE = 'traceability.json';
const CACHE_SCHEMA_VERSION = 1;

/** Per-feature cached entry. All three pieces are independently hashed
 *  because they come from different files and change at different rates
 *  — typically requirements churns most, design occasionally, tasks
 *  rarely after generation. */
export interface FeatureCacheEntry {
    /** SHA-1-ish hash of requirements.md content. Empty string if no
     *  requirements were cached for this feature. */
    reqHash: string;
    reqGraph: GraphData | null;

    designHash: string;
    designGraph: GraphData | null;

    tasksHash: string;
    /** The implementationTasks payload, augmented with `_featureSlug`
     *  on each task for downstream cross-feature linking. */
    tasksJson: any;
}

interface CacheFileShape {
    version: number;
    /** Map from feature slug → cached entry. Stored as a plain object
     *  so JSON serialization is direct; converted to Map on load for
     *  the public API. */
    features: Record<string, FeatureCacheEntry>;
    /** ISO timestamp of the last write — informational only, used
     *  by debug logs. Not consulted for invalidation. */
    updatedAt: string;
}

/**
 * Cheap content hash. We don't need cryptographic strength — collision
 * resistance for typical edit patterns is what matters. djb2 is well-
 * tested for this and produces a stable hex string.
 */
export function hashContent(content: string): string {
    if (!content) { return ''; }
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
export class TraceabilityCache {
    private cacheUri: vscode.Uri;
    private features: Map<string, FeatureCacheEntry> = new Map();
    private loaded: boolean = false;

    constructor(cacheDir: vscode.Uri) {
        this.cacheUri = vscode.Uri.joinPath(cacheDir, CACHE_FILE);
    }

    /**
     * Read the cache file and hydrate in-memory state. Idempotent —
     * subsequent calls are no-ops. Defensive against every common
     * failure mode (missing file, corrupt JSON, schema mismatch);
     * any failure produces an empty cache rather than throwing, so
     * callers can use the result unconditionally.
     */
    async load(): Promise<void> {
        if (this.loaded) { return; }
        this.loaded = true;

        let raw: Uint8Array;
        try {
            raw = await vscode.workspace.fs.readFile(this.cacheUri);
        } catch {
            // File doesn't exist — first run, or user manually deleted.
            // Empty cache is the correct state.
            log.debug('[TraceabilityCache] No cache file found; starting fresh.');
            return;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(new TextDecoder().decode(raw));
        } catch (e) {
            log.warn('[TraceabilityCache] Cache file is corrupt JSON; ignoring:', e instanceof Error ? e.message : String(e));
            return;
        }

        if (!parsed || typeof parsed !== 'object') {
            log.warn('[TraceabilityCache] Cache file is not an object; ignoring.');
            return;
        }

        if (parsed.version !== CACHE_SCHEMA_VERSION) {
            log.info(`[TraceabilityCache] Cache schema version ${parsed.version} != ${CACHE_SCHEMA_VERSION}; treating as miss.`);
            return;
        }

        if (!parsed.features || typeof parsed.features !== 'object') {
            log.warn('[TraceabilityCache] Cache file has no features map; ignoring.');
            return;
        }

        // Hydrate, validating each entry. Skip individual entries that
        // look malformed rather than rejecting the whole cache.
        let loaded = 0;
        for (const [slug, entryUnknown] of Object.entries(parsed.features)) {
            const entry = entryUnknown as any;
            if (!entry || typeof entry !== 'object') { continue; }
            // Minimal validation — fields can be empty strings/null but
            // must have the right shape.
            if (typeof entry.reqHash !== 'string' || typeof entry.designHash !== 'string' || typeof entry.tasksHash !== 'string') {
                log.warn(`[TraceabilityCache] Skipping malformed entry for "${slug}".`);
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

        log.info(`[TraceabilityCache] Loaded ${loaded} feature entr${loaded === 1 ? 'y' : 'ies'} from disk.`);
    }

    /** Return the cached entry for a feature slug, or null if missing.
     *  Callers must call load() first. */
    get(slug: string): FeatureCacheEntry | null {
        return this.features.get(slug) ?? null;
    }

    /** Write or replace the entry for a feature. Doesn't persist to
     *  disk — call save() when done with all updates to batch the
     *  filesystem write. */
    set(slug: string, entry: FeatureCacheEntry): void {
        this.features.set(slug, entry);
    }

    /** Remove an entry — used when a feature is deleted (currently no
     *  UI surface for that, but defensive). */
    delete(slug: string): boolean {
        return this.features.delete(slug);
    }

    /** Persist the in-memory cache to disk. Atomic-ish: VS Code's
     *  workspace.fs.writeFile does the underlying replace. We don't
     *  do tmp-file-and-rename because the cache failing to write isn't
     *  a correctness issue (we'll just rebuild next time). */
    async save(cacheDir: vscode.Uri): Promise<void> {
        const payload: CacheFileShape = {
            version: CACHE_SCHEMA_VERSION,
            features: Object.fromEntries(this.features.entries()),
            updatedAt: new Date().toISOString(),
        };
        try {
            // Ensure the directory exists before writing.
            await vscode.workspace.fs.createDirectory(cacheDir);
            await vscode.workspace.fs.writeFile(
                this.cacheUri,
                Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
            );
            log.debug(`[TraceabilityCache] Saved ${this.features.size} feature entries to disk.`);
        } catch (e) {
            // Cache write failure is non-fatal — we'll rebuild next refresh.
            log.warn('[TraceabilityCache] Failed to save:', e instanceof Error ? e.message : String(e));
        }
    }

    /** Clear all cached entries. Doesn't persist — caller decides whether
     *  to save() afterwards (typically yes). Used by the "force refresh"
     *  path in the SidebarProvider. */
    clear(): void {
        this.features.clear();
    }

    /** Stats for diagnostic logging / status messages. */
    size(): number {
        return this.features.size;
    }
}