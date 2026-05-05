// webview-ui/src/components/ui/Switch.tsx
//
// Toggle switch. Wraps Radix Switch primitive — accessibility,
// keyboard nav, and ARIA come from there. We only style.

import { forwardRef } from 'react';
import { Switch as RadixSwitch } from 'radix-ui';
import { cn } from './cn';

export interface SwitchProps extends Omit<React.ComponentPropsWithoutRef<typeof RadixSwitch.Root>, 'asChild'> {
    /** Optional label rendered to the left of the switch. */
    label?: string;
}

export const Switch = forwardRef<
    React.ElementRef<typeof RadixSwitch.Root>,
    SwitchProps
>(function Switch({ className, label, id, ...rest }, ref) {
    const switchEl = (
        <RadixSwitch.Root
            ref={ref}
            id={id}
            className={cn(
                'relative inline-flex items-center',
                'h-4 w-7 shrink-0',
                'rounded-full border outline-none cursor-pointer',
                'transition-colors duration-(--animate-duration-base)',
                'bg-surface-sunken border-border-default',
                'data-[state=checked]:bg-accent data-[state=checked]:border-accent',
                'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                className
            )}
            {...rest}
        >
            <RadixSwitch.Thumb
                className={cn(
                    'block h-3 w-3 rounded-full',
                    'bg-text-tertiary',
                    'transition-transform duration-(--animate-duration-base)',
                    'translate-x-0.5',
                    'data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-white'
                )}
            />
        </RadixSwitch.Root>
    );

    if (!label) { return switchEl; }
    return (
        <label htmlFor={id} className="inline-flex items-center gap-2 cursor-pointer text-sm text-text-primary">
            {switchEl}
            <span>{label}</span>
        </label>
    );
});