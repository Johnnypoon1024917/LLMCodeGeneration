// src/test/unit/steeringScope.test.ts
//
// PR P2.2: tests for steering scope helpers.
//
// Two functions under test:
//   - extractApplyToScopesFromContent: parse "## Applies to" / "## Scope"
//     bullet lists from a steering file
//   - steeringScopeMatches: substring-based prefix match for filepath
//     against a scope pattern list
//
// Same convention as extractExcludePatterns from P1.3 — uses the
// shared extractBulletedSection helper underneath, so the section-
// parsing edge cases are already covered by extractExcludePatterns.test.ts.
// This file focuses on:
//   - The header variants ("Applies to" / "Scope")
//   - steeringScopeMatches behavior (empty = global, mixed separators,
//     case sensitivity)

import {
    extractApplyToScopesFromContent,
    steeringScopeMatches
} from '../../specs/SteeringManager';

describe('extractApplyToScopesFromContent — header variants', () => {
    it('recognizes "## Applies to"', () => {
        const result = extractApplyToScopesFromContent(`
# Tech

## Applies to
- src/server/
- src/api/
        `);
        expect(result).toEqual(['src/server/', 'src/api/']);
    });

    it('recognizes "## Scope"', () => {
        const result = extractApplyToScopesFromContent(`
## Scope
- tests/
        `);
        expect(result).toEqual(['tests/']);
    });

    it('is case-insensitive', () => {
        const result = extractApplyToScopesFromContent(`
## APPLIES TO
- A/
## scope
- B/
        `);
        expect(result).toContain('A/');
        expect(result).toContain('B/');
    });

    it('returns empty when no scope header exists (= globally applicable)', () => {
        const result = extractApplyToScopesFromContent(`
# Product

## What we are building

A coding assistant.
        `);
        expect(result).toEqual([]);
    });

    it('does NOT match the exclude header (separate semantics)', () => {
        const result = extractApplyToScopesFromContent(`
## Exclude paths
- legacy/
        `);
        // "Exclude paths" is a different section — should not be
        // confused with scope.
        expect(result).toEqual([]);
    });

    it('handles HTML comments and quote-stripping like exclude does', () => {
        const result = extractApplyToScopesFromContent(`
<!-- ## Applies to
- commented/
-->

## Applies to
- \`real/\`
- "quoted/"
        `);
        expect(result).toEqual(['real/', 'quoted/']);
    });
});

describe('steeringScopeMatches', () => {
    it('returns true for any path when scope list is empty (= global)', () => {
        expect(steeringScopeMatches('/repo/src/foo.ts', [])).toBe(true);
        expect(steeringScopeMatches('anything', [])).toBe(true);
    });

    it('returns true when filepath contains a scope prefix', () => {
        expect(steeringScopeMatches('/repo/src/server/foo.ts', ['src/server/'])).toBe(true);
    });

    it('returns false when no scope matches', () => {
        expect(
            steeringScopeMatches('/repo/src/client/foo.ts', ['src/server/', 'src/api/'])
        ).toBe(false);
    });

    it('matches against any scope in the list', () => {
        expect(
            steeringScopeMatches('/repo/src/api/v2/foo.ts', ['src/server/', 'src/api/'])
        ).toBe(true);
    });

    it('normalizes Windows backslash paths to forward slashes', () => {
        expect(
            steeringScopeMatches('C:\\repo\\src\\server\\foo.ts', ['src/server/'])
        ).toBe(true);
    });

    it('normalizes patterns that use backslashes too', () => {
        expect(
            steeringScopeMatches('/repo/src/server/foo.ts', ['src\\server\\'])
        ).toBe(true);
    });

    it('skips empty pattern strings (defensive)', () => {
        // A scope list with only blank entries should NOT match
        // anything — that would defeat the "scope this file" intent.
        // The documented contract is that empty list = global; here
        // the list has entries, just blank ones, so behaviour is "no
        // pattern matched".
        expect(steeringScopeMatches('/repo/src/foo.ts', ['', '   '])).toBe(false);
    });

    it('is case-sensitive', () => {
        expect(steeringScopeMatches('/repo/Server/foo.ts', ['src/server/'])).toBe(false);
    });

    it('matches a relative path against a relative scope', () => {
        // Scopes might be authored without a leading slash.
        expect(steeringScopeMatches('src/server/foo.ts', ['src/server/'])).toBe(true);
    });
});

describe('integration: scope+exclude in the same file', () => {
    it('parses both sections independently', () => {
        const content = `
# Banking compliance steering

## Applies to
- src/banking/
- src/compliance/

## Exclude paths
- src/banking/legacy/
- generated/

## Rules

Use Result<T,E> instead of throw.
        `;
        const scopes = extractApplyToScopesFromContent(content);
        // We can also verify exclude works without importing it
        // separately — just check scopes here.
        expect(scopes).toEqual(['src/banking/', 'src/compliance/']);
    });
});