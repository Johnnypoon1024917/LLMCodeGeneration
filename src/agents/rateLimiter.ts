// src/agents/rateLimiter.ts
//
// Component D12: per-task tool-call rate limiting.
//
// Threat model: a runaway agent (LLM in a tool-call loop, or one
// confused by error feedback) can hammer the filesystem or shell
// with hundreds of calls in seconds. Reported failure mode: the
// model "compounds errors at 30+ tool calls" — i.e., once it gets
// confused, it makes the situation worse rapidly.
//
// Mitigation: a per-task hard cap on total tool calls, plus per-tool
// caps for the most dangerous tools (bash_exec, write_file). When a
// limit is reached, subsequent calls are rejected with an error
// result rather than executed. The LLM sees the rejection in its
// message history and (ideally) recovers.
//
// What this is NOT:
//   - Time-windowed (sliding window) rate limiting. The threat is
//     volume, not rate — 100 bash calls in 5 seconds is no worse
//     than 100 in 5 minutes. Simple counters are sufficient.
//   - Persistent across tasks. Each task gets a fresh limiter. A
//     long-running session that runs many tasks doesn't accumulate
//     toward limits.
//   - A circuit breaker that disables tools after errors. Errors
//     and rate limits are independent concerns.
//
// Lifecycle:
//   1. Coordinator/CoderAgent construct a RateLimiter at task start
//   2. Pass into a rate-limit hook (see rateLimitHook.ts)
//   3. Hook calls tryConsume() before each dispatch
//   4. Limiter is disposed when the task ends (just goes out of scope)

/**
 * Configuration for the rate limiter. All fields optional with
 * sensible defaults — callers can pass {} for default behavior.
 *
 *   - `maxTotal`: total tool calls per task across all tools.
 *     Default 100. Set to 0 to effectively disable (every call
 *     denied) — useful for tests.
 *   - `perTool`: per-tool overrides. Map of tool name → cap. Tools
 *     not in the map have no per-tool limit (only the global
 *     `maxTotal` applies). Default {} (no per-tool limits).
 *
 * Adding new fields here is additive; tests and call sites that
 * don't pass them keep working.
 */
export interface RateLimiterConfig {
    maxTotal?: number;
    perTool?: Record<string, number>;
}

/**
 * Verdict returned from tryConsume(). Mirrors the
 * PreDispatchHook contract shape ({ blocked, reason }).
 */
export interface RateLimitVerdict {
    /** true if the call is allowed; false if rate-limited. */
    allowed: boolean;
    /** Human-readable explanation when allowed=false. */
    reason?: string;
}

/**
 * Per-task tool-call rate limiter. Construct once per task; each
 * tool dispatch calls tryConsume(toolName) before executing.
 *
 * NOT thread-safe — assumes synchronous tryConsume calls (true for
 * the agent's serial dispatch loop). If concurrent dispatches are
 * ever added, the counter increments need to be made atomic.
 */
export class RateLimiter {
    /** Default total cap when none specified. */
    public static readonly DEFAULT_MAX_TOTAL = 100;

    private readonly maxTotal: number;
    private readonly perToolCaps: Record<string, number>;

    private totalCount = 0;
    private readonly perToolCounts = new Map<string, number>();

    constructor(config: RateLimiterConfig = {}) {
        // 0 is a valid value (disable everything). Only undefined
        // means "use default".
        this.maxTotal = config.maxTotal ?? RateLimiter.DEFAULT_MAX_TOTAL;
        this.perToolCaps = { ...(config.perTool ?? {}) };
    }

    /**
     * Check if a tool call is allowed and, if so, increment the
     * counters. If denied, counters are NOT incremented (denied
     * calls don't count against future budget).
     *
     * Why increment-on-allow rather than always-increment: denied
     * calls didn't actually run. Counting them would compound the
     * problem — the LLM would see fewer and fewer of its calls
     * complete as denials piled up, even though no work was done.
     */
    tryConsume(toolName: string): RateLimitVerdict {
        // Check global cap first. If we're already at maxTotal,
        // no tool can run regardless of per-tool budget.
        if (this.totalCount >= this.maxTotal) {
            return {
                allowed: false,
                reason: `Per-task tool-call limit reached (${this.maxTotal} calls). Subsequent tool calls are rejected to prevent runaway behavior.`
            };
        }

        // Check per-tool cap if one is configured for this tool.
        const perToolCap = this.perToolCaps[toolName];
        if (perToolCap !== undefined) {
            const currentCount = this.perToolCounts.get(toolName) ?? 0;
            if (currentCount >= perToolCap) {
                return {
                    allowed: false,
                    reason: `Per-tool limit reached for ${toolName} (${perToolCap} calls). Subsequent ${toolName} calls are rejected.`
                };
            }
        }

        // Allowed. Increment both counters.
        this.totalCount += 1;
        this.perToolCounts.set(toolName, (this.perToolCounts.get(toolName) ?? 0) + 1);

        return { allowed: true };
    }

    // ─── Inspection helpers (mostly for tests) ────────────────────────

    /** Total tool calls consumed so far. */
    public getTotalCount(): number {
        return this.totalCount;
    }

    /** Calls consumed for a specific tool. */
    public getCountForTool(toolName: string): number {
        return this.perToolCounts.get(toolName) ?? 0;
    }

    /** Configured max total. Tests may want to assert configuration. */
    public getMaxTotal(): number {
        return this.maxTotal;
    }

    /** Configured per-tool cap (or undefined if none). */
    public getCapForTool(toolName: string): number | undefined {
        return this.perToolCaps[toolName];
    }

    /**
     * How many calls remain before maxTotal is hit. Useful for
     * "x calls remaining" UI hints in v1.1; not required for v1.
     */
    public getRemainingTotal(): number {
        return Math.max(0, this.maxTotal - this.totalCount);
    }
}