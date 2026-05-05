// webview-ui/src/views/specs/EarsHelper.tsx
//
// EARS (Easy Approach to Requirements Syntax) keyword helper.
//
// The 5 keywords are:
//   - WHEN <event>, THE SYSTEM SHALL <response>           (event-driven)
//   - IF <condition>, THEN THE SYSTEM SHALL <response>    (state-driven)
//   - WHILE <state>, THE SYSTEM SHALL <response>          (state-driven, ongoing)
//   - WHERE <feature>, THE SYSTEM SHALL <response>        (feature-conditional)
//   - THE SYSTEM SHALL <response>                          (ubiquitous)
//
// Convention: EARS keywords are kept in UPPERCASE ENGLISH in every
// locale, including zh-CN. This is a deliberate choice — the redesign
// mockup convention follows the original NASA EARS spec, and
// compliance auditors familiar with the syntax expect the English
// keywords as anchors for grep + automation tools. The surrounding
// prose can be in any language; only the keywords are fixed.
//
// Why a button bar (not a dropdown):
//   The five keywords each cover distinct requirement classes. A
//   dropdown would hide them; a row of buttons makes the choice
//   visible and one-click. Compliance officers writing requirements
//   benefit from seeing all options at once.

import { useTranslation } from 'react-i18next';
import { Info as IconInfo } from 'lucide-react';
import { Tooltip } from '../../components/ui/Tooltip';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';

/** The 5 EARS patterns. Order intentional — most-common first. */
export const EARS_KEYWORDS = [
    'WHEN',
    'IF',
    'WHILE',
    'WHERE',
    'THE SYSTEM SHALL'
] as const;

export type EarsKeyword = typeof EARS_KEYWORDS[number];

/** Snippet inserted when each keyword is chosen. The convention
 *  is that the keyword goes UPPERCASE on its own line, ready for the
 *  user to fill in the predicate. */
const EARS_SNIPPETS: Record<EarsKeyword, string> = {
    'WHEN':              'WHEN ',
    'IF':                'IF ',
    'WHILE':             'WHILE ',
    'WHERE':             'WHERE ',
    'THE SYSTEM SHALL':  'THE SYSTEM SHALL '
};

/** Tooltip help text for each keyword. Brief — full reference is one
 *  click away via the help link. */
const EARS_TOOLTIPS: Record<EarsKeyword, string> = {
    'WHEN':              'Event-driven: WHEN <event>, THE SYSTEM SHALL <response>',
    'IF':                'State-driven: IF <condition>, THEN THE SYSTEM SHALL <response>',
    'WHILE':             'Ongoing state: WHILE <state>, THE SYSTEM SHALL <response>',
    'WHERE':             'Feature-conditional: WHERE <feature>, THE SYSTEM SHALL <response>',
    'THE SYSTEM SHALL':  'Ubiquitous: THE SYSTEM SHALL <response> (no precondition)'
};

interface EarsHelperProps {
    /** Called when the user clicks a keyword button. Parent should
     *  insert the snippet at the textarea's cursor position. */
    onInsert: (snippet: string) => void;
}

export function EarsHelper({ onInsert }: EarsHelperProps) {
    const { t } = useTranslation();

    return (
        <Tooltip.Provider delayDuration={300}>
            <div
                role="toolbar"
                aria-label={t('specs.ears_toolbar_aria') || 'EARS keyword inserters'}
                className={cn(
                    'flex items-center gap-1.5 flex-wrap',
                    'px-3 py-2',
                    'bg-surface-sunken border-y border-border-subtle'
                )}
            >
                <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-wider mr-1">
                    {t('specs.ears_label') || 'EARS'}
                </span>
                {EARS_KEYWORDS.map((kw) => (
                    <Tooltip.Root key={kw}>
                        <Tooltip.Trigger asChild>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="font-mono text-[10px] tracking-wider"
                                onClick={() => onInsert(EARS_SNIPPETS[kw])}
                            >
                                {kw}
                            </Button>
                        </Tooltip.Trigger>
                        <Tooltip.Content side="bottom">
                            {EARS_TOOLTIPS[kw]}
                        </Tooltip.Content>
                    </Tooltip.Root>
                ))}
                <div className="flex-1" />
                <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                        <span
                            className={cn(
                                'inline-flex items-center gap-1',
                                'text-[10px] text-text-tertiary',
                                'cursor-help select-none'
                            )}
                        >
                            <IconInfo size={11} />
                            {t('specs.ears_about') || 'About EARS'}
                        </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content side="bottom" sideOffset={6}>
                        <span className="block max-w-xs leading-relaxed">
                            {t('specs.ears_explanation') ||
                                'EARS (Easy Approach to Requirements Syntax) is a structured pattern for writing testable requirements. Keywords stay UPPERCASE ENGLISH in every locale to anchor grep + tooling.'}
                        </span>
                    </Tooltip.Content>
                </Tooltip.Root>
            </div>
        </Tooltip.Provider>
    );
}

/** Helper: insert a snippet at the textarea's cursor position.
 *  Encapsulates the cursor math + selection setting so callers don't
 *  need to know the DOM details. Returns the new value the textarea
 *  should be set to and where the cursor should land afterwards. */
export function insertAtCursor(
    textarea: HTMLTextAreaElement,
    snippet: string
): { value: string; cursorPos: number } {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.substring(0, start);
    const after = textarea.value.substring(end);

    // Conventionally, EARS keywords go on their own line. If the user's
    // cursor is mid-line, prepend a newline. If the previous character
    // is already a newline (or it's the start of the file), no newline.
    const needsLeadingNewline =
        before.length > 0 && !before.endsWith('\n');
    const prefix = needsLeadingNewline ? '\n' : '';

    const insertedText = prefix + snippet;
    const newValue = before + insertedText + after;
    const cursorPos = start + insertedText.length;

    return { value: newValue, cursorPos };
}