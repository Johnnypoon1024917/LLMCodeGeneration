// src/test/unit/thinkingParser.test.ts
//
// V2.0: tests for the defensive thinking-block parser.
//
// Coverage:
//   - Well-formed `<think>...</think>` blocks extracted into reasoning,
//     content cleaned
//   - Multiple blocks concatenated
//   - Stray closing tag (Qwen issue #26 specific case)
//   - Stray opening tag (rare but documented)
//   - Empty / null inputs handled
//   - Case-insensitive matching
//   - contentHasThinkingLeak helper

import {
    extractThinkingFromContent,
    contentHasThinkingLeak,
} from '../../llm/thinkingParser';

describe('extractThinkingFromContent — well-formed blocks', () => {
    it('returns input unchanged when no thinking is present', () => {
        const r = extractThinkingFromContent('plain content with no tags');
        expect(r.clean).toBe('plain content with no tags');
        expect(r.extracted).toBe('');
    });

    it('extracts a single block and returns clean content', () => {
        const r = extractThinkingFromContent(
            '<think>I should answer politely.</think>Hello there!'
        );
        expect(r.extracted).toBe('I should answer politely.');
        expect(r.clean).toBe('Hello there!');
    });

    it('extracts multiline thinking blocks', () => {
        const r = extractThinkingFromContent(
            '<think>Step 1: read the prompt.\nStep 2: plan the answer.</think>The answer is 42.'
        );
        expect(r.extracted).toContain('Step 1');
        expect(r.extracted).toContain('Step 2');
        expect(r.clean).toBe('The answer is 42.');
    });

    it('joins multiple blocks with newlines', () => {
        const r = extractThinkingFromContent(
            '<think>first</think>middle<think>second</think>end'
        );
        expect(r.extracted).toBe('first\nsecond');
        expect(r.clean).toBe('middleend');
    });

    it('handles thinking before and after content', () => {
        const r = extractThinkingFromContent(
            'before <think>thoughts</think> after'
        );
        expect(r.extracted).toBe('thoughts');
        expect(r.clean).toBe('before  after');
    });

    it('case-insensitive tag matching', () => {
        const r = extractThinkingFromContent(
            '<THINK>uppercase</THINK>Hello'
        );
        // We use the `i` flag for safety; current Qwen uses lowercase
        expect(r.extracted).toBe('uppercase');
        expect(r.clean).toBe('Hello');
    });
});

describe('extractThinkingFromContent — leak cases (Qwen issues #26/#89)', () => {
    it('handles stray closing tag without opening (issue #26)', () => {
        // This is the exact pattern from issue #26: reasoning leaked
        // into content with only the closing `</think>` tag visible.
        const r = extractThinkingFromContent(
            'I called the get_current_time tool and got 14:58:09. Now I need to reply.</think>It is now 14:58:09.'
        );
        expect(r.extracted).toContain('called the get_current_time tool');
        expect(r.clean).toBe('It is now 14:58:09.');
    });

    it('handles stray opening tag without closing', () => {
        const r = extractThinkingFromContent(
            'visible part <think>this never closes properly'
        );
        expect(r.extracted).toBe('this never closes properly');
        expect(r.clean).toBe('visible part');
    });

    it('keeps clean output trimmed', () => {
        const r = extractThinkingFromContent(
            '   <think>thoughts</think>   answer   '
        );
        expect(r.clean).toBe('answer');
    });

    it('returns empty clean when only thinking is present', () => {
        const r = extractThinkingFromContent(
            '<think>just thoughts, no actual answer</think>'
        );
        expect(r.clean).toBe('');
        expect(r.extracted).toBe('just thoughts, no actual answer');
    });
});

describe('extractThinkingFromContent — edge cases', () => {
    it('handles empty string', () => {
        const r = extractThinkingFromContent('');
        expect(r.clean).toBe('');
        expect(r.extracted).toBe('');
    });

    it('handles whitespace-only input', () => {
        const r = extractThinkingFromContent('   \n\t  ');
        expect(r.clean).toBe('');
        expect(r.extracted).toBe('');
    });

    it('handles content with literal angle brackets that are not think tags', () => {
        const r = extractThinkingFromContent(
            'compare a < b and a > b are valid expressions'
        );
        expect(r.clean).toBe('compare a < b and a > b are valid expressions');
        expect(r.extracted).toBe('');
    });

    it('handles HTML-like content without think tags', () => {
        const r = extractThinkingFromContent(
            '<div>Hello <span>world</span></div>'
        );
        expect(r.clean).toBe('<div>Hello <span>world</span></div>');
        expect(r.extracted).toBe('');
    });

    it('handles JSON content with no leakage', () => {
        const r = extractThinkingFromContent('{"answer": "42"}');
        expect(r.clean).toBe('{"answer": "42"}');
        expect(r.extracted).toBe('');
    });

    it('does not throw on undefined input (defensive)', () => {
        // TypeScript catches this at compile time but we want runtime
        // safety too — defensive parsers should never throw.
        const r = extractThinkingFromContent(undefined as unknown as string);
        expect(r.clean).toBe('');
        expect(r.extracted).toBe('');
    });

    it('does not throw on null input (defensive)', () => {
        const r = extractThinkingFromContent(null as unknown as string);
        expect(r.clean).toBe('');
        expect(r.extracted).toBe('');
    });
});

describe('contentHasThinkingLeak', () => {
    it('returns false for plain content', () => {
        expect(contentHasThinkingLeak('hello world')).toBe(false);
    });

    it('returns true for well-formed thinking', () => {
        expect(contentHasThinkingLeak('<think>x</think>y')).toBe(true);
    });

    it('returns true for stray closing tag', () => {
        expect(contentHasThinkingLeak('reasoning</think>answer')).toBe(true);
    });

    it('returns true for stray opening tag', () => {
        expect(contentHasThinkingLeak('answer<think>partial')).toBe(true);
    });

    it('returns false for null/undefined', () => {
        expect(contentHasThinkingLeak(null)).toBe(false);
        expect(contentHasThinkingLeak(undefined)).toBe(false);
    });

    it('returns false for content with literal < and > but no think tag', () => {
        expect(contentHasThinkingLeak('a < b > c')).toBe(false);
    });
});