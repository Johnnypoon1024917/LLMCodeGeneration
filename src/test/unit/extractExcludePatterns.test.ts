
// src/test/unit/extractExcludePatterns.test.ts
//
// PR P1.3: tests for SteeringManager.extractExcludePatternsFromContent.
//
// Covers the steering-side path-exclusion convention:
//
//     ## Exclude paths
//     - legacy/
//     - generated/
//
// Things this verifies:
//   - Header variants (Exclude / Excluded / Exclude paths) match
//   - Case-insensitive
//   - Multiple bullet styles (-, *, numbered)
//   - HTML comments inside or around bullets are dropped
//   - Section ends at next H1/H2 header
//   - Patterns are deduplicated
//   - Quote-wrapped patterns are stripped (`./foo` → ./foo)
//   - Empty bullets and whitespace-only patterns are dropped

import { extractExcludePatternsFromContent } from '../../specs/SteeringManager';

describe('extractExcludePatternsFromContent — header variants', () => {
    it('recognizes "## Exclude paths"', () => {
        const result = extractExcludePatternsFromContent(`
# Tech

## Exclude paths
- legacy/
- generated/
        `);
        expect(result).toEqual(['legacy/', 'generated/']);
    });

    it('recognizes "## Excluded paths"', () => {
        const result = extractExcludePatternsFromContent(`
## Excluded paths
- foo/
        `);
        expect(result).toEqual(['foo/']);
    });

    it('recognizes "## Exclude" (without "paths")', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude
- bar/
        `);
        expect(result).toEqual(['bar/']);
    });

    it('is case-insensitive', () => {
        const result = extractExcludePatternsFromContent(`
## EXCLUDE PATHS
- A/
## exclude
- B/
        `);
        // Both sections matched; first ends at the second header,
        // but the second header is itself an exclude header so it
        // continues the pattern collection.
        expect(result).toContain('A/');
        expect(result).toContain('B/');
    });

    it('returns empty array when no exclude header exists', () => {
        const result = extractExcludePatternsFromContent(`
# Product

## What we are building

A spec-driven coding assistant.

## Target users

Compliance officers.
        `);
        expect(result).toEqual([]);
    });

    it('returns empty array for empty input', () => {
        expect(extractExcludePatternsFromContent('')).toEqual([]);
    });
});

describe('extractExcludePatternsFromContent — bullet styles', () => {
    it('handles dash bullets', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- foo/
- bar/
        `);
        expect(result).toEqual(['foo/', 'bar/']);
    });

    it('handles asterisk bullets', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
* foo/
* bar/
        `);
        expect(result).toEqual(['foo/', 'bar/']);
    });

    it('handles numbered list', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
1. foo/
2. bar/
3. baz/
        `);
        expect(result).toEqual(['foo/', 'bar/', 'baz/']);
    });

    it('mixes bullet styles within one section', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- alpha/
* beta/
1. gamma/
        `);
        expect(result).toEqual(['alpha/', 'beta/', 'gamma/']);
    });
});

describe('extractExcludePatternsFromContent — section end detection', () => {
    it('stops at next H1 header', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- inside/

# New top section
- outside/
        `);
        expect(result).toEqual(['inside/']);
        expect(result).not.toContain('outside/');
    });

    it('stops at next H2 header', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- inside/

## Other section
- outside/
        `);
        expect(result).toEqual(['inside/']);
    });

    it('continues through deeper headers (H3+)', () => {
        // H3+ headers don't end the section — they're considered
        // sub-organization within the exclude list.
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- top/

### Subgroup
- still-included/
        `);
        // The current implementation ends at H1/H2 but H3 ('### ')
        // doesn't match — it's matched as a non-bullet line and
        // skipped, but section state stays open. So the next bullet
        // is collected.
        expect(result).toContain('top/');
        expect(result).toContain('still-included/');
    });
});

describe('extractExcludePatternsFromContent — content cleaning', () => {
    it('strips HTML comments from the file before parsing', () => {
        const result = extractExcludePatternsFromContent(`
<!--
## Exclude paths
- commented/
-->

## Exclude paths
- real/
        `);
        // The commented section is gone, so only 'real/' is collected.
        expect(result).toEqual(['real/']);
    });

    it('deduplicates patterns', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- foo/
- foo/
- bar/
        `);
        expect(result).toEqual(['foo/', 'bar/']);
    });

    it('strips backtick-wrapped patterns', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- \`./foo\`
- \`bar/\`
        `);
        expect(result).toEqual(['./foo', 'bar/']);
    });

    it('strips quote-wrapped patterns', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- "double quoted/"
- 'single quoted/'
        `);
        expect(result).toEqual(['double quoted/', 'single quoted/']);
    });

    it('drops empty and whitespace-only bullets', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- valid/
-${'    '}
- another/
        `);
        // The middle bullet has only whitespace — should be dropped.
        // (Note: the bullet regex requires SOMETHING after the dash;
        // a totally empty bullet like "- \n" doesn't match the
        // bulletRegex at all, so it never enters the patterns array.
        // The whitespace-only case might match-then-strip-to-empty,
        // which we drop on the empty check.)
        expect(result).toEqual(['valid/', 'another/']);
    });

    it('preserves multi-word patterns with internal spaces', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths
- src/test fixtures/
        `);
        expect(result).toEqual(['src/test fixtures/']);
    });
});

describe('extractExcludePatternsFromContent — realistic scenarios', () => {
    it('extracts from a typical tech.md steering file', () => {
        const tech = `
# Tech

## Stack

TypeScript on Node.js, React in webview.

## Exclude paths

The agent should not read these directories — they're generated
or legacy:

- node_modules/
- dist/
- legacy/
- generated/

## Conventions

Use Result<T,E> instead of throw.
        `;
        const result = extractExcludePatternsFromContent(tech);
        expect(result).toEqual([
            'node_modules/',
            'dist/',
            'legacy/',
            'generated/'
        ]);
    });

    it('returns empty when section is present but has no bullets', () => {
        const result = extractExcludePatternsFromContent(`
## Exclude paths

(none yet — add patterns here as the project grows)

## Other section
        `);
        expect(result).toEqual([]);
    });
});