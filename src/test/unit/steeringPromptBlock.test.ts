// src/test/unit/steeringPromptBlock.test.ts
//
// PR P1.2: tests for the pure prompt-block builders.
//
// SteeringManager itself is FS-heavy and hard to unit-test without
// extensive vscode mocks. The pure content-aggregation logic
// (normalizeSteeringContent + formatSteeringPromptBlock) was extracted
// as module-level functions specifically so it can be tested directly
// here. The class method `buildSteeringPromptBlock` is a thin wrapper
// over these functions plus FS reads — covered by the webview-side
// steeringPanel.test.tsx integration tests.

import {
    normalizeSteeringContent,
    formatSteeringPromptBlock,
    MAX_STEERING_BLOCK_BYTES
} from '../../specs/SteeringManager';

describe('normalizeSteeringContent', () => {
    it('returns empty string for content with only HTML comments', () => {
        const input = '<!-- this is a comment -->\n<!-- and another -->';
        expect(normalizeSteeringContent(input)).toBe('');
    });

    it('returns empty string for headers-only content (template skeleton)', () => {
        const input = '# Product\n\n## What we are building\n\n## Target users';
        expect(normalizeSteeringContent(input)).toBe('');
    });

    it('returns empty string when content is just whitespace', () => {
        expect(normalizeSteeringContent('   \n\n  \n')).toBe('');
        expect(normalizeSteeringContent('')).toBe('');
    });

    it('returns content when there is at least one non-header line', () => {
        const input =
            '# Product\n\n' +
            '## What we are building\n\n' +
            'A spec-driven coding assistant for regulated industries.\n';
        const out = normalizeSteeringContent(input);
        expect(out).toContain('A spec-driven coding assistant');
        expect(out).toContain('# Product');
    });

    it('strips HTML comments from real content', () => {
        const input =
            '# Tech\n\n' +
            '<!-- list languages here -->\n' +
            'TypeScript, Python.\n';
        const out = normalizeSteeringContent(input);
        expect(out).not.toContain('<!--');
        expect(out).not.toContain('list languages here');
        expect(out).toContain('TypeScript, Python');
    });

    it('collapses runs of blank lines', () => {
        const input = '# Header\n\n\n\n\nSome content';
        const out = normalizeSteeringContent(input);
        // Should not have 3+ consecutive newlines anywhere
        expect(out).not.toMatch(/\n{3,}/);
        expect(out).toContain('Some content');
    });

    it('preserves multi-line content structure', () => {
        const input =
            '# Structure\n\n' +
            '## Folders\n\n' +
            '- src/agents/\n' +
            '- src/audit/\n' +
            '- src/hooks/\n';
        const out = normalizeSteeringContent(input);
        expect(out).toContain('- src/agents/');
        expect(out).toContain('- src/audit/');
        expect(out).toContain('- src/hooks/');
    });

    it('treats indented code blocks as content (not template)', () => {
        const input =
            '# Tech\n\n' +
            '```ts\n' +
            'export type Result<T, E> = ...\n' +
            '```\n';
        // The fenced code block lines don't start with '#' so they're
        // not headers — should pass the all-headers gate.
        const out = normalizeSteeringContent(input);
        expect(out).toContain('export type Result');
    });
});

describe('formatSteeringPromptBlock', () => {
    it('returns empty string when sources list is empty', () => {
        expect(formatSteeringPromptBlock([])).toBe('');
    });

    it('returns empty string when all sources normalize to empty', () => {
        const out = formatSteeringPromptBlock([
            { name: 'product', content: '# Product\n<!-- comment -->' },
            { name: 'structure', content: '<!-- empty template -->' }
        ]);
        expect(out).toBe('');
    });

    it('wraps a single source with the steering preamble', () => {
        const out = formatSteeringPromptBlock([
            {
                name: 'tech',
                content: '# Tech\n\nUse Result<T,E> instead of throw.\n'
            }
        ]);
        expect(out).toContain('# Steering: project conventions');
        expect(out).toContain('## tech');
        expect(out).toContain('Use Result<T,E>');
        expect(out).toContain('MUST follow');
    });

    it('preserves source order in the output', () => {
        const out = formatSteeringPromptBlock([
            { name: 'product', content: '# Product\n\nA project.' },
            { name: 'structure', content: '# Structure\n\nFiles here.' },
            { name: 'tech', content: '# Tech\n\nLanguages here.' }
        ]);
        const productIdx = out.indexOf('## product');
        const structureIdx = out.indexOf('## structure');
        const techIdx = out.indexOf('## tech');
        expect(productIdx).toBeGreaterThan(-1);
        expect(structureIdx).toBeGreaterThan(productIdx);
        expect(techIdx).toBeGreaterThan(structureIdx);
    });

    it('skips sources that normalize to empty without breaking order', () => {
        const out = formatSteeringPromptBlock([
            { name: 'product', content: '<!-- empty template -->' },
            { name: 'tech', content: '# Tech\n\nReal content here.' }
        ]);
        // product should be skipped; tech should be present
        expect(out).not.toContain('## product');
        expect(out).toContain('## tech');
        expect(out).toContain('Real content here');
    });

    it('truncates with marker when total exceeds MAX_STEERING_BLOCK_BYTES', () => {
        // Build sources where the FIRST fits and the SECOND would
        // overflow. The first source uses ~75% of the budget so it
        // gets included; the second is sized to push us past MAX.
        const fillBytes = Math.floor(MAX_STEERING_BLOCK_BYTES * 0.75);
        const filler = 'x'.repeat(fillBytes);
        const overflow = 'y'.repeat(Math.floor(MAX_STEERING_BLOCK_BYTES * 0.5));
        const sources = [
            { name: 'first', content: `# First\n\n${filler}` },
            { name: 'second', content: `# Second\n\n${overflow}` }
        ];
        const out = formatSteeringPromptBlock(sources);
        // First should be present
        expect(out).toContain('## first');
        // Second should be cut, with the marker visible
        expect(out).not.toContain('## second');
        expect(out).toContain('truncated');
        expect(out).toContain(`${MAX_STEERING_BLOCK_BYTES}`);
    });

    it('does not include truncation marker when everything fits', () => {
        const out = formatSteeringPromptBlock([
            { name: 'tech', content: '# Tech\n\nUse TypeScript.' }
        ]);
        expect(out).not.toContain('truncated');
    });

    it('handles a section name with spaces or special chars', () => {
        const out = formatSteeringPromptBlock([
            { name: 'banking-compliance-zh', content: '# Compliance\n\nRules.' }
        ]);
        expect(out).toContain('## banking-compliance-zh');
    });
});