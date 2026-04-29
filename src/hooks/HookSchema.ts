// src/hooks/HookSchema.ts
//
// Type definitions and YAML frontmatter parser for agent hooks.
//
// A hook is a Markdown file at .nexus/hooks/<name>.md with YAML frontmatter:
//
//   ---
//   name: lint-on-save
//   description: Run linter agent when a TypeScript file is saved
//   trigger:
//     type: onFileSave
//     pattern: "**/*.ts"
//   enabled: true
//   ---
//
//   You are a strict linter agent. The user just saved {{filePath}}.
//   Read the file and output a JSON array of issues...
//
// The body of the markdown file (after the closing `---`) is the prompt
// template fed to the LLM. Template variables {{var}} are substituted
// with HookContext values at trigger time.

export type HookTriggerType = 'onFileSave' | 'onCommand' | 'onSchedule';

export interface OnFileSaveTrigger {
    type: 'onFileSave';
    /** Glob pattern matched against vscode.workspace.asRelativePath() */
    pattern: string;
}

export interface OnCommandTrigger {
    type: 'onCommand';
    /**
     * Command suffix — registered as `nexuscode.hook.<commandId>` so users
     * can run from palette / keybindings.
     */
    commandId: string;
}

export interface OnScheduleTrigger {
    type: 'onSchedule';
    /**
     * Interval in seconds. Minimum 60 (1 min) to avoid runaway agents.
     * Daily ≈ 86400, hourly = 3600.
     */
    everySeconds: number;
}

export type HookTrigger = OnFileSaveTrigger | OnCommandTrigger | OnScheduleTrigger;

export interface HookDefinition {
    /** Slug derived from filename (e.g. "lint-on-save.md" → "lint-on-save"). */
    id: string;
    /** Human-readable label, defaults to id if not specified in frontmatter. */
    name: string;
    /** Optional description shown in the command palette / sidebar. */
    description?: string;
    /** Default `true`. Set to `false` to disable a hook without deleting it. */
    enabled: boolean;
    /** What event fires this hook. */
    trigger: HookTrigger;
    /** The prompt template, interpolated with HookContext at fire time. */
    promptTemplate: string;
    /** Absolute filesystem path of the .md file (for re-reading on change). */
    sourceUri: string;
}

/** Runtime context passed into the prompt template at fire time. */
export interface HookContext {
    /** Workspace root, absolute. */
    workspaceRoot: string;
    /** Relative path of the file that triggered the hook (file events only). */
    filePath?: string;
    /** Raw file content at trigger time (file events only, capped). */
    fileContent?: string;
    /** ISO-8601 timestamp of the trigger. */
    triggeredAt: string;
    /** What kind of trigger fired. */
    triggerType: HookTriggerType;
}

/**
 * Parses a Markdown file with YAML frontmatter into a HookDefinition.
 * Returns null if the file is malformed or missing required fields.
 *
 * Hand-rolled rather than pulling in `js-yaml` because:
 *   1. The frontmatter we accept is a small fixed schema (name, trigger, etc.)
 *   2. Adding a YAML dep means a transitive dep audit for an enterprise build
 *   3. ~50 lines is cheaper than the dep ledger
 *
 * Restrictions of this parser (vs full YAML):
 *   - No multi-line strings, no anchors, no arrays in frontmatter
 *   - Trigger must be a nested object with simple key: value pairs
 *   - Strings can be quoted or unquoted
 *   - Booleans are the literals `true` and `false`
 *   - Numbers are unsigned integers
 */
export function parseHookFile(content: string, sourceUri: string, fallbackId: string): HookDefinition | null {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) return null;

    const frontmatterRaw = match[1];
    const body = match[2];
    if (frontmatterRaw === undefined || body === undefined) return null;
    const fm = parseSimpleYaml(frontmatterRaw);
    if (!fm) return null;

    const trigger = parseTrigger(fm['trigger']);
    if (!trigger) return null;

    const description = typeof fm['description'] === 'string' ? fm['description'] : undefined;
    return {
        id:              typeof fm['name'] === 'string' && fm['name'] ? slugify(fm['name']) : fallbackId,
        name:            typeof fm['name'] === 'string' ? fm['name'] : fallbackId,
        ...(description !== undefined ? { description } : {}),
        enabled:         fm['enabled'] !== false, // default true
        trigger,
        promptTemplate:  body.trim(),
        sourceUri
    };
}

/** Substitutes {{var}} placeholders in the template with HookContext values. */
export function interpolatePrompt(template: string, ctx: HookContext): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        const v = (ctx as any)[k];
        return v === undefined || v === null ? `{{${k}}}` : String(v);
    });
}

// ─── Internal: minimal YAML subset ──────────────────────────────────────

function parseSimpleYaml(text: string): Record<string, any> | null {
    const result: Record<string, any> = {};
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (line === undefined) { i++; continue; } // bounded by length; defensive
        if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

        const indent = line.length - line.trimStart().length;
        if (indent !== 0) { i++; continue; } // top-level only

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return null;

        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();

        if (value === '') {
            // Nested object — collect indented child lines
            const child: Record<string, any> = {};
            i++;
            while (i < lines.length) {
                const childLine = lines[i];
                if (childLine === undefined) { i++; continue; } // bounded by length; defensive
                if (!childLine.trim()) { i++; continue; }
                const childIndent = childLine.length - childLine.trimStart().length;
                if (childIndent === 0) break;

                const childColon = childLine.indexOf(':');
                if (childColon === -1) { i++; continue; }
                const ck = childLine.substring(0, childColon).trim();
                const cv = childLine.substring(childColon + 1).trim();
                child[ck] = coerceScalar(cv);
                i++;
            }
            result[key] = child;
        } else {
            result[key] = coerceScalar(value);
            i++;
        }
    }

    return result;
}

function coerceScalar(raw: string): any {
    // Strip surrounding quotes
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    if (raw === 'true')  return true;
    if (raw === 'false') return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
}

function parseTrigger(t: any): HookTrigger | null {
    if (!t || typeof t !== 'object') return null;
    if (t.type === 'onFileSave' && typeof t.pattern === 'string') {
        return { type: 'onFileSave', pattern: t.pattern };
    }
    if (t.type === 'onCommand' && typeof t.commandId === 'string') {
        return { type: 'onCommand', commandId: t.commandId };
    }
    if (t.type === 'onSchedule' && typeof t.everySeconds === 'number' && t.everySeconds >= 60) {
        return { type: 'onSchedule', everySeconds: t.everySeconds };
    }
    return null;
}

function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '') || 'hook';
}