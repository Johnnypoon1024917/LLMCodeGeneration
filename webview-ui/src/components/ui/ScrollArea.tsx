// webview-ui/src/components/ui/ScrollArea.tsx
//
// Custom-scrollbar region. Wraps Radix ScrollArea so we get a
// consistent thin scrollbar on macOS (where native is narrow but
// flush) and Windows (where native is wide and intrusive).
//
// Use for any region that may overflow vertically: audit log,
// tool-card body, conversation thread.

import { forwardRef } from 'react';
import { ScrollArea as RadixScrollArea } from 'radix-ui';
import { cn } from './cn';

export interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof RadixScrollArea.Root> {
    /** Whether to show the horizontal scrollbar. Default: false. */
    horizontal?: boolean;
}

export const ScrollArea = forwardRef<
    React.ElementRef<typeof RadixScrollArea.Root>,
    ScrollAreaProps
>(function ScrollArea({ className, children, horizontal = false, ...rest }, ref) {
    return (
        <RadixScrollArea.Root
            ref={ref}
            className={cn('relative overflow-hidden', className)}
            {...rest}
        >
            <RadixScrollArea.Viewport className="h-full w-full">
                {children}
            </RadixScrollArea.Viewport>
            <RadixScrollArea.Scrollbar
                orientation="vertical"
                className={cn(
                    'flex select-none touch-none p-0.5',
                    'transition-colors duration-(--animate-duration-base)',
                    'w-2'
                )}
            >
                <RadixScrollArea.Thumb
                    className={cn(
                        'relative flex-1 rounded-pill',
                        'bg-text-tertiary/40',
                        'before:absolute before:inset-0',
                        'before:content-[""]',
                        'hover:bg-text-tertiary/60'
                    )}
                />
            </RadixScrollArea.Scrollbar>
            {horizontal && (
                <RadixScrollArea.Scrollbar
                    orientation="horizontal"
                    className={cn(
                        'flex select-none touch-none p-0.5 flex-col',
                        'transition-colors duration-(--animate-duration-base)',
                        'h-2'
                    )}
                >
                    <RadixScrollArea.Thumb
                        className={cn(
                            'relative flex-1 rounded-pill',
                            'bg-text-tertiary/40',
                            'hover:bg-text-tertiary/60'
                        )}
                    />
                </RadixScrollArea.Scrollbar>
            )}
            <RadixScrollArea.Corner />
        </RadixScrollArea.Root>
    );
});