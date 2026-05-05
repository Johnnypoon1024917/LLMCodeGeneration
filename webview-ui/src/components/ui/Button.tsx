// webview-ui/src/components/ui/Button.tsx
//
// Foundational button primitive. Every other interactive primitive in
// the library follows this same shape — forwardRef, asChild via Slot,
// variants composed by cn(), defaultProps via destructuring, full
// HTMLButtonElement prop pass-through.
//
// Variants:
//   primary  — accent background; for the single most important action
//              in a context (Send, Save, Approve)
//   secondary — neutral border; default for "another option"
//   ghost    — transparent; for navigation or muted actions
//   danger   — error-tinted border; for destructive confirmations
//   confirm  — strong accent; for "approve and continue" type actions
//              that the security UX needs distinct from primary
//
// Sizes:
//   sm — 28px tall, used in dense lists and tables
//   md — 32px tall, default for forms and toolbars
//
// asChild: pass a Slot child (link, custom element) instead of <button>
// when you need the visual treatment but a different DOM element.
// Standard Radix pattern — required when wrapping in <a> for routing.

import { forwardRef } from 'react';
import { Slot } from 'radix-ui';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'confirm';
type Size = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
    /** Render as the child element (Radix Slot pattern). Useful for
     *  applying button styling to <a> tags or other elements. */
    asChild?: boolean;
}

// Base classes applied to every variant. Anything related to the
// shape, transition, focus ring, and disabled state lives here so
// adding a new variant doesn't have to re-specify these.
const baseClasses = [
    'inline-flex items-center justify-center gap-1.5',
    'font-medium whitespace-nowrap',
    'rounded-sm border',
    'transition-colors duration-(--animate-duration-fast)',
    'outline-none',
    'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none'
].join(' ');

// Per-variant classes. Note we use design-token classes from the
// @theme bridge — `bg-accent`, `text-text-primary`, `border-border-default`
// — never raw color values. This is the abstraction that lets theme
// switching work without touching components.
const variantClasses: Record<Variant, string> = {
    primary: cn(
        'bg-accent text-accent-fg border-accent',
        'hover:bg-accent-hover hover:border-accent-hover'
    ),
    secondary: cn(
        'bg-transparent text-text-primary border-border-default',
        'hover:bg-surface-sunken hover:border-border-strong'
    ),
    ghost: cn(
        'bg-transparent text-text-secondary border-transparent',
        'hover:bg-surface-sunken hover:text-text-primary'
    ),
    danger: cn(
        'bg-transparent text-status-blocked border-status-blocked/40',
        'hover:bg-status-blocked-bg hover:border-status-blocked'
    ),
    confirm: cn(
        'bg-accent text-accent-fg border-accent',
        'hover:bg-accent-hover hover:border-accent-hover'
    )
};

const sizeClasses: Record<Size, string> = {
    sm: 'h-7 px-2.5 text-xs',
    md: 'h-8 px-3 text-sm'
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    function Button(
        { className, variant = 'secondary', size = 'md', asChild = false, type, ...rest },
        ref
    ) {
        // When asChild is true, we render the child element (passed via
        // children) but apply our styling to it. Slot handles ref
        // forwarding and prop merging. When asChild is false, we render
        // a normal <button>, defaulting type="button" so Buttons inside
        // forms don't accidentally submit (a JS-framework footgun that
        // bites every team eventually).
        const Comp: React.ElementType = asChild ? Slot.Slot : 'button';
        return (
            <Comp
                ref={ref}
                type={asChild ? undefined : (type ?? 'button')}
                className={cn(baseClasses, variantClasses[variant], sizeClasses[size], className)}
                {...rest}
            />
        );
    }
);