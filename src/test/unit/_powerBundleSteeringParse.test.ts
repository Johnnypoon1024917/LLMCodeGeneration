// src/test/unit/_powerBundleSteeringParse.test.ts
//
// Smoke test for steering files in examples/powers/<bundle>/.nexus/steering/.
// Ensures:
//   1. Every steering file normalises to non-empty content (i.e. it
//      isn't just template comments / headers — would be silently
//      dropped at injection time)
//   2. Any declared `## Applies to` or `## Exclude paths` section
//      parses successfully (zero or more bullets — both fine)
//
// Catches authoring drift: if someone adds a bundle and forgets to
// fill in real content, this test fails before users see it.

import * as fs from 'fs';
import * as path from 'path';
import {
    normalizeSteeringContent,
    extractApplyToScopesFromContent,
    extractExcludePatternsFromContent
} from '../../specs/SteeringManager';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const POWERS_DIR = path.join(REPO_ROOT, 'examples', 'powers');

interface SteeringFile {
    bundle: string;
    file: string;
    fullPath: string;
}

function findBundleSteering(): SteeringFile[] {
    if (!fs.existsSync(POWERS_DIR)) { return []; }
    const out: SteeringFile[] = [];
    for (const bundle of fs.readdirSync(POWERS_DIR)) {
        const steeringDir = path.join(POWERS_DIR, bundle, '.nexus', 'steering');
        if (!fs.existsSync(steeringDir)) { continue; }
        for (const f of fs.readdirSync(steeringDir)) {
            if (f.endsWith('.md')) {
                out.push({ bundle, file: f, fullPath: path.join(steeringDir, f) });
            }
        }
    }
    return out;
}

describe('Power bundles — steering files normalise to non-empty content', () => {
    const files = findBundleSteering();

    if (files.length === 0) {
        it('no power bundles present (skipping)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    for (const sf of files) {
        const label = `${sf.bundle}/${sf.file}`;
        it(`${label} contributes content after normalization`, () => {
            const raw = fs.readFileSync(sf.fullPath, 'utf8');
            const normalized = normalizeSteeringContent(raw);
            // The Django product.md is intentionally a placeholder
            // BUT it has real prose under the > customize blockquote,
            // so it should still normalise to non-empty. If a future
            // bundle ships a stub product.md with only headers + HTML
            // comments, this assertion catches that regression.
            expect(normalized.length).toBeGreaterThan(0);
        });
    }
});

describe('Power bundles — scope and exclude sections parse', () => {
    const files = findBundleSteering();

    if (files.length === 0) {
        it('no power bundles present (skipping)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    for (const sf of files) {
        const label = `${sf.bundle}/${sf.file}`;
        it(`${label} — extractors run without error`, () => {
            const raw = fs.readFileSync(sf.fullPath, 'utf8');
            // Both should return arrays (possibly empty). The mere fact
            // that the call doesn't throw is the assertion — any throws
            // would indicate a malformed section that real users would
            // hit at runtime.
            const scopes = extractApplyToScopesFromContent(raw);
            const excludes = extractExcludePatternsFromContent(raw);
            expect(Array.isArray(scopes)).toBe(true);
            expect(Array.isArray(excludes)).toBe(true);
        });
    }
});

describe('Power bundles — banking-compliance-zh demonstrates scope filtering', () => {
    const techPath = path.join(POWERS_DIR, 'banking-compliance-zh', '.nexus', 'steering', 'tech.md');

    if (!fs.existsSync(techPath)) {
        it('banking-compliance-zh not present (skipping)', () => {
            expect(true).toBe(true);
        });
        return;
    }

    it('tech.md has at least one ## Applies to entry', () => {
        const raw = fs.readFileSync(techPath, 'utf8');
        const scopes = extractApplyToScopesFromContent(raw);
        // The whole point of this bundle is to demonstrate scope
        // filtering — if the tech.md ever loses its scope section,
        // the bundle has lost its instructional value.
        expect(scopes.length).toBeGreaterThan(0);
    });

    it('structure.md has ## Exclude paths entries', () => {
        const structurePath = path.join(POWERS_DIR, 'banking-compliance-zh', '.nexus', 'steering', 'structure.md');
        const raw = fs.readFileSync(structurePath, 'utf8');
        const excludes = extractExcludePatternsFromContent(raw);
        expect(excludes.length).toBeGreaterThan(0);
    });
});
