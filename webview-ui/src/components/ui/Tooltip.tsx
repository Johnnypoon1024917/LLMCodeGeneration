// webview-ui/src/components/ui/Tooltip.tsx
//
// Hover-revealed label. Wraps Radix Tooltip.
//
// Standard usage at the call site:
//
//   <Tooltip.Provider delayDuration={200}>
//     <Tooltip.Root>
//       <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
//       <Tooltip.Content side="right">{label}</Tooltip.Content>
//     </Tooltip.Root>
//   </Tooltip.Provider>
//
// The Provider can wrap the entire app to share a single delay; we'll
// add it at AppShell-level in PR 1.3.

import { forwardRef } from 'react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { cn } from './cn';

const Provider = RadixTooltip.Provider;
const Root = RadixTooltip.Root;
const Trigger = RadixTooltip.Trigger;
const Portal = RadixTooltip.Portal;

const Content = forwardRef<
    React.ElementRef<typeof RadixTooltip.Content>,
    React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
    return (
        <RadixTooltip.Portal>
            <RadixTooltip.Content
                ref={ref}
                sideOffset={sideOffset}
                className={cn(
                    'px-2 py-1 rounded-sm',
                    'bg-surface-raised border border-border-subtle',
                    'text-xs text-text-primary shadow-md',
                    'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
                    'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0',
                    className
                )}
                {...rest}
            />
        </RadixTooltip.Portal>
    );
});

export const Tooltip = { Provider, Root, Trigger, Portal, Content };