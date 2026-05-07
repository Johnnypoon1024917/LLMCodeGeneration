"use strict";
// src/llm/thinkingParser.ts
//
// V2.0: defensive parser for thinking-block leakage.
//
// Qwen 3.6 (and older Qwen 3 variants) sometimes emit reasoning
// inside the `content` field instead of (or in addition to) the
// proper `reasoning_content` field. This is a documented bug —
// see https://github.com/QwenLM/Qwen3.6/issues/26 and #89:
//
//   - Issue #26: when tool calling is active and `reasoning_content`
//     is NOT echoed back into the messages history, the next response
//     leaks reasoning + a literal `</think>` tag into `content`.
//
//   - Issue #89: tool definitions in the request payload sometimes
//     suppress reasoning entirely, sometimes still leak it into
//     `content` — binary on/off behavior that's hard to predict.
//
// We can't fix the model — but we CAN detect the leak and strip it
// before the rest of the system tries to JSON-parse `content` and
// chokes on a stray `</think>`. This module is the strip.
//
// Detection heuristic: scan for `<think>...</think>` blocks (case-
// insensitive, multiline). If found, the reasoning is captured into
// `extracted` and removed from `clean`. Stray closing tags without
// an opening counterpart (the issue #26 specific case) are also
// stripped — better to silently drop than to leave a broken parse.
//
// What this module does NOT do:
//   - Modify `reasoning_content` if it's present and well-formed
//   - Try to be smart about partial-tag streaming output (the
//     non-streaming path is what this is for; streaming has its
//     own SSE parser)
//   - Rewrite the AssistantMessage shape — callers do that themselves
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractThinkingFromContent = extractThinkingFromContent;
exports.contentHasThinkingLeak = contentHasThinkingLeak;
/**
 * Strip `<think>...</think>` blocks from a content string.
 *
 * Handles three forms observed in the wild:
 *   1. Well-formed: `<think>...</think>more content` → strips block
 *   2. Stray closing only: `reasoning</think>actual content` → drops
 *      everything before and including the closing tag
 *   3. Stray opening only: `<think>reasoning, no close` → captures
 *      everything after `<think>` as reasoning, leaves clean empty
 *
 * Forms 2 and 3 happen specifically when reasoning_content is dropped
 * from the conversation history but the model still emits a partial
 * tag during generation. They're recoverable; we recover.
 *
 * Pure function. Does not throw on any input.
 */
function extractThinkingFromContent(content) {
    if (!content || typeof content !== 'string') {
        return { clean: content ?? '', extracted: '' };
    }
    // Normalize whitespace inside tags but preserve case-insensitivity.
    // The Qwen chat template emits lowercase `<think>` reliably; use
    // `i` flag defensively in case a future variant uppercases.
    const fullBlockRe = /<think>([\s\S]*?)<\/think>/gi;
    const extractedParts = [];
    let clean = content.replace(fullBlockRe, (_match, inner) => {
        extractedParts.push(inner.trim());
        return '';
    });
    // After full-block removal, look for stray closing tags. Anything
    // before the first remaining `</think>` was captured but never
    // opened — treat it as reasoning that leaked, drop it.
    const strayCloseIdx = clean.search(/<\/think>/i);
    if (strayCloseIdx >= 0) {
        const leakedReasoning = clean.slice(0, strayCloseIdx).trim();
        if (leakedReasoning) {
            extractedParts.push(leakedReasoning);
        }
        // Drop up to and including the closing tag
        clean = clean.replace(/[\s\S]*?<\/think>/i, '');
    }
    // Stray opening tag with no close: everything after the opening
    // tag is reasoning. Don't be lenient about this — closing tags
    // should appear before any tool call payload.
    const strayOpenIdx = clean.search(/<think>/i);
    if (strayOpenIdx >= 0) {
        const beforeTag = clean.slice(0, strayOpenIdx);
        const afterTag = clean.slice(strayOpenIdx).replace(/<think>/i, '').trim();
        if (afterTag) {
            extractedParts.push(afterTag);
        }
        clean = beforeTag;
    }
    return {
        clean: clean.trim(),
        extracted: extractedParts.join('\n').trim(),
    };
}
/**
 * Convenience: returns true when the content appears to contain a
 * thinking block (well-formed or stray). Useful for callers that
 * want to log the leak occurrence without performing extraction.
 */
function contentHasThinkingLeak(content) {
    if (!content) {
        return false;
    }
    return /<\/?think>/i.test(content);
}
//# sourceMappingURL=thinkingParser.js.map