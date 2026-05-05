// webview-ui/src/components/ui/Pill.tsx
//
// Small inline status label. The dot-prefix (showDot) is the canonical
// pattern in the security strip; opt out for inline tags where the dot
// would visually interrupt reading flow (audit-row meta, recent-list
// tags).
//
// The variant ramp mirrors --nx-status-* exactly so semantic meaning
// is consistent across every surface that uses Pill: security strip,
// audit log, recent list, tool cards. Don't reach for these for
// emphasis; reach for them when they mean what they say.

import { forwardRef } from 'react';
import { cn } from './cn';

type Variant = 'secure' | 'pending' | 'blocked' | 'running' | 'info' | 'neutral';

export interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
    variant?: Variant;
    /** When true, prefixes the label with a small colored dot. */
    showDot?: boolean;
    children: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
    secure:  'text-status-secure',
    pending: 'text-status-pending',
    blocked: 'text-status-blocked',
    running: 'text-status-running',
    info:    'text-status-info',
    neutral: 'text-text-tertiary'
};

const variantBgClasses: Record<Variant, string> = {
    secure:  'bg-status-secure-bg',
    pending: 'bg-status-pending-bg',
    blocked: 'bg-status-blocked-bg',
    running: 'bg-status-running-bg',
    info:    'bg-status-info-bg',
    neutral: 'bg-surface-sunken'
};

export const Pill = forwardRef<HTMLSpanElement, PillProps>(
    function Pill({ className, variant = 'neutral', showDot = false, children, ...rest }, ref) {
        return (
            <span
                ref={ref}
                className={cn(
                    'inline-flex items-center gap-1.5',
                    'text-xs font-medium',
                    'px-1.5 py-0.5 rounded-xs',
                    variantClasses[variant],
                    variantBgClasses[variant],
                    className
                )}
                {...rest}
            >
                {showDot && (
                    <span
                        aria-hidden="true"
                        className={cn(
                            'inline-block w-1.5 h-1.5 rounded-full',
                            'bg-current'
                        )}
                    />
                )}
                {children}
            </span>
        );
    }
);