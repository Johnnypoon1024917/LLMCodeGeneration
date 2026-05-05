// webview-ui/src/components/ui/Textarea.tsx
//
// Multiline input. Mono variant for places where users write code-
// like content (hook prompts, command templates).

import { forwardRef } from 'react';
import { cn } from './cn';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    mono?: boolean;
    invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
    function Textarea({ className, mono = false, invalid = false, rows = 4, ...rest }, ref) {
        return (
            <textarea
                ref={ref}
                rows={rows}
                aria-invalid={invalid || undefined}
                className={cn(
                    'w-full block',
                    'bg-surface-sunken text-text-primary placeholder:text-text-tertiary',
                    'border rounded-sm outline-none',
                    'px-2.5 py-1.5 text-sm leading-relaxed',
                    'transition-colors duration-(--animate-duration-fast)',
                    'resize-y',
                    invalid
                        ? 'border-status-blocked focus:border-status-blocked'
                        : 'border-border-subtle focus:border-border-focus focus:ring-2 focus:ring-accent-soft',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    mono && 'font-mono text-xs leading-normal',
                    className
                )}
                {...rest}
            />
        );
    }
);