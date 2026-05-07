// src/specs/SteeringManager.ts
//
// Host-side state for the steering rules panel (PR 3.3).
//
// Responsibilities:
//   - Discover all .md files in .nexus/steering/
//   - Always include the 3 canonical files (product, structure, tech)
//     in the list, even if they don't exist on disk yet — the UI
//     offers a one-click create
//   - Watch the steering directory for changes and notify subscribers
//   - Create canonical files with starter templates on demand
//
// Architecture mirrors HookManager:
//   - Singleton (one workspace = one steering manager)
//   - Subscribe(callback) returning a disposer
//   - notifyListSubscribers() called on FS changes
//
// Why a separate manager (not just SpecManager methods):
//   SpecManager is a stateless I/O facade. SteeringManager has live
//   state (subscriber list, FS watcher), so it deserves its own
//   class. SpecManager remains the source-of-truth for *paths*;
//   SteeringManager owns the *lifecycle*.

import * as vscode from 'vscode';
import { SpecManager } from './SpecManager';

/** Public summary type for the webview payload. Strict shape because
 *  this crosses the postMessage boundary. */
export interface SteeringSummaryView {
    id: string;
    name: string;
    description?: string;
    kind: 'canonical' | 'custom';
    exists: boolean;
    lastModified?: string;
}

/** The 3 canonical Kiro-convention steering files. Each has a stable
 *  id (filename without extension), a display name, a one-line
 *  description, and a starter template used when the user clicks
 *  "Create" on a missing file. */
interface CanonicalSpec {
    id: string;
    name: string;
    description: string;
    template: string;
}

const CANONICAL_FILES: readonly CanonicalSpec[] = [
    {
        id: 'product',
        name: 'Product',
        description: "What you're building, who it's for, what success looks like.",
        template:
`# Product

## What we're building

<!-- Briefly describe the product or feature you're building. The
agent reads this file before every task to understand the bigger
picture. Keep it under a page. -->

## Target users

<!-- Who is this for? What's their context? Examples:
  - Compliance officers at HK financial institutions
  - Solo developers building side projects
  - Senior engineers reviewing AI-generated code -->

## Success criteria

<!-- How do we know this is working? Concrete signals only -
not vibes. Examples:
  - Generated code passes type checks 95% of the time
  - Audit log integrity check holds across a 1000-task session
  - First-time-user can install + write a spec in <10 minutes -->

## Non-goals

<!-- What this product is NOT. Helps the agent avoid scope creep. -->
`
    },
    {
        id: 'structure',
        name: 'Structure',
        description: 'Folder layout, naming conventions, file organization.',
        template:
`# Structure

## Folder layout

<!-- Describe the project's directory structure. Example:

  src/
    agents/         - LLM-driven agents (Planner, Coder, Verifier)
    audit/          - Hash-chained append-only log
    hooks/          - File-save / command / schedule triggers
    specs/          - Spec-driven workflow state
  webview-ui/
    src/            - React webview source
    src/components/ - Generic UI primitives
    src/views/      - Route-level views
-->

## Naming conventions

<!-- File naming, class naming, test file location. Examples:
  - PascalCase for component files (ToolCallCard.tsx)
  - camelCase for utility files (toolEvents.ts)
  - Tests in src/test/unit/<name>.test.ts mirroring src/<name>.ts -->

## What goes where

<!-- Decision rules for "I'm adding X — where does it go?". Examples:
  - New LLM agent → src/agents/
  - New UI primitive used by 2+ views → src/components/ui/
  - New view bound to a route → src/views/<route>/ -->
`
    },
    {
        id: 'tech',
        name: 'Tech',
        description: 'Languages, frameworks, libraries, version constraints.',
        template:
`# Tech

## Stack

<!-- Languages, runtimes, target platforms. Examples:
  - TypeScript 5.x
  - Node 18+ (host runtime)
  - VS Code 1.85+ (extension target)
  - React 18.2 (webview) — locked, no upgrade without ADR -->

## Approved libraries

<!-- Dependencies the agent is allowed to add. Anything not on this
list requires explicit user approval. Examples:
  - tailwindcss, radix-ui, lucide-react (UI)
  - react-i18next, i18next (localization)
  - vitest, @testing-library/react (testing) -->

## Forbidden patterns

<!-- Things the agent must never do. Examples:
  - No localStorage / sessionStorage in the webview (CSP blocks)
  - No remote font imports (CSP blocks)
  - No dynamic chunk splits (Vite config: inlineDynamicImports: true)
  - No 'any' type without an inline justification comment -->

## Build & test

<!-- Commands the agent should know about. Examples:
  - npm run compile  (host tsc + manifest validation)
  - npm test         (jest, host)
  - cd webview-ui && npm test  (vitest, webview) -->
`
    }
];

const CANONICAL_IDS = new Set(CANONICAL_FILES.map((f) => f.id));

export class SteeringManager {
    private static _instance: SteeringManager | null = null;

    private specs!: SpecManager;
    private watcher: vscode.FileSystemWatcher | undefined;
    private subscribers: Array<(summaries: SteeringSummaryView[]) => void> = [];

    static getInstance(): SteeringManager {
        if (!SteeringManager._instance) {
            SteeringManager._instance = new SteeringManager();
        }
        return SteeringManager._instance;
    }

    private constructor() {}

    /**
     * Initialize. Sets up a FS watcher so external edits to .md files
     * in the steering directory trigger a re-scan and subscribers get
     * notified. Idempotent — calling twice tears down the old watcher.
     */
    start(workspaceRoot: vscode.Uri): void {
        this.specs = new SpecManager(workspaceRoot);

        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }

        const glob = new vscode.RelativePattern(this.specs.steeringDir(), '*.md');
        this.watcher = vscode.workspace.createFileSystemWatcher(glob);
        const reload = () => {
            // Re-scan and notify. Errors are caught so a transient FS
            // glitch doesn't crash the watcher.
            this.notifyListSubscribers().catch((e) => {
                console.warn('[SteeringManager] notify failed:', e);
            });
        };
        this.watcher.onDidChange(reload);
        this.watcher.onDidCreate(reload);
        this.watcher.onDidDelete(reload);
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        this.subscribers = [];
    }

    /**
     * Returns a serializable view of all steering files: the 3
     * canonical files (always present, marked exists/missing) plus
     * any custom .md files actually on disk. Sorted: canonical first
     * in the canonical order, custom files alphabetically after.
     */
    async getSteeringSummaries(): Promise<SteeringSummaryView[]> {
        const summaries: SteeringSummaryView[] = [];
        const seenCustom = new Set<string>();

        // Canonical files first, in the canonical order.
        for (const c of CANONICAL_FILES) {
            const uri = vscode.Uri.joinPath(this.specs.steeringDir(), `${c.id}.md`);
            const stat = await this.tryStat(uri);
            const summary: SteeringSummaryView = {
                id: c.id,
                name: c.name,
                description: c.description,
                kind: 'canonical',
                exists: stat !== null
            };
            if (stat) {
                summary.lastModified = new Date(stat.mtime).toISOString();
            }
            summaries.push(summary);
        }

        // Custom files: anything in the steering dir that's a .md file
        // and isn't one of the canonical names.
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.specs.steeringDir());
            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File || !name.endsWith('.md')) {
                    continue;
                }
                const id = name.replace(/\.md$/, '');
                if (CANONICAL_IDS.has(id)) {
                    continue;
                }
                if (seenCustom.has(id)) {
                    continue;
                }
                seenCustom.add(id);
                const uri = vscode.Uri.joinPath(this.specs.steeringDir(), name);
                const stat = await this.tryStat(uri);
                const summary: SteeringSummaryView = {
                    id,
                    name: id,
                    kind: 'custom',
                    exists: true
                };
                if (stat) {
                    summary.lastModified = new Date(stat.mtime).toISOString();
                }
                summaries.push(summary);
            }
        } catch {
            // Steering dir doesn't exist yet — that's fine. Canonical
            // files just show as missing; user can create them.
        }

        // Sort custom files alphabetically, leaving canonical in their
        // declared order. We do this by sorting only the tail.
        const canonicalCount = CANONICAL_FILES.length;
        const customs = summaries.slice(canonicalCount);
        customs.sort((a, b) => a.name.localeCompare(b.name));
        return [...summaries.slice(0, canonicalCount), ...customs];
    }

    /**
     * Subscribe to list changes. Fires on every FS event (create /
     * change / delete). Initial state is delivered synchronously so
     * subscribers don't have to wait for the next change to populate.
     * Returns a disposer.
     */
    subscribeListChanges(callback: (summaries: SteeringSummaryView[]) => void): () => void {
        this.subscribers.push(callback);
        // Deliver current state. Async — the callback may be called
        // after subscribeListChanges returns.
        this.getSteeringSummaries()
            .then((summaries) => {
                try {
                    callback(summaries);
                } catch (e) {
                    console.warn('[SteeringManager] subscriber threw on initial deliver:', e);
                }
            })
            .catch((e) => {
                console.warn('[SteeringManager] initial scan failed:', e);
            });
        return () => {
            const idx = this.subscribers.indexOf(callback);
            if (idx !== -1) {
                this.subscribers.splice(idx, 1);
            }
        };
    }

    /**
     * P1.2: read one steering file's raw content. Returns null when
     * the file doesn't exist (canonical files often don't until the
     * user clicks "Create"). Errors surface to the caller via throw.
     *
     * Used by buildSteeringPromptBlock; exposed publicly because future
     * features (e.g. the steering panel's preview tooltip) may want
     * direct access without going through aggregation.
     */
    async readSteeringContent(id: string): Promise<string | null> {
        const slug = this.slugify(id);
        const uri = vscode.Uri.joinPath(this.specs.steeringDir(), `${slug}.md`);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }

    /**
     * P1.2: aggregate all active steering files into a single string
     * suitable for injection into agent system prompts.
     *
     * "Active" means: the file exists on disk AND has non-trivial
     * content. Files that exist but contain only the starter template
     * (just headers + HTML comments) are filtered out — injecting them
     * would teach the agent to follow placeholder instructions like
     * "<!-- Briefly describe the product -->" which is worse than
     * having no steering at all.
     *
     * Output format (when at least one active file exists):
     *
     *   # Steering: project conventions
     *
     *   The following are project-specific conventions the agent
     *   MUST follow. They take precedence over generic best practices.
     *
     *   ## product
     *   <content>
     *
     *   ## structure
     *   <content>
     *
     *   ...
     *
     * Returns empty string when no active steering files exist —
     * callers can concatenate unconditionally without checking length.
     *
     * Order: canonical files first (product → structure → tech) in
     * their canonical order, custom files alphabetically after.
     * Matches getSteeringSummaries ordering for consistency.
     *
     * Size guard: total content is capped at 32KB. Steering is meant
     * to be lean — beyond ~30KB the agent loses context budget for
     * the actual task. If the user has more, the tail is dropped with
     * a "[... steering content truncated]" marker so they know.
     *
     * Implementation note: the FS-touching part (read files) lives
     * here in the class; the pure content-aggregation part lives in
     * `formatSteeringPromptBlock` so it can be unit-tested without
     * vscode mocks.
     */
    async buildSteeringPromptBlock(opts: {
        /** P2.2: target filepath of the active task (workspace-
         *  relative or absolute — both work, normalization happens
         *  inside steeringScopeMatches). When provided, steering files
         *  that declare an `## Applies to` section ONLY contribute to
         *  the prompt if at least one of their scope prefixes matches
         *  this path. Files without a scope section apply globally.
         *
         *  When omitted (the planner case — there's no specific
         *  filepath at plan time, the planner sees the whole task
         *  set), all steering files contribute regardless of scope. */
        targetFilepath?: string;
    } = {}): Promise<string> {
        const summaries = await this.getSteeringSummaries();
        const sources: Array<{ name: string; content: string }> = [];

        for (const summary of summaries) {
            if (!summary.exists) { continue; }
            const raw = await this.readSteeringContent(summary.id);
            if (!raw) { continue; }

            // P2.2: scope filter. If a target filepath is provided
            // AND this steering file declares scopes, the file only
            // contributes when at least one scope prefix matches.
            // Files without a scope section pass through unchanged.
            if (opts.targetFilepath !== undefined) {
                const scopes = extractApplyToScopesFromContent(raw);
                if (scopes.length > 0 && !steeringScopeMatches(opts.targetFilepath, scopes)) {
                    continue;
                }
            }

            sources.push({ name: summary.name, content: raw });
        }

        return formatSteeringPromptBlock(sources);
    }

    /**
     * Create a steering file. For canonical ids, writes a starter
     * template; for custom ids, writes a blank file with a header.
     * If the file already exists, this is a no-op (we don't overwrite —
     * the UI prevents this case by only showing "Create" on missing
     * files, but we double-check at the layer of authority).
     */
    async ensureSteeringFile(id: string): Promise<void> {
        const slug = this.slugify(id);
        if (!slug) {
            return;
        }
        const uri = vscode.Uri.joinPath(this.specs.steeringDir(), `${slug}.md`);

        // Idempotency: if it exists, don't touch it.
        const existing = await this.tryStat(uri);
        if (existing) {
            // Still notify so the UI updates if the existing-state was
            // out of date for some reason.
            await this.notifyListSubscribers();
            return;
        }

        // Ensure the steering dir exists.
        await vscode.workspace.fs.createDirectory(this.specs.steeringDir());

        const canonical = CANONICAL_FILES.find((c) => c.id === slug);
        const content = canonical
            ? canonical.template
            : `# ${id}\n\n<!-- Steering rule. The agent reads this before every task. -->\n`;

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        // FS watcher will fire and notifyListSubscribers will run; but
        // we also notify directly to avoid the watcher debounce window.
        await this.notifyListSubscribers();
    }

    /**
     * Open a steering file in VS Code's main editor. If the file
     * doesn't exist, this creates it first (template if canonical,
     * blank if custom) — same UX as Kiro: clicking on a steering
     * entry just gets you to the editor, regardless of state.
     */
    async openSteeringFile(id: string): Promise<void> {
        const slug = this.slugify(id);
        if (!slug) {
            return;
        }
        const uri = vscode.Uri.joinPath(this.specs.steeringDir(), `${slug}.md`);
        const existing = await this.tryStat(uri);
        if (!existing) {
            await this.ensureSteeringFile(slug);
        }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        } catch (e) {
            console.warn(`[SteeringManager] openSteeringFile failed for ${id}:`, e);
        }
    }

    // ─── Internals ─────────────────────────────────────────────────

    private async notifyListSubscribers(): Promise<void> {
        if (this.subscribers.length === 0) {
            return;
        }
        const snapshot = await this.getSteeringSummaries();
        for (const fn of this.subscribers) {
            try {
                fn(snapshot);
            } catch (e) {
                console.warn('[SteeringManager] subscriber threw:', e);
            }
        }
    }

    private async tryStat(uri: vscode.Uri): Promise<vscode.FileStat | null> {
        try {
            return await vscode.workspace.fs.stat(uri);
        } catch {
            return null;
        }
    }

    /** Match SpecManager.slugify behavior — keep it cheap and predictable. */
    private slugify(s: string): string {
        return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '');
    }

    /**
     * P1.3: aggregate exclude-path patterns declared across all
     * active steering files.
     *
     * Convention: any steering file may include a section like
     *
     *     ## Exclude paths
     *     - legacy/
     *     - generated/
     *     - src/deprecated/
     *
     * The header may be `## Exclude paths`, `## Excluded paths`, or
     * `## Exclude` (case-insensitive). Bullets become the patterns.
     * Substring matching — see `pathMatchesAnyExclude` in codeGraph.ts.
     *
     * Why this convention rather than YAML frontmatter:
     *   - Doesn't change the existing canonical-file format
     *   - Authoring is plain markdown, no parser knowledge needed
     *   - Surfaces in the steering panel UI as a normal section
     *
     * Returns the deduplicated list of patterns, or empty array when
     * no steering file declares any.
     */
    async getExcludePatterns(): Promise<string[]> {
        const summaries = await this.getSteeringSummaries();
        const seen = new Set<string>();
        for (const summary of summaries) {
            if (!summary.exists) { continue; }
            const raw = await this.readSteeringContent(summary.id);
            if (!raw) { continue; }
            const patterns = extractExcludePatternsFromContent(raw);
            for (const p of patterns) {
                seen.add(p);
            }
        }
        return Array.from(seen);
    }
}

// ─── P1.2: pure helpers for prompt-block construction ────────────────────
//
// These are extracted from SteeringManager so they can be unit-tested
// without vscode mocks. The class wraps these with FS reads.

/** Cap on the aggregated steering block. ~32KB is a sane budget for
 *  modern context windows — the actual planner prompt is much smaller. */
export const MAX_STEERING_BLOCK_BYTES = 32_000;

/**
 * P1.3: extract exclude-path patterns from a single steering file's
 * raw content.
 *
 * Looks for a header like `## Exclude paths`, `## Excluded paths`,
 * or `## Exclude` (case-insensitive, matched at the start of a line),
 * then collects bulleted items (`- pattern`, `* pattern`, or
 * numbered) until the next H1/H2 header or end of file.
 *
 * HTML comments inside bullets are stripped (template scaffolding).
 * Empty / whitespace-only bullets are dropped. The result is the
 * deduplicated, in-order list.
 *
 * Pure function — exported for unit testing and to make the schema
 * conventions inspectable from outside SteeringManager.
 */
/**
 * P1.3: extract bulleted patterns from a named markdown section.
 *
 * Generic helper underlying both `extractExcludePatternsFromContent`
 * (P1.3) and `extractApplyToScopesFromContent` (P2.2). Given a regex
 * matching the section header (e.g. `^##\s+Exclude paths\s*$`),
 * collects bullet items (`-`, `*`, or numbered) until the next H1/H2
 * header or end of file.
 *
 * Cleaning: strips backtick / single-quote / double-quote wrappers,
 * trims whitespace, deduplicates while preserving first-seen order.
 *
 * Pure function — no FS, no vscode.
 */
export function extractBulletedSection(raw: string, headerRegex: RegExp): string[] {
    // Strip HTML comments first so a commented-out bullet doesn't
    // accidentally become a real pattern.
    const noComments = raw.replace(/<!--[\s\S]*?-->/g, '');
    const lines = noComments.split(/\r?\n/);

    const otherTopHeaderRegex = /^#{1,2}\s+/;
    const bulletRegex = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;

    const patterns: string[] = [];
    const seen = new Set<string>();
    let inSection = false;

    for (const line of lines) {
        if (headerRegex.test(line)) {
            inSection = true;
            continue;
        }
        if (!inSection) { continue; }
        if (otherTopHeaderRegex.test(line)) {
            // Section ended — back to normal markdown
            inSection = false;
            continue;
        }
        const m = bulletRegex.exec(line);
        if (!m || !m[1]) { continue; }
        const pattern = m[1].trim();
        // Drop pure markdown emphasis or empty patterns
        const stripped = pattern.replace(/^[`'"](.*)[`'"]$/, '$1').trim();
        if (!stripped) { continue; }
        if (seen.has(stripped)) { continue; }
        seen.add(stripped);
        patterns.push(stripped);
    }
    return patterns;
}

/**
 * P1.3: extract exclude-path patterns from a single steering file's
 * raw content.
 *
 * Looks for a header like `## Exclude paths`, `## Excluded paths`,
 * or `## Exclude` (case-insensitive, matched at the start of a line),
 * then collects bulleted items (`- pattern`, `* pattern`, or
 * numbered) until the next H1/H2 header or end of file.
 *
 * Pure function — exported for unit testing and to make the schema
 * conventions inspectable from outside SteeringManager.
 */
export function extractExcludePatternsFromContent(raw: string): string[] {
    return extractBulletedSection(raw, /^##\s+Exclude(?:d)?(?:\s+paths)?\s*$/i);
}

/**
 * P2.2: extract the scoped-application patterns from a steering file.
 *
 * Looks for a header like `## Applies to` or `## Scope` (case-
 * insensitive). Each bullet is a path PREFIX (substring match,
 * forward-slash-normalized). When a steering file has at least one
 * scope pattern, it ONLY applies to tasks whose target filepath
 * matches at least one prefix.
 *
 * Steering files WITHOUT a scope section apply globally — that's the
 * default and matches P1.2's behavior (backwards compatible).
 *
 * Pattern matching: P2.2 (2026-05) extended `steeringScopeMatches` to
 * support glob patterns when the scope entry contains glob metacharacters
 * (e.g., "src/server/**"). Plain strings without globs still match by
 * substring inclusion (backward compatible). See steeringScopeMatches
 * below for full semantics.
 *
 * Returns the deduplicated list of scope prefixes, empty when no
 * scope section is declared (= globally applicable).
 */
export function extractApplyToScopesFromContent(raw: string): string[] {
    return extractBulletedSection(raw, /^##\s+(?:Applies\s+to|Scope)\s*$/i);
}

/**
 * P2.2 (2026-05): returns true when a steering file's scope patterns
 * match the given target filepath. Two matching modes, chosen per
 * pattern:
 *
 *   - GLOB MODE — when the pattern contains glob metacharacters
 *     (`*`, `?`, `[`, `!`, `{`, `@`, `+`), we route through picomatch
 *     for proper glob matching. Examples:
 *       "src/server/**"             → matches src/server/foo.ts but
 *                                      NOT src/client/server-stub.ts
 *       "**\/*.test.ts"             → matches any test file
 *       "src/{api,server}/**"       → matches API or server files
 *
 *   - SUBSTRING MODE (legacy/default) — when the pattern is a plain
 *     string with no glob characters, we fall back to forward-slash-
 *     normalized substring inclusion (same as before P2.2). This
 *     preserves backward compatibility with steering files written
 *     as plain prefixes like "src/server/".
 *
 * Why this hybrid approach and not "always glob": existing steering
 * files use plain prefixes. Always-glob would silently break them
 * (a literal `src/server/` is NOT a valid glob pattern). Mode
 * selection by syntax is opt-in: authors who write globs get globs,
 * authors who write prefixes get prefixes.
 *
 * Empty patterns array is "globally applicable" (matches everything).
 */
export function steeringScopeMatches(
    targetFilepath: string,
    scopePatterns: ReadonlyArray<string>
): boolean {
    if (scopePatterns.length === 0) { return true; }
    const normalized = targetFilepath.replace(/\\/g, '/');
    return scopePatterns.some((p) => {
        const trimmed = p.trim();
        if (!trimmed) { return false; }
        const normalizedPattern = trimmed.replace(/\\/g, '/');
        if (containsGlobChars(normalizedPattern)) {
            // Lazy-load picomatch — it's a transitive dep, present
            // in node_modules but not in package.json. We could add
            // it as a direct dep; for now lazy-load tolerates the
            // (rare) case where the transitive resolution is gone.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const picomatch = require('picomatch') as (pattern: string, opts?: object) => (s: string) => boolean;
                const matcher = picomatch(normalizedPattern, { dot: true });
                return matcher(normalized);
            } catch {
                // picomatch unavailable — fall back to substring
                // match, which is wrong for a glob pattern but at
                // least won't throw. Log via console because we
                // don't have logger context in this pure helper.
                return normalized.includes(normalizedPattern.replace(/\*+/g, ''));
            }
        }
        // Non-glob — substring match (legacy behavior preserved).
        return normalized.includes(normalizedPattern);
    });
}

/** Detect glob metacharacters that signal "this is a glob pattern,
 *  not a literal substring." Conservative — we want false negatives
 *  (treat-as-substring) to be safe; false positives (treat-as-glob)
 *  on a plain string is a bug because picomatch interprets it. */
function containsGlobChars(s: string): boolean {
    return /[*?[\]{}!@+]/.test(s);
}

/**
 * Strip HTML comments (template scaffolding) and check if anything
 * meaningful remains. The canonical templates are mostly comments — if
 * the user hasn't filled them in, we treat the file as "not active"
 * rather than feeding the agent placeholder instructions.
 *
 * Returns cleaned content, or empty string if nothing meaningful
 * remained.
 *
 * Heuristics applied (in order):
 *   1. Strip <!-- ... --> comments (greedy, multiline)
 *   2. Collapse runs of 3+ blank lines to one
 *   3. If every non-blank line is a markdown header (starts with #),
 *      return empty — that's a template skeleton with no real content
 */
export function normalizeSteeringContent(raw: string): string {
    const noComments = raw.replace(/<!--[\s\S]*?-->/g, '');
    const collapsed = noComments.replace(/\n{3,}/g, '\n\n');
    const trimmed = collapsed.trim();
    const nonBlankLines = trimmed.split('\n').filter((l) => l.trim().length > 0);
    if (nonBlankLines.length === 0) { return ''; }
    const allHeaders = nonBlankLines.every((l) => l.trim().startsWith('#'));
    if (allHeaders) { return ''; }
    return trimmed;
}

/**
 * Format a list of steering sources into a single prompt-ready string.
 * Each source is `{ name, content }` where name is the section header
 * the agent will see (typically the canonical name like "Product",
 * "Structure", "Tech" or a custom file name).
 *
 * Pipeline:
 *   1. For each source, normalize the content (drop empty / template-only)
 *   2. Concatenate with section headers, until total bytes ≤ MAX
 *   3. Wrap with the "# Steering: project conventions" preamble
 *   4. Append a truncation marker if any sources were dropped
 *
 * Returns empty string when no sources have meaningful content. The
 * empty-string convention lets callers concatenate unconditionally.
 *
 * This function is pure — no FS, no vscode. Unit-test it directly.
 */
export function formatSteeringPromptBlock(
    sources: ReadonlyArray<{ name: string; content: string }>
): string {
    const sections: string[] = [];
    let totalBytes = 0;
    let truncated = false;

    for (const source of sources) {
        const content = normalizeSteeringContent(source.content);
        if (!content) { continue; }
        const section = `## ${source.name}\n${content}`;
        const byteSize = Buffer.byteLength(section, 'utf8');
        if (totalBytes + byteSize > MAX_STEERING_BLOCK_BYTES) {
            truncated = true;
            break;
        }
        sections.push(section);
        totalBytes += byteSize;
    }

    if (sections.length === 0) { return ''; }

    const header =
        `# Steering: project conventions\n\n` +
        `The following are project-specific conventions the agent ` +
        `MUST follow. They take precedence over generic best practices ` +
        `when there is a conflict.\n`;
    const footer = truncated
        ? `\n\n[... steering content truncated at ${MAX_STEERING_BLOCK_BYTES} bytes]`
        : '';

    return `${header}\n${sections.join('\n\n')}${footer}`;
}