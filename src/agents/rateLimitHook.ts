// src/agents/rateLimitHook.ts
//
// Component D12: bridge between RateLimiter and the PreDispatchHook
// contract that toolDispatchWithEvents expects.
//
// Why a bridge: RateLimiter is a self-contained class with an
// imperative API (tryConsume → verdict). The dispatcher integrates
// via PreDispatchHook closures — `(toolCall, args) => Promise<{ blocked, reason }>`.
// This file adapts the former into the latter.
//
// Why not embed the limiter check directly in toolDispatchWithEvents:
//   - That would require modifying toolDispatchWithEvents.ts (the
//     central wrapper). The pattern of layering policy via hooks is
//     intentional in that file's design — separating mechanism from
//     policy. Adding rate limiting as another hook respects that.
//   - The Coordinator may want different rate-limit policies per
//     agent (Coder vs Verifier). Keeping the policy as a hook
//     constructed at call sites preserves that flexibility.
//   - Tests can compose hooks freely without rewriting the dispatcher.
//
// Composition: callers that want both security AND rate limiting
// use composeHooks(security, rateLimit) to produce a single hook.

import type { ToolCall } from '../llm';
import type { PreDispatchHook } from './toolDispatchWithEvents';
import { RateLimiter } from './rateLimiter';

/**
 * Build a PreDispatchHook that consults a RateLimiter before allowing
 * the dispatch. Returns blocked=true when the limiter denies.
 *
 * The hook wraps tryConsume in async only because the contract is
 * async — the limiter itself is synchronous.
 *
 * @param limiter The per-task rate limiter to consult. Typically
 *                constructed at task start by the Coordinator/CoderAgent
 *                and disposed when the task completes.
 */
export function buildRateLimitHook(limiter: RateLimiter): PreDispatchHook {
    return async (toolCall: ToolCall, _args: Record<string, unknown>) => {
        const verdict = limiter.tryConsume(toolCall.function.name);
        if (verdict.allowed) {
            return { blocked: false };
        }
        const result: { blocked: boolean; reason?: string } = {
            blocked: true
        };
        if (verdict.reason !== undefined) {
            result.reason = verdict.reason;
        }
        return result;
    };
}

/**
 * Compose multiple hooks into a single hook that runs them in
 * sequence. Returns the FIRST blocking verdict (subsequent hooks
 * are not evaluated once one blocks).
 *
 * Order matters: hooks are run left-to-right. Place security checks
 * before rate-limit checks so that:
 *   1. A bash_exec for `rm -rf /` is blocked by security FIRST
 *      (the expected reason in the LLM's history)
 *   2. A safe bash_exec hitting rate limits is blocked by rate
 *      limiting (the expected reason)
 *   3. We don't waste a security-monitor LLM call on a request
 *      that would be rate-limited anyway
 *
 * Empty input (no hooks) returns an allow-all hook.
 *
 * @param hooks Hooks to compose. Run left-to-right.
 */
export function composeHooks(...hooks: PreDispatchHook[]): PreDispatchHook {
    if (hooks.length === 0) {
        return async () => ({ blocked: false });
    }
    if (hooks.length === 1) {
        // Optimization: skip the wrapper closure when there's only
        // one hook. Same observable behavior.
        return hooks[0]!;
    }
    return async (toolCall: ToolCall, args: Record<string, unknown>) => {
        for (const hook of hooks) {
            const verdict = await hook(toolCall, args);
            if (verdict.blocked) {
                return verdict;
            }
        }
        return { blocked: false };
    };
}