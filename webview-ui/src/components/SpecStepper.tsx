// webview-ui/src/components/SpecStepper.tsx
//
// Three-phase stepper for the Spec page (Requirements → Design → Tasks).
// Replaces the prior plain-text reqLogs dump ("━━━ Phase 1 of 3 ━━━ \n
// Drafting Agile User Stories...") which was functional but ugly and
// hid errors when generationFailed reverted the UI.
//
// Component is intentionally pure / props-driven so it's trivial to
// unit-test and reuse. State machine lives in the App.tsx parent (it
// already owns isGeneratingReqs/Design/Tasks plus phase approval state)
// — this component just renders.
//
// The error banner is the most important UX win: previous "❌ Error: ..."
// reqStep messages were small and got blown away by generationFailed.
// Now errors stick until the user dismisses or retries.

import React from 'react';
import './SpecStepper.css';

export type PhaseStatus = 'idle' | 'active' | 'completed' | 'error';

export interface SpecStepperPhase {
    /** Phase identifier, e.g. 'requirements' */
    id: 'requirements' | 'design' | 'tasks';
    /** Display label shown under the step circle */
    label: string;
    /** Current state of this phase */
    status: PhaseStatus;
    /** Optional sub-label shown when active (e.g., "Drafting user stories...") */
    activityHint?: string;
}

export interface SpecStepperError {
    phase: 'requirements' | 'design' | 'tasks';
    title: string;
    message: string;
}

interface Props {
    phases: SpecStepperPhase[];
    /** When set, renders an error banner below the stepper */
    error?: SpecStepperError | null;
    /** Called when user clicks "Try again" in the error banner */
    onRetry?: () => void;
    /** Called when user clicks "Dismiss" in the error banner */
    onDismissError?: () => void;
}

export const SpecStepper: React.FC<Props> = ({ phases, error, onRetry, onDismissError }) => {
    return (
        <div className="spec-stepper">
            <div className="spec-stepper__track" role="list" aria-label="Spec generation progress">
                {phases.map((phase, idx) => (
                    <React.Fragment key={phase.id}>
                        <PhaseNode phase={phase} index={idx} />
                        {idx < phases.length - 1 && (
                            <PhaseConnector
                                fromStatus={phase.status}
                                toStatus={phases[idx + 1]?.status ?? 'idle'}
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>

            {error && (
                <div className="spec-stepper__error" role="alert">
                    <div className="spec-stepper__error-icon" aria-hidden="true">⚠</div>
                    <div className="spec-stepper__error-body">
                        <div className="spec-stepper__error-title">{error.title}</div>
                        <div className="spec-stepper__error-message">{error.message}</div>
                    </div>
                    <div className="spec-stepper__error-actions">
                        {onRetry && (
                            <button
                                type="button"
                                className="spec-stepper__btn spec-stepper__btn--primary"
                                onClick={onRetry}
                            >
                                Try again
                            </button>
                        )}
                        {onDismissError && (
                            <button
                                type="button"
                                className="spec-stepper__btn"
                                onClick={onDismissError}
                                aria-label="Dismiss error"
                            >
                                Dismiss
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

interface PhaseNodeProps {
    phase: SpecStepperPhase;
    index: number;
}

const PhaseNode: React.FC<PhaseNodeProps> = ({ phase, index }) => {
    const statusClass = `spec-stepper__node--${phase.status}`;
    return (
        <div
            className={`spec-stepper__node ${statusClass}`}
            role="listitem"
            aria-label={`${phase.label} — ${phase.status}`}
        >
            <div className="spec-stepper__circle">
                {phase.status === 'completed' && <CheckmarkIcon />}
                {phase.status === 'error' && <ErrorIcon />}
                {phase.status === 'active' && <Spinner />}
                {phase.status === 'idle' && (
                    <span className="spec-stepper__index">{index + 1}</span>
                )}
            </div>
            <div className="spec-stepper__label">{phase.label}</div>
            {phase.status === 'active' && phase.activityHint && (
                <div className="spec-stepper__hint">{phase.activityHint}</div>
            )}
        </div>
    );
};

interface PhaseConnectorProps {
    fromStatus: PhaseStatus;
    toStatus: PhaseStatus;
}

const PhaseConnector: React.FC<PhaseConnectorProps> = ({ fromStatus, toStatus }) => {
    // Connector is "lit" (filled) when the upstream phase is complete
    // AND the downstream phase has at least started. Otherwise it's
    // a thin gray line. This gives a subtle progress sense without
    // being noisy.
    const lit = fromStatus === 'completed' && toStatus !== 'idle';
    return (
        <div
            className={`spec-stepper__connector ${lit ? 'spec-stepper__connector--lit' : ''}`}
            aria-hidden="true"
        />
    );
};

// ─── Icons ────────────────────────────────────────────────────────────
// Inlined SVG so the component has zero external icon dependencies.
// Keeps bundle size honest and avoids "icon library not found" surprises
// when the webview is loaded under restrictive CSP.

const CheckmarkIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const ErrorIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const Spinner: React.FC = () => (
    <div className="spec-stepper__spinner" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2 a 10 10 0 0 1 10 10" />
        </svg>
    </div>
);