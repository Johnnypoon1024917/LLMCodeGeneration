// webview-ui/src/components/ui/IconButton.tsx
//
// Square icon-only button. Distinct from <Button>:
//   - Always square (h-8 w-8 or h-7 w-7)
//   - No text content; aria-label is required
//   - Less padding because there's nothing to flank
//   - Thinner default border (icons need less visual weight)
//
// We don't reuse Button + size:'icon' because the prop matrix gets
// confusing — a separate component reads better at the call site.

import { forwardRef } from 'react';
import { cn } from './cn';

type Variant = 'default' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    /** Required for accessibility — no text content to fall back on. */
    'aria-label': string;
    variant?: Variant;
    size?: Size;
    /** The icon element. Typically a Lucide icon or inline SVG. */
    children: React.ReactNode;
}

const baseClasses = [
    'inline-flex items-center justify-center',
    'rounded-sm border',
    'transition-colors duration-(--animate-duration-fast)',
    'outline-none cursor-pointer',
    'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none'
].join(' ');

const variantClasses: Record<Variant, string> = {
    default: cn(
        'bg-transparent text-text-secondary border-border-subtle',
        'hover:bg-surface-sunken hover:text-text-primary'
    ),
    danger: cn(
        'bg-transparent text-status-blocked border-status-blocked/35',
        'hover:bg-status-blocked-bg'
    ),
    ghost: cn(
        'bg-transparent text-text-secondary border-transparent',
        'hover:bg-surface-sunken hover:text-text-primary'
    )
};

const sizeClasses: Record<Size, string> = {
    sm: 'h-7 w-7 [&>svg]:w-3 [&>svg]:h-3',
    md: 'h-8 w-8 [&>svg]:w-3.5 [&>svg]:h-3.5'
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
    function IconButton({ className, variant = 'default', size = 'md', type, ...rest }, ref) {
        return (
            <button
                ref={ref}
                type={type ?? 'button'}
                className={cn(baseClasses, variantClasses[variant], sizeClasses[size], className)}
                {...rest}
            />
        );
    }
);