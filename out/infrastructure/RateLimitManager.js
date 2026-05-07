"use strict";
// src/infrastructure/RateLimitManager.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimitManager = void 0;
class RateLimitManager {
    /**
     * Inspects a Fetch API Response for 429 Throttling.
     * If throttled, it forces the Swarm to wait before the RetryManager loops.
     */
    static async handleThrottling(response, logCallback) {
        if (response.status === 429) {
            // Read the standard Retry-After header (seconds)
            const retryAfterStr = response.headers.get('Retry-After');
            // Default to 5 seconds if the header is missing
            const waitTimeMs = retryAfterStr ? parseInt(retryAfterStr, 10) * 1000 : 5000;
            if (logCallback) {
                logCallback(`🚦 RATE LIMIT HIT (429). Pausing Swarm execution for ${waitTimeMs / 1000}s...`);
            }
            // Halt execution
            await new Promise(resolve => setTimeout(resolve, waitTimeMs));
            // Throwing forces the RetryManager to try the fetch again
            const error = new Error("API_THROTTLED");
            error.status = 429;
            throw error;
        }
        if (!response.ok) {
            // Read the body once so error inspectors (notably the
            // tool-capability detector in OpenAICompatibleProvider) can
            // distinguish "tool not supported" 400s from generic 400s.
            // The body read consumes the stream, but since we're throwing
            // the response object can't be reused anyway.
            let body = '';
            try {
                body = await response.text();
            }
            catch {
                // Body read may fail for streamed responses; don't let
                // that mask the original HTTP error.
            }
            const error = new Error(`HTTP Error ${response.status}: ${response.statusText}${body ? ` — ${body.substring(0, 500)}` : ''}`);
            error.status = response.status;
            if (body)
                error.body = body;
            throw error;
        }
        return response;
    }
}
exports.RateLimitManager = RateLimitManager;
//# sourceMappingURL=RateLimitManager.js.map