// src/test/unit/contextTruncation.test.ts
//
// Tests for the V2.1.2 chat-context truncation guard. Pure helper —
// no I/O, no provider calls — so tests are fast and deterministic.
//
// Why this exists: Qwen 3.6 27B at the ASL Lab endpoint has a 32K
// token context cap. When we exceed it, the endpoint returns 200 +
// empty choices rather than a clean 400 error. Without truncation,
// long file dumps from the explore-mode tool calls silently produce
// "Analyzing evidence... [no output]" reports. Truncation + the
// EmptyCompletionError check together close that gap.

import { describe, it, expect } from '@jest/globals';
import {
    truncateContextForChat,
    CHAT_CONTEXT_CHAR_BUDGET,
} from '../../llmService';

describe('truncateContextForChat', () => {
    it('returns input unchanged when under threshold', () => {
        const small = 'a'.repeat(1000);
        expect(truncateContextForChat(small)).toBe(small);
    });

    it('returns input unchanged when exactly at threshold', () => {
        const exact = 'b'.repeat(CHAT_CONTEXT_CHAR_BUDGET);
        expect(truncateContextForChat(exact)).toBe(exact);
    });

    it('truncates when over threshold and inserts a visible marker', () => {
        const oversized = 'c'.repeat(CHAT_CONTEXT_CHAR_BUDGET + 10_000);
        const result = truncateContextForChat(oversized);
        expect(result.length).toBeLessThan(oversized.length);
        expect(result).toMatch(/CONTEXT TRUNCATED/);
        expect(result).toMatch(/characters omitted/);
    });

    it('keeps both head and tail of the original content', () => {
        // Use distinguishable head and tail so we can verify both survive.
        // Head marker at the very start (kept by the head 75%), tail
        // marker at the very END (kept by the tail 25%).
        const head = 'HEAD_MARKER_' + 'x'.repeat(CHAT_CONTEXT_CHAR_BUDGET);
        const tail = 'y'.repeat(20_000) + '_TAIL_MARKER';
        const oversized = head + tail;
        const result = truncateContextForChat(oversized);
        // Head should be present (we keep first 75% of budget)
        expect(result).toContain('HEAD_MARKER_');
        // Tail should be present (we keep last 25% of budget)
        expect(result).toContain('_TAIL_MARKER');
    });

    it('reports the omitted character count in the marker', () => {
        const oversized = 'd'.repeat(CHAT_CONTEXT_CHAR_BUDGET + 50_000);
        const result = truncateContextForChat(oversized);
        // 50,000 chars omitted; commas in toLocaleString
        expect(result).toMatch(/50,000/);
    });

    it('handles single-character-over-threshold correctly', () => {
        // Edge case: one char over the budget. Should still truncate
        // (>, not >=) but the omitted count will be tiny.
        const justOver = 'e'.repeat(CHAT_CONTEXT_CHAR_BUDGET + 1);
        const result = truncateContextForChat(justOver);
        expect(result).toMatch(/CONTEXT TRUNCATED/);
        // Head + tail = budget, so 1 char is omitted.
        expect(result).toMatch(/1 characters omitted/);
    });

    it('preserves the marker delimiter across the truncation point', () => {
        // The marker text uses ─── box-drawing chars which should
        // survive concatenation. Sanity check that it's literally
        // there (not e.g. mojibake from the build).
        const oversized = 'f'.repeat(CHAT_CONTEXT_CHAR_BUDGET * 2);
        const result = truncateContextForChat(oversized);
        expect(result).toContain('───');
    });
});