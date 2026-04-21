// src/infrastructure/RateLimitManager.ts

export class RateLimitManager {
    /**
     * Inspects a Fetch API Response for 429 Throttling.
     * If throttled, it forces the Swarm to wait before the RetryManager loops.
     */
    public static async handleThrottling(response: Response, logCallback?: (msg: string) => void): Promise<Response> {
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
            (error as any).status = 429;
            throw error;
        }

        if (!response.ok) {
            const error = new Error(`HTTP Error ${response.status}: ${response.statusText}`);
            (error as any).status = response.status;
            throw error;
        }

        return response;
    }
}