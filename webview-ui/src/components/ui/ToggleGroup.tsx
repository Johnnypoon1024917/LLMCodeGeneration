// webview-ui/src/components/ui/ToggleGroup.tsx
//
// Multi-button mode switcher (Auto/Plan/Edit on the composer).
// Wraps Radix ToggleGroup — handles roving focus, ARIA, single/multi
// selection. We only style.

import { forwardRef } from 'react';
import { ToggleGroup as RadixToggleGroup } from 'radix-ui';
import { cn } from './cn';

const Root = forwardRef<
    React.ElementRef<typeof RadixToggleGroup.Root>,
    React.ComponentPropsWithoutRef<typeof RadixToggleGroup.Root>
>(function ToggleGroupRoot({ className, ...rest }, ref) {
    return (
        <RadixToggleGroup.Root
            ref={ref}
            className={cn(
                'inline-flex gap-0.5',
                'bg-surface-sunken border border-border-subtle rounded-sm',
                'p-0.5',
                className
            )}
            {...rest}
        />
    );
});

const Item = forwardRef<
    React.ElementRef<typeof RadixToggleGroup.Item>,
    React.ComponentPropsWithoutRef<typeof RadixToggleGroup.Item>
>(function ToggleGroupItem({ className, ...rest }, ref) {
    return (
        <RadixToggleGroup.Item
            ref={ref}
            className={cn(
                'px-2.5 py-1 rounded-xs border-0 bg-transparent',
                'text-xs font-medium text-text-secondary',
                'cursor-pointer outline-none',
                'transition-colors duration-(--animate-duration-fast)',
                'hover:text-text-primary',
                'focus-visible:ring-2 focus-visible:ring-border-focus',
                'data-[state=on]:bg-accent data-[state=on]:text-accent-fg',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                className
            )}
            {...rest}
        />
    );
});

export const ToggleGroup = { Root, Item };