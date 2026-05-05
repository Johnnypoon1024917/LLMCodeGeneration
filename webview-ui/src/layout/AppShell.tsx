// webview-ui/src/layout/AppShell.tsx
//
// Grid container that hosts the rail, security strip, canvas, and
// (eventually) the right panel.
//
// Why a grid instead of nested flex: the rail spans rows 2 and 3
// (canvas + composer), the security strip spans the right two
// columns when no panel is open, and the panel slot (when open)
// spans rows 2-3. This is exactly the structure CSS Grid was
// designed for; flex would require multiple wrapping divs.
//
// Layout:
//
//   ┌──────┬──────────────────────┬──────────┐
//   │      │  security strip      │ (panel,  │ row 1 (36px)
//   │      ├──────────────────────┤          │
//   │ rail │  canvas (children)   │  Sprint  │ row 2 (1fr)
//   │      ├──────────────────────┤          │
//   │      │  composer slot       │  2.4)    │ row 3 (auto)
//   └──────┴──────────────────────┴──────────┘
//      56px        1fr                380px
//
// Composer slot: PR 1.3 keeps the existing composer rendering inside
// App.tsx by leaving the bottom row empty here. PR 2.x will move the
// composer into a Composer component that fills this slot.
//
// Panel slot: closed in PR 1.3. PR 2.4 wires the audit panel; the
// `hasPanel` prop here just controls whether the third column is
// reserved (380px) or collapsed (0).

import { cn } from '../components/ui';

interface AppShellProps {
    /** The conversation/canvas content. Today: existing per-tab views
     *  from App.tsx. PR 2.x: dedicated views per route. */
    children: React.ReactNode;
    /** Slot for the rail (left). */
    rail: React.ReactNode;
    /** Slot for the security strip (top). */
    securityStrip: React.ReactNode;
    /** Slot for the composer (bottom). Optional in PR 1.3 — App.tsx
     *  still renders its own input area for now. */
    composer?: React.ReactNode;
    /** Optional right panel content (audit log, spec view, etc.).
     *  When undefined, the column collapses. */
    panel?: React.ReactNode;
}

export function AppShell({ children, rail, securityStrip, composer, panel }: AppShellProps) {
    const hasPanel = panel !== undefined;

    return (
        <div
            className={cn(
                'grid h-full',
                'bg-surface-base text-text-primary',
                composer ? 'grid-rows-[36px_1fr_56px]' : 'grid-rows-[36px_1fr]'
            )}
            style={{
                gridTemplateColumns: hasPanel ? '56px 1fr 380px' : '56px 1fr',
                gridTemplateAreas: composer
                    ? hasPanel
                        ? '"rail security panel" "rail canvas panel" "rail composer panel"'
                        : '"rail security" "rail canvas" "rail composer"'
                    : hasPanel
                      ? '"rail security panel" "rail canvas panel"'
                      : '"rail security" "rail canvas"'
            }}
        >
            {rail}
            {securityStrip}

            <main
                style={{ gridArea: 'canvas' }}
                className="overflow-auto min-w-0 min-h-0 flex flex-col"
            >
                {children}
            </main>

            {composer && (
                <div style={{ gridArea: 'composer' }}>
                    {composer}
                </div>
            )}

            {panel && (
                <aside
                    style={{ gridArea: 'panel' }}
                    className="bg-surface-raised border-l border-border-subtle overflow-hidden flex flex-col"
                >
                    {panel}
                </aside>
            )}
        </div>
    );
}