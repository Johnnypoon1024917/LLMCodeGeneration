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
//
// M-8: distinct reason for "monitor unavailable" vs "monitor declined".
// The webview matches on `MONITOR_UNAVAILABLE_TOKEN` to render an
// actionable banner ("Security gate offline — retry / switch model /
// disable security gate for this session"). Using a token rather than
// natural-language matching means the wording can change for users
// without breaking the UI hook.

import type { ToolCall } from '../llm';
import type { PreDispatchHook } from './toolDispatchWithEvents';
import { askSecurityMonitor, askSecurityMonitorVerbose } from '../llmService';
import { evaluateCommand } from './commandDenylist';

/**
 * Token embedded in the `reason` string when the security monitor itself
 * fails (network timeout, malformed response, provider crash). Distinct
 * from the human-readable copy so the webview can match exactly without
 * being broken by future copy changes.
 *
 * Stable wire format: do not rename without coordinating with
 * webview-ui/src/App.tsx security-banner detection.
 */
export const MONITOR_UNAVAILABLE_TOKEN = '__nexus_security_monitor_unavailable__';

/**
 * P0: token embedded in the `reason` string when the static denylist
 * (commandDenylist.ts) blocks a command — distinct from the LLM judge
 * blocking it. Lets the UI and audit log render different copy for
 * "deterministic rule fired" vs "model judgement said no", which
 * matters for debugging: a denylist hit tells you exactly which
 * pattern matched; an LLM hit is a model decision that may need
 * second-guessing.
 *
 * Stable wire format: do not rename without coordinating with
 * webview-ui/src/App.tsx detection (if it grows to differentiate).
 */
export const DENYLIST_TOKEN = '__nexus_command_denylist__';

/**
 * P0: token embedded in the `reason` string when the user declines a
 * command at the confirmation prompt. Distinct from agent/LLM denials
 * so audit logs can attribute blocks correctly. Also lets the chat UI
 * render a softer "you blocked this" message instead of a security-
 * incident banner.
 */
export const USER_REJECTED_TOKEN = '__nexus_user_rejected__';

/**
 * Configuration for the security hook factory.
 *
 *   - `scrutinizeBash`: when true, bash_exec calls are submitted to
 *     askSecurityMonitor. Default: true (defense by default).
 *   - `customAskMonitor`: dependency injection for tests. When
 *     provided, replaces askSecurityMonitor — tests pass scripted
 *     verdicts without an LLM round-trip. Returns true to block.
 *   - `monitorRequired`: when true (default), monitor failures fail
 *     CLOSED — the command is blocked. When false, monitor failures
 *     fail OPEN — the command runs. The default is the safer choice
 *     for shell execution; a deployment that values uptime over
 *     defense-in-depth can flip it. Either way, the failure is
 *     surfaced via `onMonitorError` so the UI can warn the user.
 *   - `onMonitorError`: callback invoked when the monitor itself
 *     errors. The hook still returns its decision (per
 *     `monitorRequired`); this callback is purely for observability,
 *     so the host can post a webview banner asking the user to
 *     retry / switch model / disable the gate for the session.
 *
 * Adding new fields here is additive; existing call sites don't
 * have to update.
 */
export interface SecurityHookConfig {
    scrutinizeBash?: boolean;
    /** Test-only: replace askSecurityMonitor. Returns true to block. */
    customAskMonitor?: (command: string) => Promise<boolean>;
    /** Default: true (fail-closed). False = fail-open on monitor error. */
    monitorRequired?: boolean;
    /** Observability hook for monitor failures (M-8). */
    onMonitorError?: (info: { command: string; error: unknown }) => void;
    /**
     * P0: prompt the user to approve a command before execution.
     *
     * Called AFTER the static denylist and LLM judge have both passed,
     * so the user only sees commands that have already cleared the
     * automated gates. Returns true to allow the command; false to
     * block.
     *
     * When the callback is absent (default), no UI confirmation runs —
     * preserving legacy behavior for CLI / test callers that don't
     * have a webview. SidebarProvider plugs in its own implementation
     * that posts `requestCommandApproval` to the webview and awaits
     * the user's click.
     *
     * Callers can also short-circuit: if `bashAutoApprove` is true on
     * the host (config: nexuscode.bashAutoApprove) or autopilot is
     * active, SidebarProvider returns immediately without prompting.
     * The config-level decision happens at the SidebarProvider layer
     * so the hook itself stays policy-agnostic.
     */
    requestUserConfirmation?: (info: { command: string }) => Promise<boolean>;
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
 *     on any error. We mirror that here when `monitorRequired` is true
 *     (the default), but we also distinguish the reason: blocked due
 *     to monitor *unavailability* vs blocked due to monitor *decline*.
 *     The webview matches on MONITOR_UNAVAILABLE_TOKEN to render an
 *     actionable banner instead of the generic "blocked" pill.
 *
 * Performance:
 *   - The hook adds one LLM round-trip per bash_exec call. The
 *     security monitor uses a small/cheap model in practice; latency
 *     is acceptable. If a customer doesn't want this overhead, they
 *     can pass `scrutinizeBash: false` to disable.
 */
export function buildSecurityHook(config?: SecurityHookConfig): PreDispatchHook {
    const scrutinize = config?.scrutinizeBash ?? true;
    const customAsk = config?.customAskMonitor;
    const monitorRequired = config?.monitorRequired ?? true;
    const onMonitorError = config?.onMonitorError;
    const requestUserConfirmation = config?.requestUserConfirmation;

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

        // P0 audit fix: STATIC DENYLIST runs first.
        //
        // Before any model round-trip, a deterministic regex check
        // catches catastrophic patterns (rm -rf /, fork bomb, curl|sh,
        // etc.). Two reasons this layer matters:
        //
        //   1. It's prompt-injection-proof. An adversarial input that
        //      manipulates the agent into emitting a destructive
        //      command can't reason its way past a regex; even if the
        //      same input would also subvert the LLM judge (plausible
        //      under adversarial pressure), the denylist still fires.
        //
        //   2. It's deterministic and auditable. A security review can
        //      read commandDenylist.ts end-to-end and reason about the
        //      blast radius — no opaque model behavior involved.
        //
        // Cost: a handful of regex tests against the command string;
        // microseconds. Far cheaper than a model call.
        const denylistVerdict = evaluateCommand(command);
        if (denylistVerdict.kind === 'deny') {
            return {
                blocked: true,
                reason: `${DENYLIST_TOKEN} ${denylistVerdict.reason} (rule: ${denylistVerdict.pattern})`
            };
        }

        // Distinguish "monitor said block" from "monitor crashed".
        //
        // - If a customAskMonitor is provided (test path), keep the
        //   legacy boolean contract: `true` = block, errors are catch'd
        //   here and treated as monitor-failure.
        // - Otherwise (production path), use askSecurityMonitorVerbose
        //   which lets failures throw, so we can render the actionable
        //   banner instead of a generic "blocked" pill.
        let outcome: { kind: 'allow' } | { kind: 'deny'; reason: string };
        let monitorFailed = false;
        let monitorError: unknown;

        try {
            if (customAsk) {
                const blocked = await customAsk(command);
                outcome = blocked
                    ? { kind: 'deny', reason: 'Security Monitor declined the command.' }
                    : { kind: 'allow' };
            } else {
                outcome = await askSecurityMonitorVerbose(command);
            }
        } catch (e) {
            monitorFailed = true;
            monitorError = e;
            // Set a placeholder outcome — won't be used (we branch on
            // monitorFailed first), but keeps TS happy.
            outcome = { kind: 'deny', reason: '' };
        }

        if (monitorFailed) {
            // Surface the failure for the UI banner regardless of
            // fail-open/fail-closed choice.
            if (onMonitorError) {
                try {
                    onMonitorError({ command, error: monitorError });
                } catch {
                    // Observability hook is purely informational —
                    // never let it crash the dispatch path.
                }
            }
            if (!monitorRequired) {
                // Fail-open: monitor unreachable, but caller has
                // explicitly accepted that risk. Allow the command.
                return { blocked: false };
            }
            // Fail-closed (default): block, with a token the webview
            // can detect for the actionable banner.
            return {
                blocked: true,
                reason: `${MONITOR_UNAVAILABLE_TOKEN} Security Monitor unavailable — command blocked. Retry, switch model, or disable the security gate for this session.`
            };
        }

        if (outcome.kind === 'deny') {
            return {
                blocked: true,
                reason: `Security Monitor blocked the command: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`
            };
        }

        // P0 audit fix: USER CONFIRMATION runs last, after both static
        // and LLM gates have approved. The user is the final authority —
        // even a command the agent's models think is safe still
        // requires explicit human consent by default.
        //
        // Layering: this gate is opt-in via the requestUserConfirmation
        // callback. CLI / test callers that don't have a UI surface
        // simply don't pass the callback, and we proceed without
        // prompting. SidebarProvider is the production caller and
        // wires its own approval prompt that posts requestCommandApproval
        // to the webview (existing UI pattern, just generalized).
        //
        // Why after the LLM judge: saves user attention. Commands the
        // automated gates would block anyway never reach the user.
        // The user only sees borderline-but-OK commands, which is the
        // signal-to-noise ratio we want.
        if (requestUserConfirmation) {
            let approved = false;
            try {
                approved = await requestUserConfirmation({ command });
            } catch (e) {
                // If the confirmation prompt itself errors, fail-closed:
                // we don't want a flaky UI to silently allow execution.
                return {
                    blocked: true,
                    reason: `User-confirmation prompt failed: ${e instanceof Error ? e.message : String(e)}`
                };
            }
            if (!approved) {
                return {
                    blocked: true,
                    reason: USER_REJECTED_TOKEN + ' User declined to run the command.'
                };
            }
        }

        return { blocked: false };
    };
}

// Re-export the legacy boolean monitor so existing imports
// (`askSecurityMonitor`) elsewhere keep working unchanged. The verbose
// variant is the new internal path; the legacy one remains as the
// stable public contract.
export { askSecurityMonitor };

/**
 * Allow-all hook. For tests, planAgent (read-only tools), and any
 * caller that explicitly wants to bypass policy. Tests for the
 * dispatch wrapper use this as the no-op baseline.
 */
export const allowAllHook: PreDispatchHook = async () => ({ blocked: false });