// src/infrastructure/RetryManager.ts
import { errorMessage } from '../utilities/errors';

export class RetryManager {
    /**
     * Executes an async operation with exponential backoff.
     * Matches the AWS Kiro specification: 1s, 2s, 4s delays.
     */
    public static async executeWithExponentialBackoff<T>(
        operation: () => Promise<T>,
        maxRetries: number = 3,
        baseDelayMs: number = 1000,
        onRetry?: (attempt: number, delay: number, error: unknown) => void
    ): Promise<T> {
        let attempt = 0;

        while (attempt <= maxRetries) {
            try {
                return await operation();
            } catch (error: unknown) {
                attempt++;

                // If we've exhausted all retries, fail upward
                if (attempt > maxRetries) {
                    throw new Error(`Operation failed after ${maxRetries} retries. Final Error: ${errorMessage(error)}`);
                }

                // 🚨 Fast-Fail: Do not retry 400 (Bad Request) or 401/403 (Auth) errors
                // Errors thrown by fetch wrappers may carry a numeric `.status` field.
                const status = (error && typeof error === 'object' && 'status' in error && typeof (error as { status: unknown }).status === 'number')
                    ? (error as { status: number }).status
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