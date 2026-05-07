"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseHookFile = parseHookFile;
exports.interpolatePrompt = interpolatePrompt;
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
function parseHookFile(content, sourceUri, fallbackId) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    const frontmatterRaw = match[1];
    const body = match[2];
    if (frontmatterRaw === undefined || body === undefined) {
        return null;
    }
    const fm = parseSimpleYaml(frontmatterRaw);
    if (!fm) {
        return null;
    }
    const trigger = parseTrigger(fm['trigger']);
    if (!trigger) {
        return null;
    }
    const description = typeof fm['description'] === 'string' ? fm['description'] : undefined;
    return {
        id: typeof fm['name'] === 'string' && fm['name'] ? slugify(fm['name']) : fallbackId,
        name: typeof fm['name'] === 'string' ? fm['name'] : fallbackId,
        ...(description !== undefined ? { description } : {}),
        enabled: fm['enabled'] !== false, // default true
        trigger,
        promptTemplate: body.trim(),
        sourceUri
    };
}
/** Substitutes {{var}} placeholders in the template with HookContext values. */
function interpolatePrompt(template, ctx) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        const v = ctx[k];
        return v === undefined || v === null ? `{{${k}}}` : String(v);
    });
}
// ─── Internal: minimal YAML subset ──────────────────────────────────────
function parseSimpleYaml(text) {
    const result = {};
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line === undefined) {
            i++;
            continue;
        } // bounded by length; defensive
        if (!line.trim() || line.trim().startsWith('#')) {
            i++;
            continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent !== 0) {
            i++;
            continue;
        } // top-level only
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
            return null;
        }
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (value === '') {
            // Nested object — collect indented child lines
            const child = {};
            i++;
            while (i < lines.length) {
                const childLine = lines[i];
                if (childLine === undefined) {
                    i++;
                    continue;
                } // bounded by length; defensive
                if (!childLine.trim()) {
                    i++;
                    continue;
                }
                const childIndent = childLine.length - childLine.trimStart().length;
                if (childIndent === 0) {
                    break;
                }
                const childColon = childLine.indexOf(':');
                if (childColon === -1) {
                    i++;
                    continue;
                }
                const ck = childLine.substring(0, childColon).trim();
                const cv = childLine.substring(childColon + 1).trim();
                child[ck] = coerceScalar(cv);
                i++;
            }
            result[key] = child;
        }
        else {
            result[key] = coerceScalar(value);
            i++;
        }
    }
    return result;
}
function coerceScalar(raw) {
    // Strip surrounding quotes
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
    }
    if (raw === 'true') {
        return true;
    }
    if (raw === 'false') {
        return false;
    }
    if (/^-?\d+$/.test(raw)) {
        return parseInt(raw, 10);
    }
    return raw;
}
function parseTrigger(t) {
    if (!t || typeof t !== 'object') {
        return null;
    }
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
function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '') || 'hook';
}
//# sourceMappingURL=HookSchema.js.map