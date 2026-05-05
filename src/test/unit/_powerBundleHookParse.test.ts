// src/test/unit/_powerBundleHookParse.test.ts
//
// Smoke test: verifies that the hook .md files in examples/powers/
// actually parse against parseHookFile's schema. Catches authoring
// errors at PR time rather than at user-install time.
//
// Underscore prefix denotes "scaffold / smoke-test" — same convention
// as webview-ui/src/test/unit/_smoke.test.ts.

import * as fs from 'fs';
import * as path from 'path';
import { parseHookFile } from '../../hooks/HookSchema';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const POWERS_DIR = path.join(REPO_ROOT, 'examples', 'powers');

/** Recursively find .md files under a powers/<bundle>/.nexus/hooks/ tree. */
function findBundleHooks(): string[] {
    if (!fs.existsSync(POWERS_DIR)) { return []; }
    const out: string[] = [];
    for (const bundle of fs.readdirSync(POWERS_DIR)) {
        const hooksDir = path.join(POWERS_DIR, bundle, '.nexus', 'hooks');
        if (!fs.existsSync(hooksDir)) { continue; }
        for (const f of fs.readdirSync(hooksDir)) {
            if (f.endsWith('.md')) { out.push(path.join(hooksDir, f)); }
        }
    }
    return out;
}

describe('Power bundles — hook .md files parse', () => {
    const hooks = findBundleHooks();

    if (hooks.length === 0) {
        // Bundle dir doesn't exist yet — the test passes trivially so
        // CI doesn't fail on a fresh checkout that hasn't pulled the
        // power examples. When a bundle IS present, every hook in it
        // gets exercised.
        it('no power bundles present (skipping)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    for (const hookPath of hooks) {
        const relPath = path.relative(REPO_ROOT, hookPath);
        it(`parses ${relPath}`, () => {
            const content = fs.readFileSync(hookPath, 'utf8');
            const fallbackId = path.basename(hookPath, '.md');
            const parsed = parseHookFile(content, hookPath, fallbackId);
            expect(parsed).not.toBeNull();
            if (parsed) {
                // id is derived from the `name:` field via slugify, not
                // the filename. Just verify it's non-empty.
                expect(parsed.id.length).toBeGreaterThan(0);
                expect(parsed.name.length).toBeGreaterThan(0);
                expect(parsed.promptTemplate.trim().length).toBeGreaterThan(0);
                expect(['onFileSave', 'onCommand', 'onSchedule']).toContain(parsed.trigger.type);
            }
        });
    }
});
