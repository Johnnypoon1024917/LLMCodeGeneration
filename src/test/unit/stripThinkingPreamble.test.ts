// src/test/unit/stripThinkingPreamble.test.ts
//
// Tests for the V2.1.2 spec-redesign-fix preamble stripper. Pure
// function; tests are pure too. The feature exists because Qwen 3.6 27B
// in reasoning mode sometimes writes its scratch work into the content
// channel ("Here's a thinking process: ...") before producing the
// actual structured response, which then gets saved verbatim into the
// spec file and rendered as garbage in the spec page.
//
// Conservative-by-design: false negatives (preamble survives) are
// cosmetic; false positives (real content stripped) corrupt the spec.
// These tests pin the conservative behavior in place.

import { describe, it, expect } from '@jest/globals';
import { stripThinkingPreamble } from '../../llmService';

describe('stripThinkingPreamble', () => {
    it('returns empty input unchanged', () => {
        expect(stripThinkingPreamble('')).toBe('');
    });

    it('returns input unchanged when there is no preamble', () => {
        const clean = '---\nversion: 1.0.0\ntype: architecture_design\n---\n\n# System Architecture\n';
        expect(stripThinkingPreamble(clean)).toBe(clean);
    });

    it('strips a long thinking-process preamble before YAML frontmatter', () => {
        const preamble =
            "Here's a thinking process:\n\n" +
            "1. **Analyze User Input:** The user wants a system architecture for a booking dashboard.\n" +
            "2. **Deconstruct Requirements:** Frontend, backend, real-time updates, caching layer.\n" +
            "3. **Draft Section by Section:** Architecture components, data models, ER diagram.\n";
        const realContent = '---\nversion: 1.0.0\ntype: architecture_design\n---\n\n# System Architecture\n';
        const result = stripThinkingPreamble(preamble + realContent);
        expect(result).toBe(realContent);
        // Sanity: the thinking trace is gone
        expect(result).not.toContain('thinking process');
        expect(result).not.toContain('Deconstruct Requirements');
    });

    it('strips preamble before XML structural tags (no YAML frontmatter)', () => {
        const preamble =
            "Let me analyze the requirements carefully.\n\n" +
            "First, I need to identify the key architectural components based on the PRD.\n" +
            "The frontend needs to be responsive and accessible.\n";
        const realContent = '<architecture_components>\n## Core Components\n- Next.js 14\n</architecture_components>';
        const result = stripThinkingPreamble(preamble + realContent);
        expect(result.startsWith('<architecture_components>')).toBe(true);
        expect(result).not.toContain('Let me analyze');
    });

    it('does NOT strip when the "preamble" is shorter than 50 chars', () => {
        // A short prefix is more likely to be a one-line note than a
        // multi-paragraph thinking trace. Conservative: leave it.
        const tinyPrefix = 'Note:\n\n';
        const realContent = '---\nversion: 1.0.0\n---\n# Real Content\n';
        const input = tinyPrefix + realContent;
        expect(stripThinkingPreamble(input)).toBe(input);
    });

    it('strips preamble when followed by a top-level markdown heading', () => {
        const preamble =
            "Okay, let me think through this design.\n\n" +
            "I need to figure out the data model first, then the API layer.\n" +
            "The frontend will use React with TanStack Query for caching.\n";
        const realContent = '# System Architecture\n\nThis document describes...\n';
        const result = stripThinkingPreamble(preamble + realContent);
        expect(result).toBe(realContent);
    });

    it('finds the EARLIEST marker when multiple are present', () => {
        // Example: the model wrote a heading AS PART of its thinking trace,
        // then later produced the real frontmatter. We should prefer the
        // earliest marker so we don't strip too much. (Conservative: better
        // to leave noise than to eat content.)
        const preamble =
            "Here's a thinking process:\n\n" +
            "I need to think about this carefully because the architecture is complex.\n" +
            "Let me start by sketching out an outline before producing the real document.\n";
        const fakeHeading = '# Draft outline (mental sketch)\n\n';
        const moreThinking = 'Then I realized I should restart and produce real output...\n\n';
        const realContent = '---\nversion: 1.0.0\n---\n# Real Architecture\n';
        const input = preamble + fakeHeading + moreThinking + realContent;

        const result = stripThinkingPreamble(input);
        // The earliest marker is the # heading inside the trace, so stripping
        // happens at THAT point. Real content is preserved (along with some
        // residual thinking). This is the conservative behavior — we accept
        // some residual noise rather than risking eating real content.
        expect(result).toContain('Real Architecture');
        expect(result).not.toContain('Here\'s a thinking process');
    });

    it('handles non-string input defensively (TypeScript guard)', () => {
        // `as any` because the type signature says string, but real callers
        // can pass weird stuff via dynamic dispatch. Belt-and-suspenders
        // matters for a function that's called from an LLM-output path.
        expect(stripThinkingPreamble(undefined as any)).toBe(undefined);
        expect(stripThinkingPreamble(null as any)).toBe(null);
    });

    it('matches the exact thinking-trace shape from the user-reported case', () => {
        // Lifted from the actual design.md that surfaced this bug — the
        // first 7 lines of an FSD MRBS Dashboard generation. Real-world
        // regression test. (Trimmed to keep the test compact; the principle
        // is the same.)
        const realCase =
            "Here's a thinking process:\n\n" +
            "1.  **Analyze User Input:**\n" +
            "   - **Role:** Elite FAANG Software Architect\n" +
            "   - **Task:** Design a highly scalable System Architecture\n" +
            "\n" +
            "---\n" +
            "version: 1.0.0\n" +
            "type: architecture_design\n" +
            "---\n" +
            "\n" +
            "# System Architecture\n" +
            "\n" +
            "<architecture_components>\n" +
            "## Core Components\n" +
            "Next.js 14 App Router\n" +
            "</architecture_components>";
        const result = stripThinkingPreamble(realCase);
        expect(result.startsWith('---\nversion: 1.0.0')).toBe(true);
        expect(result).not.toContain('FAANG Software Architect');
        expect(result).toContain('System Architecture');
        expect(result).toContain('<architecture_components>');
    });
});