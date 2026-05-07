// Quick sanity check — confirms all 5 V2.1.2 built-in templates are
// discoverable from the actual scaffolds/ directory on disk. Runs
// the production discoverTemplates logic against the real disk
// rather than fixtures, catching things like:
//   - Missing template.json (typo)
//   - Malformed JSON (trailing comma, etc.)
//   - Missing required `id` field
// Faster to catch here than at runtime in the IDE.

import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import { discoverTemplates } from '../../scaffold/templateLoader';

describe('V2.1.2 built-in templates — disk sanity', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');

    it('discovers all 5 expected templates from scaffolds/', () => {
        const templates = discoverTemplates(undefined, repoRoot);
        const ids = templates.map(t => t.id).sort();
        expect(ids).toEqual([
            'node-ts-api',
            'node-ts-cli',
            'python-cli',
            'python-fastapi',
            'react-vite',
        ]);
        // Every template must be source='builtin' (no workspace overrides
        // in this test) and have a non-empty displayName.
        for (const t of templates) {
            expect(t.source).toBe('builtin');
            expect(t.displayName.length).toBeGreaterThan(0);
            expect(t.stackTags.length).toBeGreaterThan(0);
        }
    });
});