"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryManager = void 0;
// src/infrastructure/RetryManager.ts
const errors_1 = require("../utilities/errors");
class RetryManager {
    /**
     * Executes an async operation with exponential backoff.
     * Matches the AWS Kiro specification: 1s, 2s, 4s delays.
     */
    static async executeWithExponentialBackoff(operation, maxRetries = 3, baseDelayMs = 1000, onRetry) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                return await operation();
            }
            catch (error) {
                attempt++;
                // If we've exhausted all retries, fail upward
                if (attempt > maxRetries) {
                    throw new Error(`Operation failed after ${maxRetries} retries. Final Error: ${(0, errors_1.errorMessage)(error)}`);
                }
                // 🚨 Fast-Fail: Do not retry 400 (Bad Request) or 401/403 (Auth) errors
                // Errors thrown by fetch wrappers may carry a numeric `.status` field.
                const status = (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number')
                    ? error.status
                    : undefined;
                if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
                    throw error;
                }
                // Calculate exponential backoff (1000ms, 2000ms, 4000ms)
                const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
                if (onRetry) {
                    onRetry(attempt, delayMs, error);
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        throw new Error("Unreachable code in RetryManager");
    }
}
exports.RetryManager = RetryManager;
//# sourceMappingURL=RetryManager.js.map