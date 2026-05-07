// src/test/unit/scaffoldApplier.test.ts
//
// Tests for the V2.1.2a scaffold applier. Uses an in-memory ScaffoldFs
// implementation rather than tmpdir — pure-function logic deserves
// pure-function tests. The nodeFsAdapter wrapper is tested separately
// in nodeFsAdapter.test.ts.
//
// Coverage:
//   - planConflicts classification: safe / identical / empty / blocking
//   - applyTemplate refuses on blocking unless force=true
//   - applyTemplate skips identical files (idempotent re-runs)
//   - applyTemplate creates parent dirs as needed
//   - Path-traversal guard (template with ../ paths gets refused)
//   - Race-condition handling (template file disappears between plan/apply)
//   - Empty template (files/ doesn't exist) returns no-op plan

import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import {
    planConflicts,
    applyTemplate,
    type ScaffoldFs,
    type ConflictPlanEntry,
} from '../../scaffold/scaffoldApplier';
import type { TemplateMetadata } from '../../scaffold/templateLoader';

/**
 * In-memory ScaffoldFs for tests. All "files" are stored in a Map
 * keyed by absolute path. Directories are implicit — anything
 * registered as a parent of a file is treated as a directory.
 */
class FakeFs implements ScaffoldFs {
    files = new Map<string, string>();
    /** Explicitly-registered directories (for templates with empty
     *  files/ dirs we want to test). */
    explicitDirs = new Set<string>();

    readFile(absPath: string): string | null {
        return this.files.has(absPath) ? this.files.get(absPath)! : null;
    }
    writeFile(absPath: string, content: string): void {
        this.files.set(absPath, content);
    }
    isDirectory(absPath: string): boolean {
        if (this.explicitDirs.has(absPath)) { return true; }
        const prefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
        for (const f of this.files.keys()) {
            if (f.startsWith(prefix)) { return true; }
        }
        return false;
    }
    listFilesRecursive(absPath: string): string[] {
        const prefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
        const results: string[] = [];
        for (const f of this.files.keys()) {
            if (f.startsWith(prefix)) {
                results.push(f.substring(prefix.length).replace(/\\/g, '/'));
            }
        }
        return results.sort();
    }
}

/**
 * Helper to register a template into the fake FS at a known root,
 * with a given set of files.
 */
function makeTemplate(
    fs: FakeFs,
    rootPath: string,
    files: Record<string, string>
): TemplateMetadata {
    const filesRoot = path.join(rootPath, 'files');
    fs.explicitDirs.add(rootPath);
    fs.explicitDirs.add(filesRoot);
    for (const [rel, content] of Object.entries(files)) {
        fs.writeFile(path.join(filesRoot, rel), content);
    }
    // template.json existence isn't required by the applier (it's a
    // loader concern), but include it for realism.
    fs.writeFile(
        path.join(rootPath, 'template.json'),
        JSON.stringify({ id: 'test', displayName: 'Test' })
    );
    return {
        id: 'test',
        displayName: 'Test',
        description: '',
        stackTags: [],
        source: 'builtin',
        rootPath,
    };
}

describe('planConflicts — classification', () => {
    it('classifies all files as safe in an empty workspace', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
            'src/index.ts': 'console.log("hi");\n',
        });
        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.counts).toEqual({ safe: 2, identical: 0, empty: 0, blocking: 0 });
        expect(plan.hasBlockingConflicts).toBe(false);
        expect(plan.entries.map(e => e.relativePath).sort()).toEqual([
            'package.json',
            'src/index.ts',
        ]);
    });

    it('classifies byte-identical existing files as identical', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
        });
        // Workspace already has the same file, byte-identical.
        fs.writeFile('/ws/package.json', '{"name":"x"}');

        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.counts).toEqual({ safe: 0, identical: 1, empty: 0, blocking: 0 });
        expect(plan.hasBlockingConflicts).toBe(false);
    });

    it('classifies empty existing files as empty (overwritable)', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            '.gitignore': 'node_modules\n',
        });
        // Common case: `git init` created an empty .gitignore.
        fs.writeFile('/ws/.gitignore', '');

        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.counts).toEqual({ safe: 0, identical: 0, empty: 1, blocking: 0 });
        expect(plan.hasBlockingConflicts).toBe(false);
    });

    it('classifies different content as blocking', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"new"}',
        });
        fs.writeFile('/ws/package.json', '{"name":"existing","version":"1.0.0"}');

        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.counts).toEqual({ safe: 0, identical: 0, empty: 0, blocking: 1 });
        expect(plan.hasBlockingConflicts).toBe(true);
    });

    it('handles mixed conflict types in a single template', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
            '.gitignore': 'node_modules\n',
            'src/index.ts': 'console.log("hi");\n',
            'README.md': '# Project\n',
        });
        fs.writeFile('/ws/package.json', '{"name":"x"}');     // identical
        fs.writeFile('/ws/.gitignore', '');                   // empty (overwritable)
        fs.writeFile('/ws/README.md', '# My existing readme\n'); // blocking
        // src/index.ts doesn't exist → safe

        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.counts).toEqual({ safe: 1, identical: 1, empty: 1, blocking: 1 });
        expect(plan.hasBlockingConflicts).toBe(true);
    });

    it('returns empty plan when template has no files/ dir', () => {
        const fs = new FakeFs();
        const tpl: TemplateMetadata = {
            id: 'empty',
            displayName: 'Empty',
            description: '',
            stackTags: [],
            source: 'builtin',
            rootPath: '/ext/scaffolds/empty',
        };
        // Don't register the files/ dir.

        const plan = planConflicts(tpl, '/ws', fs);
        expect(plan.entries).toEqual([]);
        expect(plan.hasBlockingConflicts).toBe(false);
    });
});

describe('applyTemplate — write behavior', () => {
    it('writes all safe files to the workspace', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
            'src/index.ts': 'console.log("hi");\n',
        });

        const result = applyTemplate(tpl, '/ws', fs);
        expect(result.written.sort()).toEqual(['package.json', 'src/index.ts']);
        expect(result.skipped).toEqual([]);
        expect(result.forced).toEqual([]);

        expect(fs.readFile('/ws/package.json')).toBe('{"name":"x"}');
        expect(fs.readFile('/ws/src/index.ts')).toBe('console.log("hi");\n');
    });

    it('skips identical files (idempotent re-apply)', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
        });
        fs.writeFile('/ws/package.json', '{"name":"x"}');

        const result = applyTemplate(tpl, '/ws', fs);
        expect(result.written).toEqual([]);
        expect(result.skipped).toEqual(['package.json']);
    });

    it('overwrites empty existing files', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            '.gitignore': 'node_modules\n',
        });
        fs.writeFile('/ws/.gitignore', '');

        const result = applyTemplate(tpl, '/ws', fs);
        expect(result.written).toEqual(['.gitignore']);
        expect(fs.readFile('/ws/.gitignore')).toBe('node_modules\n');
    });

    it('refuses on blocking conflict by default', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"new"}',
        });
        fs.writeFile('/ws/package.json', '{"name":"existing"}');

        expect(() => applyTemplate(tpl, '/ws', fs)).toThrow(/refused/i);
        // Workspace untouched.
        expect(fs.readFile('/ws/package.json')).toBe('{"name":"existing"}');
    });

    it('lists blocking files (truncated) in the error message', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'a': '1', 'b': '2', 'c': '3', 'd': '4', 'e': '5', 'f': '6', 'g': '7',
        });
        for (const f of ['a','b','c','d','e','f','g']) {
            fs.writeFile(`/ws/${f}`, 'existing');
        }

        try {
            applyTemplate(tpl, '/ws', fs);
            throw new Error('should have thrown');
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toMatch(/7 file/);
            // Truncated to 5 + count
            expect(msg).toMatch(/\+2 more/);
        }
    });

    it('force=true overwrites blocking files and records them', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"new"}',
            'README.md': '# new\n',
        });
        fs.writeFile('/ws/package.json', '{"name":"existing"}');
        // README doesn't exist → safe

        const result = applyTemplate(tpl, '/ws', fs, { force: true });
        expect(result.written).toEqual(['README.md']);
        expect(result.forced).toEqual(['package.json']);
        expect(fs.readFile('/ws/package.json')).toBe('{"name":"new"}');
        expect(fs.readFile('/ws/README.md')).toBe('# new\n');
    });

    it('refuses path-traversal templates (defense in depth)', () => {
        // Simulating a malformed template that put files outside files/.
        // This shouldn't happen via normal template authoring (path.join
        // with relative paths from listFilesRecursive can't escape) but
        // we guard against it anyway. We force a bad path by injecting
        // a file with a literal `..` segment at write time.
        const fs = new FakeFs();
        const tpl: TemplateMetadata = {
            id: 'evil',
            displayName: 'Evil',
            description: '',
            stackTags: [],
            source: 'builtin',
            rootPath: '/ext/scaffolds/evil',
        };
        fs.explicitDirs.add('/ext/scaffolds/evil');
        fs.explicitDirs.add('/ext/scaffolds/evil/files');
        // Inject a "file" whose name escapes via ../
        fs.writeFile('/ext/scaffolds/evil/files/../../etc/passwd', 'pwned');

        expect(() => applyTemplate(tpl, '/ws', fs)).toThrow(/escapes workspace root/i);
    });
});

describe('applyTemplate — race conditions', () => {
    it('throws clearly when template file disappears between plan and apply', () => {
        // Simulate a file vanishing after planConflicts but before
        // applyTemplate completes its writes. We do this by serving
        // the source file content during plan and returning null
        // during apply — the toggle flips after planConflicts has
        // walked the template.
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'package.json': '{"name":"x"}',
        });
        // Pre-populate the dest with DIFFERENT content so plan reads
        // the source (to compare) — this is when the first read
        // happens. After plan returns, we flip to "file deleted"
        // before apply reads it again.
        fs.writeFile('/ws/package.json', '{"name":"existing"}');

        let planComplete = false;
        const flakyFs: ScaffoldFs = {
            readFile(p: string) {
                if (p === '/ext/scaffolds/test/files/package.json' && planComplete) {
                    return null; // vanished
                }
                return fs.readFile(p);
            },
            writeFile: fs.writeFile.bind(fs),
            isDirectory: fs.isDirectory.bind(fs),
            listFilesRecursive: fs.listFilesRecursive.bind(fs),
        };

        // First do a plan-only pass to confirm the conflict exists,
        // then flip the flag and run apply with force=true (so the
        // blocking-conflict refuse doesn't fire first).
        const plan = planConflicts(tpl, '/ws', flakyFs);
        expect(plan.hasBlockingConflicts).toBe(true);

        planComplete = true;
        expect(() => applyTemplate(tpl, '/ws', flakyFs, { force: true }))
            .toThrow(/missing at apply-time/i);
    });
});

describe('ConflictPlanEntry — shape sanity', () => {
    it('returns absolute paths for both source and dest', () => {
        const fs = new FakeFs();
        const tpl = makeTemplate(fs, '/ext/scaffolds/test', {
            'src/foo.ts': 'x\n',
        });
        const plan = planConflicts(tpl, '/ws', fs);
        const entry = plan.entries[0] as ConflictPlanEntry;
        expect(entry.absoluteDestPath).toBe(path.join('/ws', 'src/foo.ts'));
        expect(entry.absoluteSourcePath).toBe(
            path.join('/ext/scaffolds/test/files', 'src/foo.ts')
        );
    });
});