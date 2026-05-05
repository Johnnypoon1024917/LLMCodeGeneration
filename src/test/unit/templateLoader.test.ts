// src/test/unit/templateLoader.test.ts
//
// Tests for the V2.1.1 template loader. Touches the filesystem (uses
// os.tmpdir() like the existing fixtures.test.ts pattern) — this is
// fundamentally an FS-discovery module and pure-function-mocking it
// would be more code than just creating temp dirs.
//
// Coverage:
//   - Empty / missing scaffolds dirs return [] cleanly
//   - Built-in templates discovered from extension/scaffolds/
//   - Customer templates discovered from workspace/.nexus/scaffolds/
//   - Customer templates win over built-ins on id collision
//   - Malformed template.json silently skipped (no crash)
//   - Folders without template.json silently skipped
//   - Sort order: workspace before builtin, alphabetical within group

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverTemplates } from '../../scaffold/templateLoader';

/**
 * Helper: write a complete template (folder + template.json + files/).
 * Caller decides which root (workspace .nexus/scaffolds or extension/scaffolds).
 */
function makeTemplate(
    parentDir: string,
    id: string,
    metadata: Record<string, unknown>,
    files: Record<string, string> = {}
): void {
    const dir = path.join(parentDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(metadata));
    if (Object.keys(files).length > 0) {
        const filesDir = path.join(dir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        for (const [filename, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(filesDir, filename), content);
        }
    }
}

describe('discoverTemplates', () => {
    let tmpRoot: string;
    let workspaceRoot: string;
    let extensionRoot: string;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-scaffold-test-'));
        workspaceRoot = path.join(tmpRoot, 'workspace');
        extensionRoot = path.join(tmpRoot, 'extension');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        fs.mkdirSync(extensionRoot, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('returns [] when neither scaffolds dir exists', () => {
        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toEqual([]);
    });

    it('discovers built-in templates', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'node-ts-cli', {
            id: 'node-ts-cli',
            displayName: 'Node + TypeScript CLI',
            description: 'A TypeScript command-line tool',
            stackTags: ['node', 'typescript', 'cli'],
        });

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('node-ts-cli');
        expect(result[0]!.displayName).toBe('Node + TypeScript CLI');
        expect(result[0]!.source).toBe('builtin');
        expect(result[0]!.stackTags).toEqual(['node', 'typescript', 'cli']);
    });

    it('discovers workspace templates', () => {
        const workspaceScaffolds = path.join(workspaceRoot, '.nexus', 'scaffolds');
        fs.mkdirSync(workspaceScaffolds, { recursive: true });
        makeTemplate(workspaceScaffolds, 'banking-compliance-zh', {
            id: 'banking-compliance-zh',
            displayName: 'Banking Compliance (zh-CN)',
            description: 'HK financial-services compliance template',
            stackTags: ['compliance', 'banking', 'zh'],
        });

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('banking-compliance-zh');
        expect(result[0]!.source).toBe('workspace');
    });

    it('workspace templates override built-ins on id collision', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'node-ts-cli', {
            id: 'node-ts-cli',
            displayName: 'Built-in Node TS CLI',
            description: 'default',
            stackTags: [],
        });
        const workspaceScaffolds = path.join(workspaceRoot, '.nexus', 'scaffolds');
        fs.mkdirSync(workspaceScaffolds, { recursive: true });
        makeTemplate(workspaceScaffolds, 'node-ts-cli', {
            id: 'node-ts-cli',
            displayName: 'Customer Node TS CLI',
            description: 'with our compliance baseline',
            stackTags: [],
        });

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.displayName).toBe('Customer Node TS CLI');
        expect(result[0]!.source).toBe('workspace');
    });

    it('lists workspace templates before built-ins, alphabetical within group', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'b-builtin', { id: 'b-builtin', displayName: 'B' });
        makeTemplate(builtinDir, 'a-builtin', { id: 'a-builtin', displayName: 'A' });

        const workspaceScaffolds = path.join(workspaceRoot, '.nexus', 'scaffolds');
        fs.mkdirSync(workspaceScaffolds, { recursive: true });
        makeTemplate(workspaceScaffolds, 'z-customer', { id: 'z-customer', displayName: 'Z' });
        makeTemplate(workspaceScaffolds, 'm-customer', { id: 'm-customer', displayName: 'M' });

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result.map(t => t.id)).toEqual([
            'm-customer',  // workspace first, alphabetical
            'z-customer',
            'a-builtin',   // builtins after, alphabetical
            'b-builtin',
        ]);
    });

    it('silently skips folders without template.json', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        // Valid template
        makeTemplate(builtinDir, 'good', { id: 'good', displayName: 'Good' });
        // Folder without template.json (e.g. a draft someone abandoned)
        fs.mkdirSync(path.join(builtinDir, 'incomplete'));
        fs.writeFileSync(path.join(builtinDir, 'incomplete', 'README.md'), 'wip');

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('good');
    });

    it('silently skips templates with invalid JSON', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'good', { id: 'good', displayName: 'Good' });
        // Corrupted template
        const badDir = path.join(builtinDir, 'bad');
        fs.mkdirSync(badDir);
        fs.writeFileSync(path.join(badDir, 'template.json'), 'this is not json{{{');

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('good');
    });

    it('silently skips templates missing required id field', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'good', { id: 'good', displayName: 'Good' });
        // template.json without id
        const badDir = path.join(builtinDir, 'noid');
        fs.mkdirSync(badDir);
        fs.writeFileSync(path.join(badDir, 'template.json'),
            JSON.stringify({ displayName: 'no id field' }));

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.id).toBe('good');
    });

    it('handles undefined workspaceRoot (no workspace open)', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'node-ts-cli', { id: 'node-ts-cli', displayName: 'Node TS CLI' });

        const result = discoverTemplates(undefined, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.source).toBe('builtin');
    });

    it('uses optional fields with sensible defaults', () => {
        const builtinDir = path.join(extensionRoot, 'scaffolds');
        fs.mkdirSync(builtinDir);
        makeTemplate(builtinDir, 'minimal', { id: 'minimal' });
        // No displayName, description, or stackTags

        const result = discoverTemplates(workspaceRoot, extensionRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.displayName).toBe('minimal'); // falls back to id
        expect(result[0]!.description).toBe('');
        expect(result[0]!.stackTags).toEqual([]);
    });
});