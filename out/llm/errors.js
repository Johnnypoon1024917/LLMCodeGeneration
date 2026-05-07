"use strict";
// src/llm/errors.ts
//
// Shared error types for the LLM call paths. Pure module — no
// dependencies, no I/O. Lives under src/llm/ so both jsonRequest.ts
// (non-streaming) and llmService.ts (streaming via streamChat) can
// import it without circular dependency.
//
// Why this file exists: the V2.1.2 streaming-render hotfix introduced
// EmptyCompletionError as a sibling export in llmService.ts. That
// worked for streamChat but not for jsonRequest, because importing
// llmService.ts back from src/llm/ creates a cycle. Splitting the
// class out here lets both paths throw the same error class so
// callers can use a single `instanceof` check.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmptyCompletionError = void 0;
/**
 * Raised by streamChat / jsonRequest when the LLM returned 200 OK
 * but no usable content. Typically a sign of context-window overflow
 * (the endpoint silently returns empty completions on overflow rather
 * than 400) or a model deciding to emit no content for safety reasons.
 *
 * Callers should catch this specifically and surface a user-visible
 * message rather than letting it bubble up as a generic Error (which
 * would render as a console-style stack trace if at all).
 *
 * Stable contract: this class is its own type (not just an Error
 * with a code string) so callers can use `instanceof EmptyCompletionError`
 * without string-matching.
 */
class EmptyCompletionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EmptyCompletionError';
    }
}
exports.EmptyCompletionError = EmptyCompletionError;
//# sourceMappingURL=errors.js.map