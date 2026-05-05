// src/scaffold/templateLoader.ts
//
// V2.1.1 template discovery for the project scaffolder.
//
// Templates are folders shipped in two locations:
//
//   1. Workspace `.nexus/scaffolds/<id>/` — customer overrides.
//      Versioned with the customer's repo. Wins over built-ins
//      when IDs collide (`node-ts-cli` in customer dir replaces
//      built-in `node-ts-cli`). This is how a regulated customer
//      ships e.g. `banking-compliance-zh-cli` — their compliance
//      conventions baked into their scaffold.
//
//   2. Extension-bundled `<extension>/scaffolds/<id>/` — built-ins.
//      Ship with the VSIX. Five first-class templates in V2.1.2.
//      Customers can't edit these without forking the extension,
//      which is intentional — the customer-overrides path above
//      is the supported customization route.
//
// This module only LISTS metadata (`template.json` per dir). The
// actual scaffold-time file copy lives in scaffoldApplier.ts (a
// future V2.1.1 file). Listing is hot path (every chat turn that
// could be greenfield), applying is cold path (one-shot per project).
// Splitting them lets us cache the listing without holding file
// contents in memory.

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';

/**
 * Metadata per template, parsed from `template.json` in the template
 * folder. Caller uses this to populate the confirmation dropdown.
 *
 * Files themselves are NOT loaded here — see `loadTemplateFiles` in
 * scaffoldApplier (V2.1.1 follow-up) for the apply-time file read.
 */
export interface TemplateMetadata {
    /** Stable identifier — used for stackHint matching from the
     *  greenfield detector and for customer-override resolution.
     *  Convention: lowercase, hyphenated, includes-stack-and-shape
     *  (e.g. "node-ts-cli", "python-fastapi"). */
    id: string;
    /** User-facing name shown in the dropdown. */
    displayName: string;
    /** One-line description shown beneath the displayName in the dropdown. */
    description: string;
    /** Free-form tags used for matching against user prompts. The
     *  greenfield detector doesn't currently use these (it has
     *  hard-coded patterns), but future v2.1.5 could route prompt
     *  matching through the templates themselves. */
    stackTags: string[];
    /** Where this template came from. 'workspace' wins over 'builtin'
     *  in the dropdown — customers' templates appear first. */
    source: 'workspace' | 'builtin';
    /** Absolute path to the template directory. Used at apply time
     *  to copy `files/` into the workspace. */
    rootPath: string;
}

/**
 * Validation result. We're permissive on optional fields but strict
 * on `id` — if a template can't claim an ID, we can't reference it,
 * so it doesn't ship in the dropdown.
 */
function parseTemplateJson(raw: string, sourcePath: string): Omit<TemplateMetadata, 'source' | 'rootPath'> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        log.warn(`[Scaffold] Invalid JSON in ${sourcePath}: ${(e as Error).message}`);
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        log.warn(`[Scaffold] template.json must be an object: ${sourcePath}`);
        return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['id'] !== 'string' || obj['id'].trim() === '') {
        log.warn(`[Scaffold] template.json missing required 'id': ${sourcePath}`);
        return null;
    }
    return {
        id: obj['id'].trim(),
        displayName: typeof obj['displayName'] === 'string' ? obj['displayName'] : obj['id'].trim(),
        description: typeof obj['description'] === 'string' ? obj['description'] : '',
        stackTags: Array.isArray(obj['stackTags'])
            ? obj['stackTags'].filter((t): t is string => typeof t === 'string')
            : [],
    };
}

/**
 * Scan a parent directory for template subfolders. Each subfolder
 * with a valid `template.json` becomes a template. Folders without
 * `template.json` are silently skipped (they might be partial drafts
 * or junk; we don't fail discovery for unrelated folder content).
 *
 * Returns templates in alphabetical order by id for deterministic
 * dropdown ordering. The two callers (`workspace/.nexus/scaffolds/`
 * and `extension/scaffolds/`) merge results, with workspace winning
 * on id collision — see `discoverTemplates` below.
 */
function scanScaffoldsDir(
    parentDir: string,
    source: 'workspace' | 'builtin'
): TemplateMetadata[] {
    if (!fs.existsSync(parentDir)) { return []; }
    let entries: string[];
    try {
        entries = fs.readdirSync(parentDir);
    } catch (e) {
        log.warn(`[Scaffold] Could not read scaffolds dir ${parentDir}: ${(e as Error).message}`);
        return [];
    }

    const templates: TemplateMetadata[] = [];
    for (const entry of entries) {
        const entryPath = path.join(parentDir, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(entryPath); }
        catch { continue; }
        if (!stat.isDirectory()) { continue; }

        const templateJsonPath = path.join(entryPath, 'template.json');
        if (!fs.existsSync(templateJsonPath)) { continue; }

        let raw: string;
        try { raw = fs.readFileSync(templateJsonPath, 'utf-8'); }
        catch (e) {
            log.warn(`[Scaffold] Could not read ${templateJsonPath}: ${(e as Error).message}`);
            continue;
        }
        const parsed = parseTemplateJson(raw, templateJsonPath);
        if (!parsed) { continue; }

        templates.push({ ...parsed, source, rootPath: entryPath });
    }
    return templates.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover all available templates, with customer overrides winning.
 *
 *   workspaceRoot — caller passes vscode.workspace.workspaceFolders[0].uri.fsPath
 *                   or undefined if no workspace is open. When undefined,
 *                   only built-in templates are returned.
 *
 *   extensionRoot — caller passes context.extensionUri.fsPath. We expect
 *                   the built-in scaffolds to live at `<extensionRoot>/scaffolds/`.
 *                   Built-in dir not existing is fine (V2.1.2 ships them);
 *                   we just return an empty list in that case.
 *
 * Customer templates are scanned from `<workspaceRoot>/.nexus/scaffolds/`.
 *
 * The merge rule: for any id present in BOTH sources, the workspace
 * version wins and the built-in is dropped silently. Logging is
 * intentionally muted on collision — customers shadowing built-ins
 * is the supported path, not an error.
 */
export function discoverTemplates(
    workspaceRoot: string | undefined,
    extensionRoot: string
): TemplateMetadata[] {
    const builtins = scanScaffoldsDir(
        path.join(extensionRoot, 'scaffolds'),
        'builtin'
    );
    const workspaceTemplates = workspaceRoot
        ? scanScaffoldsDir(
            path.join(workspaceRoot, '.nexus', 'scaffolds'),
            'workspace'
        )
        : [];

    // Merge: workspace overrides built-ins by id.
    const byId = new Map<string, TemplateMetadata>();
    for (const t of builtins) { byId.set(t.id, t); }
    for (const t of workspaceTemplates) { byId.set(t.id, t); }

    return Array.from(byId.values()).sort((a, b) => {
        // Workspace templates first (customer's intentional choices),
        // then built-ins, alphabetical within each group.
        if (a.source !== b.source) {
            return a.source === 'workspace' ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
    });
}