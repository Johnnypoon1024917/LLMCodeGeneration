// webview-ui/src/components/ui/Input.tsx
//
// Text input. Mono variant for places where users enter file paths,
// glob patterns, command names — anywhere alignment matters and
// proportional fonts hurt readability.

import { forwardRef } from 'react';
import { cn } from './cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    /** When true, renders text in monospace. Use for file paths,
     *  glob patterns, command names. */
    mono?: boolean;
    /** When true, applies error styling (red border, no focus tint). */
    invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    function Input({ className, mono = false, invalid = false, type, ...rest }, ref) {
        return (
            <input
                ref={ref}
                type={type ?? 'text'}
                aria-invalid={invalid || undefined}
                className={cn(
                    'w-full',
                    'bg-surface-sunken text-text-primary placeholder:text-text-tertiary',
                    'border rounded-sm outline-none',
                    'px-2.5 py-1.5 text-sm leading-tight',
                    'transition-colors duration-(--animate-duration-fast)',
                    invalid
                        ? 'border-status-blocked focus:border-status-blocked'
                        : 'border-border-subtle focus:border-border-focus focus:ring-2 focus:ring-accent-soft',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    mono && 'font-mono text-xs',
                    className
                )}
                {...rest}
            />
        );
    }
);