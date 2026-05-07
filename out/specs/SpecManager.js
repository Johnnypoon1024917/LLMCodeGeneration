"use strict";
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
exports.SpecManager = exports.PHASE_ORDER = exports.DEFAULT_FEATURE = void 0;
const vscode = __importStar(require("vscode"));
const container_1 = require("../container");
/** The default feature slug used when the UI doesn't yet support multi-feature specs. */
exports.DEFAULT_FEATURE = 'main';
exports.PHASE_ORDER = ['requirements', 'design', 'tasks'];
const DEFAULT_PHASE_STATE = {
    requirements: 'not_started',
    design: 'not_started',
    tasks: 'not_started',
    updatedAt: new Date(0).toISOString()
};
class SpecManager {
    workspaceRoot;
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }
    // ─── Directory accessors ────────────────────────────────────────────
    /** `<workspace>/.nexus` */
    nexusDir() {
        return vscode.Uri.joinPath(this.workspaceRoot, '.nexus');
    }
    /** `<workspace>/.nexus/specs` */
    specsDir() {
        return vscode.Uri.joinPath(this.nexusDir(), 'specs');
    }
    /** `<workspace>/.nexus/steering` */
    steeringDir() {
        return vscode.Uri.joinPath(this.nexusDir(), 'steering');
    }
    /** `<workspace>/.nexus/skills` */
    skillsDir() {
        return vscode.Uri.joinPath(this.nexusDir(), 'skills');
    }
    /** `<workspace>/.nexus/hooks` */
    hooksDir() {
        return vscode.Uri.joinPath(this.nexusDir(), 'hooks');
    }
    /** `<workspace>/.nexus/cache` (V2.1.2 spec-fix-7). Persistent storage for
     *  derived state that's expensive to recompute — currently the
     *  traceability matrix (5+ LLM calls per refresh) but additional
     *  caches may slot in here over time. Auto-created on first write.
     *  Recommended to gitignore: derived state, not source-of-truth. */
    cacheDir() {
        return vscode.Uri.joinPath(this.nexusDir(), 'cache');
    }
    /** `<workspace>/.nexus/specs/<slug>` (creates it on disk). */
    async featureDir(featureSlug = exports.DEFAULT_FEATURE) {
        const slug = this.slugify(featureSlug);
        const dir = vscode.Uri.joinPath(this.specsDir(), slug);
        await vscode.workspace.fs.createDirectory(dir);
        return dir;
    }
    // ─── File accessors (per feature) ───────────────────────────────────
    requirementsUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'requirements.md');
    }
    designUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'design.md');
    }
    tasksMdUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'tasks.md');
    }
    tasksJsonUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'tasks.json');
    }
    failuresUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), 'failures.md');
    }
    /** `<workspace>/.nexus/specs/<slug>/.phase-state.json` */
    phaseStateUri(featureSlug = exports.DEFAULT_FEATURE) {
        return vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug), '.phase-state.json');
    }
    // ─── Steering files ─────────────────────────────────────────────────
    productUri() { return vscode.Uri.joinPath(this.steeringDir(), 'product.md'); }
    structureUri() { return vscode.Uri.joinPath(this.steeringDir(), 'structure.md'); }
    techUri() { return vscode.Uri.joinPath(this.steeringDir(), 'tech.md'); }
    // ─── High-level reads ───────────────────────────────────────────────
    /** Reads requirements.md, returns "" if missing. */
    async readRequirements(featureSlug = exports.DEFAULT_FEATURE) {
        return this.readSafe(this.requirementsUri(featureSlug));
    }
    /** Reads design.md, returns "" if missing. */
    async readDesign(featureSlug = exports.DEFAULT_FEATURE) {
        return this.readSafe(this.designUri(featureSlug));
    }
    /** Reads tasks.md, returns "" if missing. */
    async readTasksMd(featureSlug = exports.DEFAULT_FEATURE) {
        return this.readSafe(this.tasksMdUri(featureSlug));
    }
    /** Reads tasks.json, returns null if missing or unparseable. */
    async readTasksJson(featureSlug = exports.DEFAULT_FEATURE) {
        const text = await this.readSafe(this.tasksJsonUri(featureSlug));
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    /** Reads failures.md (verifier rejection log), returns "" if missing. */
    async readFailures(featureSlug = exports.DEFAULT_FEATURE) {
        return this.readSafe(this.failuresUri(featureSlug));
    }
    /** Reads all three steering files and concatenates them. */
    async readSteering() {
        const [product, structure, tech] = await Promise.all([
            this.readSafe(this.productUri()),
            this.readSafe(this.structureUri()),
            this.readSafe(this.techUri())
        ]);
        const sections = [];
        if (product) {
            sections.push(`### Product\n${product}`);
        }
        if (structure) {
            sections.push(`### Structure\n${structure}`);
        }
        if (tech) {
            sections.push(`### Tech\n${tech}`);
        }
        return {
            product, structure, tech,
            combined: sections.join('\n\n')
        };
    }
    // ─── High-level writes ──────────────────────────────────────────────
    async writeRequirements(content, featureSlug = exports.DEFAULT_FEATURE) {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.requirementsUri(featureSlug), Buffer.from(content, 'utf8'));
        // A fresh draft always invalidates downstream approvals
        await this.resetFromPhase('requirements', featureSlug);
        await this.setPhaseStatus('requirements', 'draft', featureSlug);
        void (0, container_1.getDeps)().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'requirements',
            description: `Requirements draft updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }
    async writeDesign(content, featureSlug = exports.DEFAULT_FEATURE) {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.designUri(featureSlug), Buffer.from(content, 'utf8'));
        await this.resetFromPhase('design', featureSlug);
        await this.setPhaseStatus('design', 'draft', featureSlug);
        void (0, container_1.getDeps)().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'design',
            description: `Design draft updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }
    async writeTasksMd(content, featureSlug = exports.DEFAULT_FEATURE) {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.tasksMdUri(featureSlug), Buffer.from(content, 'utf8'));
        void (0, container_1.getDeps)().audit.logSpecEdit({
            spec: featureSlug,
            phase: 'tasks',
            description: `Tasks markdown updated (${Buffer.byteLength(content, 'utf8')} bytes)`
        });
    }
    async writeTasksJson(plan, featureSlug = exports.DEFAULT_FEATURE) {
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.tasksJsonUri(featureSlug), Buffer.from(JSON.stringify(plan, null, 2), 'utf8'));
        // tasks.json is the canonical artifact — both writes (md + json) happen
        // close together, but the json write is the one that signals "draft ready"
        await this.setPhaseStatus('tasks', 'draft', featureSlug);
    }
    /** Marks a task line in tasks.md as completed by flipping `[ ]` to `[x]`. */
    async markTaskCompleted(taskDescription, featureSlug = exports.DEFAULT_FEATURE) {
        const uri = this.tasksMdUri(featureSlug);
        try {
            let md = await this.readSafe(uri);
            if (!md) {
                return;
            }
            md = md.replace(`[ ] **${taskDescription}**`, `[x] **${taskDescription}**`);
            md = md.replace(`[ ] ${taskDescription}`, `[x] ${taskDescription}`);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
        }
        catch {
            // Non-fatal — UI keeps state of its own
        }
    }
    /** Writes the steering structure file (used by the legacy ".nexusrules" save flow). */
    async writeStructureRules(content) {
        await vscode.workspace.fs.createDirectory(this.steeringDir());
        await vscode.workspace.fs.writeFile(this.structureUri(), Buffer.from(content, 'utf8'));
    }
    // ─── Phase state ────────────────────────────────────────────────────
    /**
     * Reads the phase-state sidecar. Returns `DEFAULT_PHASE_STATE` if the
     * file is missing or malformed — equivalent to "fresh project."
     */
    async readPhaseState(featureSlug = exports.DEFAULT_FEATURE) {
        const text = await this.readSafe(this.phaseStateUri(featureSlug));
        if (!text) {
            return { ...DEFAULT_PHASE_STATE };
        }
        try {
            const parsed = JSON.parse(text);
            // Defend against partial / hand-edited files
            return {
                requirements: this.coerceStatus(parsed.requirements),
                design: this.coerceStatus(parsed.design),
                tasks: this.coerceStatus(parsed.tasks),
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
            };
        }
        catch {
            return { ...DEFAULT_PHASE_STATE };
        }
    }
    /**
     * Sets the status of a single phase. Approving a downstream phase
     * does NOT auto-approve upstream phases (and vice versa). Cascade
     * logic lives in `requirePhaseApproved` and the SidebarProvider.
     */
    async setPhaseStatus(phase, status, featureSlug = exports.DEFAULT_FEATURE) {
        await this.featureDir(featureSlug);
        const current = await this.readPhaseState(featureSlug);
        const next = {
            ...current,
            [phase]: status,
            updatedAt: new Date().toISOString()
        };
        await vscode.workspace.fs.writeFile(this.phaseStateUri(featureSlug), Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
        return next;
    }
    /**
     * Throws if the phases that must be approved before `phase` is allowed
     * to run aren't approved. Used as a guard in the SidebarProvider before
     * each `generate*` handler runs.
     *
     * Example: requirePhaseApproved('design') throws unless requirements is approved.
     */
    async requirePhaseApproved(phase, featureSlug = exports.DEFAULT_FEATURE) {
        const idx = exports.PHASE_ORDER.indexOf(phase);
        if (idx <= 0)
            return; // 'requirements' has no upstream
        const state = await this.readPhaseState(featureSlug);
        for (let i = 0; i < idx; i++) {
            const upstream = exports.PHASE_ORDER[i];
            if (upstream === undefined)
                continue; // bounded by idx; defensive
            if (state[upstream] !== 'approved') {
                throw new Error(`Phase '${phase}' is locked: upstream phase '${upstream}' is '${state[upstream]}', must be 'approved'.`);
            }
        }
    }
    /**
     * Resets a phase and all downstream phases to 'not_started'. Used when
     * the user rejects a generated draft — we don't want a stale
     * approved=design lingering after the requirements get regenerated.
     */
    async resetFromPhase(phase, featureSlug = exports.DEFAULT_FEATURE) {
        const current = await this.readPhaseState(featureSlug);
        const idx = exports.PHASE_ORDER.indexOf(phase);
        const next = { ...current };
        for (let i = idx; i < exports.PHASE_ORDER.length; i++) {
            const phaseName = exports.PHASE_ORDER[i];
            if (phaseName === undefined)
                continue; // bounded by length; defensive
            next[phaseName] = 'not_started';
        }
        next.updatedAt = new Date().toISOString();
        await this.featureDir(featureSlug);
        await vscode.workspace.fs.writeFile(this.phaseStateUri(featureSlug), Buffer.from(JSON.stringify(next, null, 2), 'utf8'));
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
    slugifyName(s) {
        return this.slugify(s);
    }
    /**
     * Check whether a feature slug already exists on disk. Used to
     * detect duplicate names before we try to create a new feature
     * (which would silently merge into the existing one).
     */
    async featureExists(featureSlug) {
        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.specsDir(), this.slugify(featureSlug)));
            return stat.type === vscode.FileType.Directory;
        }
        catch {
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
    async listFeatures() {
        let entries;
        try {
            entries = await vscode.workspace.fs.readDirectory(this.specsDir());
        }
        catch {
            // specs/ doesn't exist yet — no features.
            return [];
        }
        const dirs = entries
            .filter(([_name, type]) => type === vscode.FileType.Directory)
            .map(([name]) => name);
        // Sort: 'main' first, then alphabetical
        dirs.sort((a, b) => {
            if (a === exports.DEFAULT_FEATURE) {
                return -1;
            }
            if (b === exports.DEFAULT_FEATURE) {
                return 1;
            }
            return a.localeCompare(b);
        });
        const out = [];
        for (const slug of dirs) {
            const phaseState = await this.readPhaseState(slug);
            out.push({ slug, phaseState });
        }
        return out;
    }
    // ─── Internal helpers ───────────────────────────────────────────────
    coerceStatus(s) {
        return s === 'approved' || s === 'draft' || s === 'not_started' ? s : 'not_started';
    }
    async readSafe(uri) {
        try {
            const buf = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(buf);
        }
        catch {
            return '';
        }
    }
    slugify(s) {
        return s.toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-') // V2.1.2 spec-fix-4: collapse multiple dashes
            .replace(/^-+|-+$/g, '') // V2.1.2 spec-fix-4: strip ALL leading/trailing
            || exports.DEFAULT_FEATURE;
    }
}
exports.SpecManager = SpecManager;
//# sourceMappingURL=SpecManager.js.map