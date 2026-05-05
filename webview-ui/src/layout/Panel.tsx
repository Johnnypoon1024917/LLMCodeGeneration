// webview-ui/src/layout/Panel.tsx
//
// Right-side panel chrome. Renders a fixed-width column with:
//   - Header: title + optional actions + close button
//   - Body: scrollable content area
//
// Used by AppShell's panel slot (which handles the grid template
// that gives this column its width and full-height behavior). When
// `usePanel.isOpen` is false, AppShell doesn't render the panel slot
// at all — this component just renders content; it doesn't manage
// its own visibility.
//
// PR 2.4 ships this with the AuditLogPanel as its content. Future PRs
// will reuse the same Panel chrome with HooksPanel (PR 3.2) and
// SteeringPanel (PR 3.3) — same chrome, different content.

import { X as IconClose } from 'lucide-react';
import { IconButton } from '../components/ui/IconButton';
import { ScrollArea } from '../components/ui/ScrollArea';
import { cn } from '../components/ui/cn';

export interface PanelProps {
    /** Heading shown in the panel header. */
    title: string;
    /** Optional subtitle/meta line under the title. Right now used for
     *  things like "234 entries · chain valid". */
    subtitle?: string;
    /** Optional actions rendered in the header to the left of the close
     *  button. Examples: a refresh button, a filter toggle. */
    actions?: React.ReactNode;
    /** Called when the user clicks the close (X) button. Parent should
     *  flip its `usePanel` state. */
    onClose: () => void;
    /** Panel body content. Rendered inside a ScrollArea so long content
     *  doesn't blow out the layout. */
    children: React.ReactNode;
    /** ARIA label for the close button — defaults to "Close panel". */
    closeLabel?: string;
}

export function Panel({
    title,
    subtitle,
    actions,
    onClose,
    children,
    closeLabel = 'Close panel'
}: PanelProps) {
    return (
        <aside
            // role="complementary" tells screen readers this is a side
            // region that's tangentially related to the main content —
            // exactly right for an audit log, hooks library, or
            // steering rules panel.
            role="complementary"
            aria-label={title}
            className={cn(
                'flex flex-col h-full',
                'bg-surface-base border-l border-border-default',
                'min-w-0' // grid column shouldn't overflow if content is wide
            )}
        >
            <header
                className={cn(
                    'flex items-center gap-2',
                    'px-3 py-2.5',
                    'border-b border-border-subtle',
                    'shrink-0'
                )}
            >
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span className="text-sm font-medium text-text-primary truncate">
                        {title}
                    </span>
                    {subtitle && (
                        <span className="text-xs text-text-tertiary truncate">
                            {subtitle}
                        </span>
                    )}
                </div>
                {actions && (
                    <div className="flex items-center gap-1 shrink-0">
                        {actions}
                    </div>
                )}
                <IconButton
                    aria-label={closeLabel}
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                >
                    <IconClose size={14} />
                </IconButton>
            </header>
            <ScrollArea className="flex-1 min-h-0">
                {children}
            </ScrollArea>
        </aside>
    );
}