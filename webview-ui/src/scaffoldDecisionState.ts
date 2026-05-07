// webview-ui/src/scaffoldDecisionState.ts
//
// V2.1.2b — pure state machine for the scaffold confirmation flow.
//
// The submit-with-scaffold-check sequence is:
//
//   idle
//     ↓ user submits prompt
//   requesting       → posts requestScaffoldDecision, waits
//     ↓ scaffoldDecisionAvailable arrives
//   either (a) NOT greenfield: returns to idle with shouldSubmitOriginal=true
//   or     (b) greenfield: transitions to deciding (dialog open)
//     ↓ user picks template / skips / cancels
//   acknowledging    → posts scaffoldDecisionMade, waits
//     ↓ scaffoldDecisionAcknowledged arrives
//   returns to idle with shouldSubmitOriginal=true
//
// At any "shouldSubmitOriginal=true" terminal, the caller posts the
// captured original payload (the user's PRD prompt or chat message)
// and the chain completes.
//
// This module is pure — no React imports, no DOM, no postMessage.
// The wrapper component owns the timing of postMessage calls and the
// React state. This split keeps the rules (when to dialog, when to
// submit, what to capture) testable without spinning up a webview.

import type { TemplateInfo } from './scaffoldDecisionTypes';

export type ScaffoldDecisionPhase =
    | 'idle'
    | 'requesting'    // posted requestScaffoldDecision, waiting
    | 'deciding'      // dialog open, waiting on user pick
    | 'acknowledging' // posted scaffoldDecisionMade, waiting on ack
    | 'failed';       // host returned applyError; show in dialog

/**
 * Captured original payload — whatever the user was trying to submit.
 * We hold this through the scaffold flow and re-post it once the
 * scaffold flow completes (or is skipped).
 *
 * Typed as `Record<string, unknown>` because the types it spans
 * (generateRequirements, processUserMessage, ...) don't share a
 * common shape; the wrapper just needs to round-trip it untouched.
 */
export type CapturedPayload = Record<string, unknown>;

/**
 * Available templates passed to the dialog. Keep this matching the
 * protocol shape so the component can render straight from the
 * decision-available message.
 */
export interface DecisionAvailable {
    isGreenfield: boolean;
    confidence: 'low' | 'medium' | 'high';
    stackHint?: string;
    templates: TemplateInfo[];
}

export interface ScaffoldDecisionState {
    phase: ScaffoldDecisionPhase;
    /** The user's original payload. Held while we run the scaffold
     *  pre-check; re-posted at the end. Null when phase=idle. */
    capturedPayload: CapturedPayload | null;
    /** Set when phase=deciding. Drives dialog rendering. */
    decision: DecisionAvailable | null;
    /** Last apply error for display. Set when host's ack reports
     *  applyError != null. Null when no error. */
    lastError: string | null;
}

export const initialScaffoldDecisionState: ScaffoldDecisionState = {
    phase: 'idle',
    capturedPayload: null,
    decision: null,
    lastError: null,
};

/**
 * Action type that the wrapper component dispatches to drive the
 * state machine. Each transition has clear pre/post conditions
 * documented inline.
 */
export type ScaffoldDecisionAction =
    /** User submitted a prompt. We capture it and start the
     *  scaffold pre-check. Caller posts requestScaffoldDecision
     *  next using the returned shouldRequestScaffoldCheck flag. */
    | { type: 'userSubmitted'; payload: CapturedPayload }
    /** Host returned the decision data. We classify and either
     *  transition to deciding (greenfield, has templates) or
     *  submit the captured payload directly (not greenfield, no
     *  templates, or other no-go conditions). */
    | { type: 'decisionAvailable'; decision: DecisionAvailable }
    /** User picked from the dialog. Caller posts scaffoldDecisionMade
     *  with the user's choice. */
    | { type: 'userPicked'; action: 'apply' | 'skip' | 'cancel'; templateId: string | null }
    /** Host acknowledged the user's pick. We transition to idle and
     *  caller submits the captured payload (unless action=cancel
     *  and shouldSubmitOriginal is false — see below). */
    | { type: 'decisionAcknowledged'; applyError: string | null }
    /** Reset on top-level error or external clear. */
    | { type: 'reset' };

/**
 * Step output. Tells the wrapper component:
 *   - What the new state is
 *   - Whether to post requestScaffoldDecision now
 *   - Whether to submit the captured payload now (we drove through
 *     the whole flow and it's time to do what the user originally
 *     asked for)
 *
 * The wrapper executes side effects from this output; this module
 * stays pure.
 */
export interface ScaffoldDecisionStep {
    state: ScaffoldDecisionState;
    shouldRequestScaffoldCheck: boolean;
    shouldSubmitOriginal: boolean;
}

/**
 * Apply an action and return the new state + outgoing-effects flags.
 *
 * Decision rules embedded here:
 *   - decisionAvailable + isGreenfield=false → shouldSubmitOriginal,
 *     no dialog. Most common case (existing project).
 *   - decisionAvailable + isGreenfield=true + templates.length=0 →
 *     shouldSubmitOriginal anyway. We have nothing to offer.
 *   - userPicked.action='cancel' → DO NOT submit original. The user
 *     bailed out completely. The wrapper is responsible for clearing
 *     the input box if they want that UX, but the prompt is dropped.
 *   - decisionAcknowledged + applyError → keep payload, transition
 *     to 'failed' with error visible. User can retry from the dialog
 *     or cancel out.
 */
export function reduceScaffoldDecision(
    state: ScaffoldDecisionState,
    action: ScaffoldDecisionAction
): ScaffoldDecisionStep {
    switch (action.type) {
        case 'userSubmitted': {
            // Only valid from idle. If we're mid-flight, the caller
            // shouldn't be submitting — guard against double-submit
            // by ignoring rather than throwing.
            if (state.phase !== 'idle') {
                return {
                    state,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            return {
                state: {
                    phase: 'requesting',
                    capturedPayload: action.payload,
                    decision: null,
                    lastError: null,
                },
                shouldRequestScaffoldCheck: true,
                shouldSubmitOriginal: false,
            };
        }

        case 'decisionAvailable': {
            if (state.phase !== 'requesting') {
                // Stale message arriving after a reset. Ignore.
                return {
                    state,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            const skipDialog =
                !action.decision.isGreenfield ||
                action.decision.templates.length === 0;
            if (skipDialog) {
                // No dialog needed. Submit original immediately.
                return {
                    state: initialScaffoldDecisionState,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: true,
                };
            }
            return {
                state: {
                    phase: 'deciding',
                    capturedPayload: state.capturedPayload,
                    decision: action.decision,
                    lastError: null,
                },
                shouldRequestScaffoldCheck: false,
                shouldSubmitOriginal: false,
            };
        }

        case 'userPicked': {
            if (state.phase !== 'deciding' && state.phase !== 'failed') {
                return {
                    state,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            if (action.action === 'cancel') {
                // User bailed; drop the captured prompt. Caller posts
                // scaffoldDecisionMade with action='cancel' for audit
                // logging but does NOT re-submit the payload.
                return {
                    state: initialScaffoldDecisionState,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            return {
                state: {
                    phase: 'acknowledging',
                    capturedPayload: state.capturedPayload,
                    decision: state.decision,
                    lastError: null,
                },
                shouldRequestScaffoldCheck: false,
                shouldSubmitOriginal: false,
            };
        }

        case 'decisionAcknowledged': {
            if (state.phase !== 'acknowledging') {
                return {
                    state,
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            if (action.applyError !== null) {
                // Apply failed. Keep the payload + show the error in
                // the dialog so the user can retry or cancel.
                return {
                    state: {
                        phase: 'failed',
                        capturedPayload: state.capturedPayload,
                        decision: state.decision,
                        lastError: action.applyError,
                    },
                    shouldRequestScaffoldCheck: false,
                    shouldSubmitOriginal: false,
                };
            }
            // Success path — submit the user's original payload.
            return {
                state: initialScaffoldDecisionState,
                shouldRequestScaffoldCheck: false,
                shouldSubmitOriginal: true,
            };
        }

        case 'reset': {
            return {
                state: initialScaffoldDecisionState,
                shouldRequestScaffoldCheck: false,
                shouldSubmitOriginal: false,
            };
        }
    }
}