// webview-ui/src/thinkingModeState.ts
//
// Pure decision logic for the inline thinking-mode toggle.
//
// Three per-agent booleans (planner/coder/verifier) collapse into
// one of three UI states for the inline pill:
//
//   - 'on'     all three agents have thinking ON
//   - 'off'    all three agents have thinking OFF
//   - 'mixed'  some on, some off (set via VS Code settings; the
//              pill shows "Mixed" so the user knows their inline
//              click would override per-agent customization)
//
// The bulk-toggle decision: clicking the pill flips ALL THREE to
// the same value. From 'on' or 'mixed' → all off. From 'off' → all on.
// This is the simple, predictable behavior — the alternative (toggle
// only the flag controlling some derived state) would surprise users
// who set per-agent values in settings.

export type ThinkingState = 'on' | 'off' | 'mixed';

export interface ThinkingModeFlags {
    planner: boolean;
    coder: boolean;
    verifier: boolean;
}

/**
 * Collapse three per-agent flags into a single UI state.
 *
 * Pure — given the same input, returns the same output, no side effects.
 */
export function aggregateThinkingState(flags: ThinkingModeFlags): ThinkingState {
    const { planner, coder, verifier } = flags;
    if (planner && coder && verifier) { return 'on'; }
    if (!planner && !coder && !verifier) { return 'off'; }
    return 'mixed';
}

/**
 * Decide what the bulk-toggle pill click should produce, given the
 * current aggregate state.
 *
 * Rules:
 *   - 'on'    → flip all three OFF
 *   - 'off'   → flip all three ON
 *   - 'mixed' → flip all three OFF (most common user intent: "turn
 *               off all this thinking, I want speed"). The alternative
 *               (mixed → ON) would surprise users who deliberately
 *               turned ONE agent off — clicking the pill would turn
 *               their customization back on. Mixed → OFF is safer:
 *               it's the destructive path either way, but at least
 *               it's the path most users want.
 *
 * Returns the new flags object, ready to send to the host.
 */
export function bulkToggleFromState(current: ThinkingState): ThinkingModeFlags {
    if (current === 'off') {
        return { planner: true, coder: true, verifier: true };
    }
    // 'on' or 'mixed' → off
    return { planner: false, coder: false, verifier: false };
}