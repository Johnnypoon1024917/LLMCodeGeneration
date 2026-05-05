// webview-ui/src/components/ui/Tabs.tsx
//
// Tabbed navigation. Wraps Radix Tabs.
//
// Visual: pill-style for the panel header (where space is cramped and
// tabs aren't the page's primary nav). Underline-style isn't used in
// the redesign because the rail is the primary nav; tabs are always
// secondary.
//
// Re-exports Radix's Root, List, Trigger, Content via dot-notation so
// the call site reads the same as raw Radix but with our styling.

import { forwardRef } from 'react';
import { Tabs as RadixTabs } from 'radix-ui';
import { cn } from './cn';

const Root = RadixTabs.Root;

const List = forwardRef<
    React.ElementRef<typeof RadixTabs.List>,
    React.ComponentPropsWithoutRef<typeof RadixTabs.List>
>(function TabsList({ className, ...rest }, ref) {
    return (
        <RadixTabs.List
            ref={ref}
            className={cn('flex items-center gap-0', className)}
            {...rest}
        />
    );
});

const Trigger = forwardRef<
    React.ElementRef<typeof RadixTabs.Trigger>,
    React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(function TabsTrigger({ className, ...rest }, ref) {
    return (
        <RadixTabs.Trigger
            ref={ref}
            className={cn(
                'px-2.5 py-1 rounded-sm border-0 bg-transparent',
                'text-sm font-medium text-text-tertiary',
                'cursor-pointer outline-none',
                'transition-colors duration-(--animate-duration-fast)',
                'hover:text-text-primary',
                'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
                'data-[state=active]:bg-surface-sunken data-[state=active]:text-text-primary',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                className
            )}
            {...rest}
        />
    );
});

const Content = forwardRef<
    React.ElementRef<typeof RadixTabs.Content>,
    React.ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(function TabsContent({ className, ...rest }, ref) {
    return (
        <RadixTabs.Content
            ref={ref}
            className={cn('outline-none', className)}
            {...rest}
        />
    );
});

export const Tabs = { Root, List, Trigger, Content };