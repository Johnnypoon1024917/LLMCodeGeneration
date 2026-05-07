// src/specs/SpecManager.ts
//
// Single source of truth for all .nexus/ filesystem paths.
//
// Layout:
//
//   <workspaceRoot>/
//     .nexus/
//       specs/
//         <feature-slug>/
//           requirements.md      # PRD
//           design.md            # System design
//           tasks.md             # Implementation plan with [ ] / [x] checkboxes
//           tasks.json           # Machine-readable mirror of tasks.md
//           failures.md          # Verifier critiques accumulated across attempts
//       steering/
//         product.md             # WHAT we're building, for whom, why
//         structure.md           # Architectural rules (folders, layering)
//         tech.md                # Tech stack constraints, banned APIs, conventions
//       skills/
//         <name>.md              # Markdown slash-command skills
//       hooks/                   # Reserved for future: event-driven agents

import * as vscode from 'vscode';
import { getDeps } from '../container';

/** The default feature slug used when the UI doesn't yet support multi-feature specs. */
export const DEFAULT_FEATURE = 'main';

/**
 * The three phases of the spec workflow, in order. A phase cannot be
 * generated until the previous phase is `approved`.
 */
export type Phase = 'requirements' | 'design' | 'tasks';
export const PHASE_ORDER: Phase[] = ['requirements', 'design', 'tasks'];

/**
 * The status of a single phase.
 *   - `not_started`: no draft has been generated yet
 *   - `draft`: a draft exists, awaiting user approval
 *   - `approved`: user has explicitly approved this phase; downstream phases unlocked
 */
export type PhaseStatus = 'not_started' | 'draft' | 'approved';

export interface PhaseState {
    requirements: PhaseStatus;
    design: PhaseStatus;
    tasks: PhaseStatus;
    /** ISO-8601 timestamp of the last status change. */
    updatedAt: string;
}

const DEFAULT_PHASE_STATE: PhaseState = {
    requirements: 'not_started',
    design:       'not_started',
    tasks:        'not_started',
    updatedAt:    new Date(0).toISOString()
};

export interface SteeringRules {
    product: string;
    structure: string;
    tech: string;
    /** Concatenation of all three with section headers — convenient for prompt injection. */
    combined: string;
}

export class SpecManager {
    constructor(private readonly workspaceRoot: vscode.Uri) {}

    // ─── Directory accessors ────────────────────────────────────────────

    /** `<workspace>/.nexus` */
    nexusDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.workspaceRoot, '.nexus');
    }

    /** `<workspace>/.nexus/specs` */
    specsDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.nexusDir(), 'specs');
    }

    /** `<workspace>/.nexus/steering` */
    steeringDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.nexusDir(), 'steering');
    }

    /** `<workspace>/.nexus/skills` */
    skillsDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.nexusDir(), 'skills');
    }

    /** `<workspace>/.nexus/hooks` */
    hooksDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.nexusDir(), 'hooks');
    }

    /** `<workspace>/.nexus/cache` (V2.1.2 spec-fix-7). Persistent storage for
     *  derived state that's expensive to recompute — currently the
     *  traceability matrix (5+ LLM calls per refresh) but additional
     *  caches may slot in here over time. Auto-created on first write.
     *  Recommended to gitignore: derived state, not source-of-truth. */
    cacheDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.nexusDir(), 'cache');
    }

    /** `<workspace>/.nexus/specs/<slug>` (creates it on disk). */
    async featureDir(featureSlug: string = DEFAULT_FEATURE): Promise<vscode.Uri> {
        const slug = this.slugify(featureSlug);
        const dir = vscode.Uri.joinPath(this.specsDir(), slug);
        await vscode.workspace.fs.createDirectory(dir);
        return dir;
    }

    // ─── File accessors (per feature) ───────────────────────────────────

    requirementsUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'requirements.md');
    }

    designUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'design.md');
    }

    tasksMdUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'tasks.md');
    }

    tasksJsonUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'tasks.json');
    }

    failuresUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'failures.md');
    }

    /** `<workspace>/.nexus/specs/<slug>/.phase-state.json` */
    phaseStateUri(featureSlug: string = DEFAULT_FEATURE): vscode.Uri {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), '.phase-state.json');
    }

    // ─── Steering files ─────────────────────────────────────────────────

    productUri():   vscode.Uri { return vscode.Uri.joinPath(this.steeringDir(), 'product.md'); }
    structureUri(): vscode.Uri { return vscode.Uri.joinPath(this.steeringDir(), 'structure.md'); }
    techUri():      vscode.Uri { return vscode.Uri.joinPath(this.steeringDir(), 'tech.md'); }

    // ─── High-level reads ───────────────────────────────────────────────

    /** Reads requirements.md, returns "" if missing. */
    async readRequirements(featureSlug: string = DEFAULT_FEATURE): Promise<string> {
        return this.readSafe(this.requirementsUri(featureSlug));
    }

    /** Reads design.md, returns "" if missing. */
    async readDesign(featureSlug: string = DEFAULT_FEATURE): Promise<string> {
        return this.readSafe(this.designUri(featureSlug));
    }

    /** Reads tasks.md, returns "" if missing. */
    async readTasksMd(featureSlug: string = DEFAULT_FEATURE): Promise<string> {
        return this.readSafe(this.tasksMdUri(featureSlug));
    }

    /** Reads tasks.json, returns null if missing or unparseable. */
    async readTasksJson(featureSlug: string = DEFAULT_FEATURE): Promise<any | null> {
        const text = await this.readSafe(this.tasksJsonUri(featureSlug));
        if (!text) { return null; }
        try { return JSON.parse(text); } catch { return null; }
    }

    /** Reads failures.md (verifier rejection log), returns "" if missing. */
    async readFailures(featureSlug: string = DEFAULT_FEATURE): Promise<string> {
        return this.readSafe(this.failuresUri(featureSlug));
    }

    /** Reads all three steering files and concatenates them. */
    async readSteering(): Promise<SteeringRules> {
        const [product, structure, tech] = await Promise.all([
            this.readSafe(this.productUri()),
            this.readSafe(this.structureUri()),
            this.readSafe(this.techUri())
        ]);

        const sections: string[] = [];
        if (product) { sections.push(`### Product\n${product}`); }
        if (structure) { sections.push(`### Structure\n${structure}`); }
        if (tech) { sections.push(`### Tech\n${tech}`); }

        return {
            product, structure, tech,
            combined: sections.join('\n\n')
        };
    }

    // ─── High-level writes ──────────────────────────────────────────────

    async writeRequirements(content: string, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.requirementsUri(featureSlug), Buffer.from(content, 'utf8'));
        // A fresh draft always invalidates downstream approvals
        await this.resetFromPhase('requirements', featureSlug);
        await this.setPhaseStatus('requirements', 'draft', featureSlug);
        void getDeps().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'requirements',
            description: `Requirements draft updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }

    async writeDesign(content: string, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.designUri(featureSlug), Buffer.from(content, 'utf8'));
        await this.resetFromPhase('design', featureSlug);
        await this.setPhaseStatus('design', 'draft', featureSlug);
        void getDeps().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'design',
            description: `Design draft updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }

    async writeTasksMd(content: string, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.tasksMdUri(featureSlug), Buffer.from(content, 'utf8'));
        void getDeps().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'tasks',
            description: `Tasks markdown updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }

    async writeTasksJson(plan: any, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.tasksJsonUri(featureSlug), Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));
        // tasks.json is the canonical artifact — both writes (md + json) happen
        // close together, but the json write is the one that signals "draft ready"
        await this.setPhaseStatus('tasks', 'draft', featureSlug);
    }

    /** Marks a task line in tasks.md as completed by flipping `[ ]` to `[x]`. */
    async markTaskCompleted(taskDescription: string, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        const uri = this.tasksMdUri(featureSlug);
        try {
            let md = await this.readSafe(uri);
            if (!md) { return; }
            md = md.replace(`[ ] **${taskDescription}**`, `[x] **${taskDescription}**`);
            md = md.replace(`[ ] ${taskDescription}`, `[x] ${taskDescription}`);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
        } catch {
            // Non-fatal — UI keeps state of its own
        }
    }

    /** Writes the steering structure file (used by the legacy ".nexusrules" save flow). */
    async writeStructureRules(content: string): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.steeringDir());
        await vscode.workspace.fs.writeFile(this.structureUri(), Buffer.from(content, 'utf8'));
    }

    // ─── Phase state ────────────────────────────────────────────────────

    /**
     * Reads the phase-state sidecar. Returns `DEFAULT_PHASE_STATE` if the
     * file is missing or malformed — equivalent to "fresh project."
     */
    async readPhaseState(featureSlug: string = DEFAULT_FEATURE): Promise<PhaseState> {
        const text = await this.readSafe(this.phaseStateUri(featureSlug));
        if (!text) { return { ...DEFAULT_PHASE_STATE }; }
        try {
            const parsed = JSON.parse(text);
            // Defend against partial / hand-edited files
            return {
                requirements: this.coerceStatus(parsed.requirements),
                design:       this.coerceStatus(parsed.design),
                tasks:        this.coerceStatus(parsed.tasks),
                updatedAt:    typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
            };
        } catch {
            return { ...DEFAULT_PHASE_STATE };
        }
    }

    /**
     * Sets the status of a single phase. Approving a downstream phase
     * does NOT auto-approve upstream phases (and vice versa). Cascade
     * logic lives in `requirePhaseApproved` and the SidebarProvider.
     */
    async setPhaseStatus(
        phase: Phase,
        status: PhaseStatus,
        featureSlug: string = DEFAULT_FEATURE
    ): Promise<PhaseState> {
        await this.featureDir(featureSlug);
        const current = await this.readPhaseState(featureSlug);
        const next: PhaseState = {
            ...current,
            [phase]: status,
            updatedAt: new Date().toISOString()
        };
        await vscode.workspace.fs.writeFile(
            this.phaseStateUri(featureSlug),
            Buffer.from(JSON.stringify(next, null, 2), 'utf8')
        );
        return next;
    }

    /**
     * Throws if the phases that must be approved before `phase` is allowed
     * to run aren't approved. Used as a guard in the SidebarProvider before
     * each `generate*` handler runs.
     *
     * Example: requirePhaseApproved('design') throws unless requirements is approved.
     */
    async requirePhaseApproved(phase: Phase, featureSlug: string = DEFAULT_FEATURE): Promise<void> {
        const idx = PHASE_ORDER.indexOf(phase);
        if (idx <= 0) return; // 'requirements' has no upstream

        const state = await this.readPhaseState(featureSlug);
        for (let i = 0; i < idx; i++) {
            const upstream = PHASE_ORDER[i];
            if (upstream === undefined) continue; // bounded by idx; defensive
            if (state[upstream] !== 'approved') {
                throw new Error(
                    `Phase '${phase}' is locked: upstream phase '${upstream}' is '${state[upstream]}', must be 'approved'.`
                );
            }
        }
    }

    /**
     * Resets a phase and all downstream phases to 'not_started'. Used when
     * the user rejects a generated draft — we don't want a stale
     * approved=design lingering after the requirements get regenerated.
     */
    async resetFromPhase(phase: Phase, featureSlug: string = DEFAULT_FEATURE): Promise<PhaseState> {
        const current = await this.readPhaseState(featureSlug);
        const idx = PHASE_ORDER.indexOf(phase);
        const next: PhaseState = { ...current };
        for (let i = idx; i < PHASE_ORDER.length; i++) {
            const phaseName = PHASE_ORDER[i];
            if (phaseName === undefined) continue; // bounded by length; defensive
            next[phaseName] = 'not_started';
        }
        next.updatedAt = new Date().toISOString();
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(
            this.phaseStateUri(featureSlug),
            Buffer.from(JSON.stringify(next, null, 2), 'utf8')
        );
        return next;
    }

    // ─── Multi-feature management (V2.1.2 spec-fix-4) ──────────────────
    //
    // Until V2.1.2, every operation defaulted to the `'main'` feature
    // slug because the webview hardcoded it. The data model on disk
    // already supported per-feature directories; we just had no UI for
    // selecting between them. listFeatures() walks the specs/ directory
    // and returns every feature found with its phase status, so the
    // webview can render a switcher dropdown.

    /**
     * Public access to the slug normalizer. Useful for the webview's
     * "preview the on-disk slug while you type the name" affordance —
     * users see "My Checkout Flow!" become "my-checkout-flow" before
     * they commit, avoiding surprise.
     */
    slugifyName(s: string): string {
        return this.slugify(s);
    }

    /**
     * Check whether a feature slug already exists on disk. Used to
     * detect duplicate names before we try to create a new feature
     * (which would silently merge into the existing one).
     */
    async featureExists(featureSlug: string): Promise<boolean> {
        try {
            const stat = await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug))
            );
            return stat.type === vscode.FileType.Directory;
        } catch {
            return false;
        }
    }

    /**
     * List all feature directories under `.nexus/specs/`, with their
     * phase state. Returns an empty array when the specs/ directory
     * doesn't exist yet (fresh workspace).
     *
     * Sort order: alphabetical by slug, with `'main'` always first
     * if present (it's the implicit default and users navigate to
     * it the most).
     */
    async listFeatures(): Promise<{ slug: string; phaseState: PhaseState }[]> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(this.specsDir());
        } catch {
            // specs/ doesn't exist yet — no features.
            return [];
        }

        const dirs = entries
            .filter(([_name, type]) => type === vscode.FileType.Directory)
            .map(([name]) => name);

        // Sort: 'main' first, then alphabetical
        dirs.sort((a, b) => {
            if (a === DEFAULT_FEATURE) { return -1; }
            if (b === DEFAULT_FEATURE) { return 1; }
            return a.localeCompare(b);
        });

        const out: { slug: string; phaseState: PhaseState }[] = [];
        for (const slug of dirs) {
            const phaseState = await this.readPhaseState(slug);
            out.push({ slug, phaseState });
        }
        return out;
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    private coerceStatus(s: any): PhaseStatus {
        return s === 'approved' || s === 'draft' || s === 'not_started' ? s : 'not_started';
    }
    private async readSafe(uri: vscode.Uri): Promise<string> {
        try {
            const buf = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(buf);
        } catch {
            return '';
        }
    }

    private slugify(s: string): string {
        return s.toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-')         // V2.1.2 spec-fix-4: collapse multiple dashes
            .replace(/^-+|-+$/g, '')     // V2.1.2 spec-fix-4: strip ALL leading/trailing
            || DEFAULT_FEATURE;
    }
}