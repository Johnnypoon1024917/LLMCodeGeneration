// webview-ui/src/views/specs/PhaseStepper.tsx
//
// Visual stepper for the 3-phase spec-driven workflow:
//
//   Requirements ──→ Design ──→ Tasks
//      [draft]      [not yet]   [not yet]
//
// Each phase shows its status as a small pill. Connector lines between
// phases. The "current" phase (the first non-approved one) gets a
// stronger ring treatment.
//
// Pure render — accepts PhaseState as a prop, fires no actions. Phase
// advancement is driven by the host's spec workflow state machine
// (see SpecManager.ts and the phaseStateUpdated message type). The UI
// is a witness to that state, not a controller.
//
// Why visualize this prominently:
//   The phase-gate workflow is one of NexusCode's core differentiators
//   against generic chat agents. Compliance officers want to see at a
//   glance what's been approved and what hasn't. The stepper is the
//   highest-signal element on the spec view.

import { useTranslation } from 'react-i18next';
import {
    FileText as IconReq,
    Layout as IconDesign,
    ListTodo as IconTasks,
    Check as IconApproved,
    Circle as IconPending
} from 'lucide-react';
import { Pill } from '../../components/ui/Pill';
import { cn } from '../../components/ui/cn';

export type PhaseStatus = 'not_started' | 'draft' | 'approved';

export interface PhaseState {
    requirements: PhaseStatus;
    design: PhaseStatus;
    tasks: PhaseStatus;
    /** Last-update timestamp from the host. Not displayed in the
     *  stepper but useful in tooltips/audit panel. */
    updatedAt: string;
}

interface PhaseStepperProps {
    state: PhaseState;
}

interface PhaseDefinition {
    key: keyof Omit<PhaseState, 'updatedAt'>;
    icon: typeof IconReq;
    labelKey: string;
    fallback: string;
}

const PHASES: readonly PhaseDefinition[] = [
    { key: 'requirements', icon: IconReq,    labelKey: 'specs.phase_requirements', fallback: 'Requirements' },
    { key: 'design',       icon: IconDesign, labelKey: 'specs.phase_design',       fallback: 'Design' },
    { key: 'tasks',        icon: IconTasks,  labelKey: 'specs.phase_tasks',        fallback: 'Tasks' }
];

export function PhaseStepper({ state }: PhaseStepperProps) {
    const { t } = useTranslation();

    // The "current" phase is the first that isn't approved. If all are
    // approved, no phase is highlighted (all show secure pills). If
    // none are started, the first phase is highlighted.
    const currentIndex = PHASES.findIndex((p) => state[p.key] !== 'approved');

    return (
        <div
            role="progressbar"
            aria-label={t('specs.phase_stepper_aria') || 'Spec workflow progress'}
            className={cn(
                'flex items-center gap-3',
                'px-4 py-3',
                'bg-surface-raised border-b border-border-subtle'
            )}
        >
            {PHASES.map((phase, idx) => {
                const status = state[phase.key];
                const isCurrent = idx === currentIndex;
                const Icon = phase.icon;
                return (
                    <div key={phase.key} className="flex items-center gap-3 min-w-0 flex-1">
                        <PhaseNode
                            icon={Icon}
                            label={t(phase.labelKey) || phase.fallback}
                            status={status}
                            isCurrent={isCurrent}
                            stepNumber={idx + 1}
                        />
                        {idx < PHASES.length - 1 && (
                            <Connector
                                completed={status === 'approved'}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ─── phase node ──────────────────────────────────────────────────────

function PhaseNode({
    icon: Icon,
    label,
    status,
    isCurrent,
    stepNumber
}: {
    icon: typeof IconReq;
    label: string;
    status: PhaseStatus;
    isCurrent: boolean;
    stepNumber: number;
}) {
    const { t } = useTranslation();

    return (
        <div className="flex items-center gap-2 min-w-0">
            {/* Circle marker. Approved phases get a check; current phase
                gets a ring; not-yet-reached phases are muted. */}
            <div
                className={cn(
                    'shrink-0 w-7 h-7 rounded-full',
                    'flex items-center justify-center',
                    'border-2',
                    'transition-colors duration-(--animate-duration-fast)',
                    status === 'approved' &&
                        'bg-status-secure-bg border-status-secure text-status-secure',
                    status === 'draft' && isCurrent &&
                        'bg-status-pending-bg border-status-pending text-status-pending',
                    status === 'draft' && !isCurrent &&
                        'bg-surface-base border-status-pending/40 text-status-pending',
                    status === 'not_started' && isCurrent &&
                        'bg-surface-base border-accent text-accent',
                    status === 'not_started' && !isCurrent &&
                        'bg-surface-base border-border-default text-text-tertiary'
                )}
            >
                {status === 'approved' ? (
                    <IconApproved size={14} strokeWidth={2.5} />
                ) : (
                    <span className="font-mono text-xs font-medium">
                        {stepNumber}
                    </span>
                )}
            </div>

            <div className="flex flex-col gap-0.5 min-w-0">
                <span
                    className={cn(
                        'flex items-center gap-1.5',
                        'text-xs font-medium',
                        isCurrent ? 'text-text-primary' : 'text-text-secondary'
                    )}
                >
                    <Icon size={12} className="shrink-0" />
                    <span className="truncate">{label}</span>
                </span>
                <StatusPill status={status} />
            </div>
        </div>
    );
}

function StatusPill({ status }: { status: PhaseStatus }) {
    const { t } = useTranslation();
    if (status === 'approved') {
        return (
            <Pill variant="secure" className="text-[10px] font-mono">
                {t('specs.status_approved') || 'approved'}
            </Pill>
        );
    }
    if (status === 'draft') {
        return (
            <Pill variant="pending" className="text-[10px] font-mono">
                {t('specs.status_draft') || 'draft'}
            </Pill>
        );
    }
    return (
        <Pill variant="neutral" className="text-[10px] font-mono">
            <IconPending size={9} className="mr-1" />
            {t('specs.status_not_started') || 'not started'}
        </Pill>
    );
}

// ─── connector ───────────────────────────────────────────────────────

function Connector({ completed }: { completed: boolean }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                'flex-1 h-px min-w-4',
                completed ? 'bg-status-secure/40' : 'bg-border-subtle'
            )}
        />
    );
}