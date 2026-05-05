// webview-ui/src/components/toolCardBodies/shared.tsx
//
// Shared atoms used by all four body components (Informational,
// Diff, Executable, Network). PR 2.2 introduces these so the visual
// overhaul lands consistently across every body — instead of
// scattering Tailwind utilities through four files, the bodies
// compose these atoms.
//
// Each atom replaces a legacy class:
//   BodyEmpty       ← .tool-call-card-empty
//   BodyError       ← .tool-call-card-error
//   BodyFallbackPre ← .tool-call-card-fallback-output
//   BodyMeta        ← .tool-call-info-meta
//   BodyMetaItem    ← .tool-call-info-meta-item
//   BodyMetaPunct   ← visual divider between meta items (was a literal "·")
//   BodyContainer   ← .tool-call-info-body
//
// The legacy CSS rules can be removed from App.css once no component
// references them. PR 2.2 keeps the rules in App.css for safety;
// Sprint 3's cleanup pass deletes them.

import { AlertCircle as IconAlert } from 'lucide-react';
import { cn } from '../ui/cn';

/** Empty-state placeholder ("Reading…", "(no output)", etc.). */
export function BodyEmpty({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={cn(
                'px-4 py-3',
                'text-xs text-text-tertiary italic'
            )}
        >
            {children}
        </div>
    );
}

/** Error message with icon. Used for any body that surfaces a
 *  result.uiPayload of kind 'error'. */
export function BodyError({ message }: { message: string }) {
    return (
        <div
            className={cn(
                'flex items-start gap-2',
                'px-4 py-3',
                'text-sm text-status-blocked'
            )}
        >
            <IconAlert size={14} className="shrink-0 mt-0.5" />
            <span className="min-w-0 break-words">{message}</span>
        </div>
    );
}

/** Forward-compat fallback: renders unknown payloads as preformatted
 *  text. Used by GenericFallbackBody and as a last-resort branch
 *  inside specific bodies when the payload kind is unexpected. */
export function BodyFallbackPre({ children }: { children: React.ReactNode }) {
    return (
        <pre
            tabIndex={0}
            className={cn(
                'px-4 py-3 m-0',
                'font-mono text-xs leading-relaxed',
                'bg-surface-base text-text-secondary',
                'whitespace-pre-wrap',
                'max-h-50 overflow-y-auto',
                'outline-none focus:ring-1 focus:ring-border-focus focus:ring-inset'
            )}
        >
            {children}
        </pre>
    );
}

/** Container for a body that has a meta header row + content area. */
export function BodyContainer({ children }: { children: React.ReactNode }) {
    return <div className="flex flex-col">{children}</div>;
}

/** Meta header row — "12 lines · 4.2 KB · truncated" style. */
export function BodyMeta({
    children,
    className
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'flex items-center flex-wrap gap-2',
                'px-4 py-2',
                'text-xs text-text-tertiary font-mono',
                'border-b border-border-subtle',
                className
            )}
        >
            {children}
        </div>
    );
}

/** Single meta item, e.g. "12 lines". Keep these as <span> so the
 *  flex/wrap behavior of BodyMeta works correctly. */
export function BodyMetaItem({
    children,
    truncated = false,
    className
}: {
    children: React.ReactNode;
    /** Highlights the item in pending color — used for "truncated"
     *  badges where a non-default state matters. */
    truncated?: boolean;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'whitespace-nowrap',
                truncated && 'text-status-pending',
                className
            )}
        >
            {children}
        </span>
    );
}

/** Visual divider between meta items. Keeps middle dots out of the
 *  meta arrays so they don't get tangled in the data flow. */
export function BodyMetaDivider() {
    return (
        <span aria-hidden="true" className="text-text-tertiary/50">
            ·
        </span>
    );
}