// webview-ui/src/components/ui/Card.tsx
//
// Bounded panel surface. Three subcomponents (Header, Body, Footer)
// give a consistent vertical rhythm without forcing every Card to use
// all three. Use just <Card>...</Card> for ad-hoc content.
//
// Variants:
//   default — surface-raised + subtle border. Standard.
//   alert   — accent-tinted border. For prompts that need attention
//             (bash approval, monitor-unavailable banner). Pair with
//             Card.Header for a header strip in the appropriate hue.
//
// Why no shadow variants: shadows on every card is a 2018 design tic.
// Cards are differentiated from the page by border and surface tone.

import { forwardRef } from 'react';
import { cn } from './cn';

type Variant = 'default' | 'alert' | 'danger';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
    default: 'bg-surface-raised border-border-subtle',
    alert:   'bg-surface-raised border-status-pending/45',
    danger:  'bg-surface-raised border-status-blocked/45'
};

const Card = forwardRef<HTMLDivElement, CardProps>(
    function Card({ className, variant = 'default', ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    'rounded-md border overflow-hidden',
                    variantClasses[variant],
                    className
                )}
                {...rest}
            />
        );
    }
);

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
    /** When the parent Card is `alert` or `danger`, the header tints
     *  to match. Otherwise transparent. */
    tint?: 'pending' | 'blocked' | 'secure' | 'info' | 'none';
}

const tintClasses: Record<NonNullable<CardHeaderProps['tint']>, string> = {
    pending: 'bg-status-pending-bg border-status-pending/30',
    blocked: 'bg-status-blocked-bg border-status-blocked/30',
    secure:  'bg-status-secure-bg border-status-secure/25',
    info:    'bg-status-info-bg border-status-info/30',
    none:    'border-border-subtle'
};

const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
    function CardHeader({ className, tint = 'none', ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    'flex items-center gap-2 px-3 py-2.5',
                    'border-b',
                    'text-sm font-medium text-text-primary',
                    tintClasses[tint],
                    className
                )}
                {...rest}
            />
        );
    }
);

const CardBody = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function CardBody({ className, ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn('p-3', className)}
                {...rest}
            />
        );
    }
);

const CardFooter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function CardFooter({ className, ...rest }, ref) {
        return (
            <div
                ref={ref}
                className={cn(
                    'flex items-center justify-end gap-2 px-3 py-2.5',
                    'border-t border-border-subtle',
                    className
                )}
                {...rest}
            />
        );
    }
);

// Compose dot-notation API: <Card.Header>, <Card.Body>, <Card.Footer>.
// Standard Radix-style API that reads naturally at the call site.
const CardCompound = Object.assign(Card, {
    Header: CardHeader,
    Body: CardBody,
    Footer: CardFooter
});

export { CardCompound as Card };