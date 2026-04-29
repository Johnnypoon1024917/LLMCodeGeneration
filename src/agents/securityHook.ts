// src/agents/securityHook.ts
//
// Component 2B-3b: pre-dispatch security hook factory.
//
// Wires `askSecurityMonitor` (the LLM-based command-safety evaluator)
// into the `dispatchWithEvents` PreDispatchHook contract.
//
// Why a factory and not a direct hook function: the hook contract is
// `(toolCall, args) => Promise<{ blocked, reason }>`. We want different
// callers to compose policy differently:
//
//   - Coordinator: scrutinize bash_exec via askSecurityMonitor, allow
//     all other tools without checking.
//   - Verifier (in 2B-5): may want stricter policy (e.g., reject
//     write_file outside the project root).
//   - planAgent: read-only tools, no security check needed.
//
// The factory takes a config and returns a hook closure. Callers pick
// the policy they want.
//
// Q5=5D: when blocked, return { blocked: true, reason: ... }. The
// dispatchWithEvents wrapper will emit a toolCallCompleted event with
// status='error' and surface "Blocked: <reason>" to the LLM. No retry
// (per Q5=5D) — the LLM decides what to do next.

import type { ToolCall } from '../llm';
import type { PreDispatchHook } from './toolDispatchWithEvents';
import { askSecurityMonitor } from '../llmService';

/**
 * Configuration for the security hook factory.
 *
 *   - `scrutinizeBash`: when true, bash_exec calls are submitted to
 *     askSecurityMonitor. Default: true (defense by default).
 *   - `customAskMonitor`: dependency injection for tests. When
 *     provided, replaces askSecurityMonitor — tests pass scripted
 *     verdicts without an LLM round-trip.
 *
 * Adding new fields here is additive; existing call sites don't
 * have to update.
 */
export interface SecurityHookConfig {
    scrutinizeBash?: boolean;
    /** Test-only: replace askSecurityMonitor. Returns true to block. */
    customAskMonitor?: (command: string) => Promise<boolean>;
}

/**
 * Build a preDispatchHook configured with the given policy. The hook:
 *
 *   - For `bash_exec` calls: extracts the `command` arg and submits
 *     to askSecurityMonitor. If the monitor blocks, the hook returns
 *     `{ blocked: true, reason: ... }`. If it allows, the hook returns
 *     `{ blocked: false }`.
 *   - For all other tools: returns `{ blocked: false }` immediately
 *     (no check). Future policy may add per-tool checks (URL allowlist
 *     for web_fetch, etc.).
 *
 * Failure modes:
 *   - askSecurityMonitor's internal try/catch returns `true` (block)
 *     on any error. Same fail-safe applies here — if the monitor
 *     can't evaluate, we block the command. The LLM then sees
 *     "Blocked: Security Monitor unavailable" and can route around.
 *
 * Performance:
 *   - The hook adds one LLM round-trip per bash_exec call. The
 *     security monitor uses a small/cheap model in practice; latency
 *     is acceptable. If a customer doesn't want this overhead, they
 *     can pass `scrutinizeBash: false` to disable.
 */
export function buildSecurityHook(config?: SecurityHookConfig): PreDispatchHook {
    const scrutinize = config?.scrutinizeBash ?? true;
    const ask = config?.customAskMonitor ?? askSecurityMonitor;

    return async (toolCall: ToolCall, args: Record<string, unknown>) => {
        // Only bash_exec is gated for now. Other tools may add policy
        // later (web_fetch URL allowlist, install_package allowlist).
        if (toolCall.function.name !== 'bash_exec' || !scrutinize) {
            return { blocked: false };
        }

        const command = String(args['command'] ?? '');
        if (!command) {
            // Empty command — let the dispatcher handle the missing-arg
            // error. The hook's job is policy, not arg validation.
            return { blocked: false };
        }

        const blocked = await ask(command);
        if (blocked) {
            return {
                blocked: true,
                reason: `Security Monitor blocked the command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`
            };
        }
        return { blocked: false };
    };
}

/**
 * Allow-all hook. For tests, planAgent (read-only tools), and any
 * caller that explicitly wants to bypass policy. Tests for the
 * dispatch wrapper use this as the no-op baseline.
 */
export const allowAllHook: PreDispatchHook = async () => ({ blocked: false });