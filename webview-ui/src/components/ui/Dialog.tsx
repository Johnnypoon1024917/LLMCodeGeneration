// webview-ui/src/components/ui/Dialog.tsx
//
// Modal dialog. Wraps Radix Dialog.
//
// Standard usage:
//
//   <Dialog.Root>
//     <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
//     <Dialog.Portal>
//       <Dialog.Overlay />
//       <Dialog.Content>
//         <Dialog.Title>Settings</Dialog.Title>
//         <Dialog.Description>...</Dialog.Description>
//         {body}
//       </Dialog.Content>
//     </Dialog.Portal>
//   </Dialog.Root>

import { forwardRef } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { cn } from './cn';

const Root = RadixDialog.Root;
const Trigger = RadixDialog.Trigger;
const Portal = RadixDialog.Portal;
const Close = RadixDialog.Close;

const Overlay = forwardRef<
    React.ElementRef<typeof RadixDialog.Overlay>,
    React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function DialogOverlay({ className, ...rest }, ref) {
    return (
        <RadixDialog.Overlay
            ref={ref}
            className={cn(
                'fixed inset-0 z-50',
                'bg-surface-overlay backdrop-blur-sm',
                'data-[state=open]:animate-in data-[state=open]:fade-in-0',
                'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
                className
            )}
            {...rest}
        />
    );
});

const Content = forwardRef<
    React.ElementRef<typeof RadixDialog.Content>,
    React.ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(function DialogContent({ className, ...rest }, ref) {
    return (
        <RadixDialog.Content
            ref={ref}
            className={cn(
                'fixed left-1/2 top-1/2 z-50',
                '-translate-x-1/2 -translate-y-1/2',
                'w-full max-w-lg',
                'bg-surface-raised border border-border-default rounded-md shadow-lg',
                'p-4',
                'outline-none',
                'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
                'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
                className
            )}
            {...rest}
        />
    );
});

const Title = forwardRef<
    React.ElementRef<typeof RadixDialog.Title>,
    React.ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DialogTitle({ className, ...rest }, ref) {
    return (
        <RadixDialog.Title
            ref={ref}
            className={cn('text-lg font-medium text-text-primary', className)}
            {...rest}
        />
    );
});

const Description = forwardRef<
    React.ElementRef<typeof RadixDialog.Description>,
    React.ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DialogDescription({ className, ...rest }, ref) {
    return (
        <RadixDialog.Description
            ref={ref}
            className={cn('text-sm text-text-secondary', className)}
            {...rest}
        />
    );
});

export const Dialog = { Root, Trigger, Portal, Close, Overlay, Content, Title, Description };