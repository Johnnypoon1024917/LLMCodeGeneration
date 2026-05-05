// webview-ui/src/test/unit/specsViews.test.tsx
//
// Smoke tests for PR 3.1 — PhaseStepper, EarsHelper, insertAtCursor.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { PhaseStepper, type PhaseState } from '../../views/specs/PhaseStepper';
import { EarsHelper, EARS_KEYWORDS, insertAtCursor } from '../../views/specs/EarsHelper';

afterEach(() => {
    cleanup();
});

// ─── PhaseStepper ────────────────────────────────────────────────────

function makeState(overrides: Partial<PhaseState> = {}): PhaseState {
    return {
        requirements: 'not_started',
        design: 'not_started',
        tasks: 'not_started',
        updatedAt: '2026-05-02T10:00:00.000Z',
        ...overrides
    };
}

describe('PhaseStepper', () => {
    it('renders all three phase labels', () => {
        const { container } = render(<PhaseStepper state={makeState()} />);
        // Falls back to English when i18n keys aren't loaded; 'Requirements'
        // / 'Design' / 'Tasks' are the labels for those keys.
        expect(container).toHaveTextContent(/requirements/i);
        expect(container).toHaveTextContent(/design/i);
        expect(container).toHaveTextContent(/tasks/i);
    });

    it('shows status pills for each phase', () => {
        const { container } = render(
            <PhaseStepper
                state={makeState({
                    requirements: 'approved',
                    design: 'draft',
                    tasks: 'not_started'
                })}
            />
        );
        expect(container).toHaveTextContent(/approved/i);
        expect(container).toHaveTextContent(/draft/i);
        expect(container).toHaveTextContent(/not started/i);
    });

    it('exposes role="progressbar" for assistive tech', () => {
        const { container } = render(<PhaseStepper state={makeState()} />);
        expect(container.querySelector('[role="progressbar"]')).toBeInTheDocument();
    });

    it('renders a check icon when a phase is approved', () => {
        const { container } = render(
            <PhaseStepper state={makeState({ requirements: 'approved' })} />
        );
        // The approved check icon comes from lucide; we check by class name
        // since Lucide icons have predictable class names.
        const checkIcons = container.querySelectorAll('.lucide-check');
        // First phase approved → at least one check icon present.
        expect(checkIcons.length).toBeGreaterThanOrEqual(1);
    });

    it('renders step number when a phase is not approved', () => {
        const { container } = render(<PhaseStepper state={makeState()} />);
        // All three phases are not_started, so we should see "1", "2", "3"
        // as step numbers in the circle markers.
        expect(container).toHaveTextContent('1');
        expect(container).toHaveTextContent('2');
        expect(container).toHaveTextContent('3');
    });
});

// ─── EarsHelper ──────────────────────────────────────────────────────

describe('EarsHelper', () => {
    it('renders all 5 EARS keyword buttons', () => {
        const { container } = render(<EarsHelper onInsert={() => {}} />);
        for (const kw of EARS_KEYWORDS) {
            expect(within(container).getByRole('button', { name: kw })).toBeInTheDocument();
        }
    });

    it('clicking a keyword fires onInsert with the matching snippet', () => {
        const onInsert = vi.fn();
        const { container } = render(<EarsHelper onInsert={onInsert} />);
        fireEvent.click(within(container).getByRole('button', { name: 'WHEN' }));
        expect(onInsert).toHaveBeenCalledTimes(1);
        // Snippet ends with a space — keyword + space, ready for the user
        // to type the predicate.
        expect(onInsert).toHaveBeenCalledWith('WHEN ');
    });

    it('THE SYSTEM SHALL keyword inserts the full ubiquitous template', () => {
        const onInsert = vi.fn();
        const { container } = render(<EarsHelper onInsert={onInsert} />);
        fireEvent.click(within(container).getByRole('button', { name: 'THE SYSTEM SHALL' }));
        expect(onInsert).toHaveBeenCalledWith('THE SYSTEM SHALL ');
    });

    it('uses role="toolbar" for the keyword button group', () => {
        const { container } = render(<EarsHelper onInsert={() => {}} />);
        expect(container.querySelector('[role="toolbar"]')).toBeInTheDocument();
    });
});

// ─── insertAtCursor helper ───────────────────────────────────────────

describe('insertAtCursor', () => {
    function makeTextarea(value: string, selectionStart: number, selectionEnd?: number): HTMLTextAreaElement {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.selectionStart = selectionStart;
        ta.selectionEnd = selectionEnd ?? selectionStart;
        return ta;
    }

    it('inserts at the cursor in an empty textarea', () => {
        const ta = makeTextarea('', 0);
        const { value, cursorPos } = insertAtCursor(ta, 'WHEN ');
        expect(value).toBe('WHEN ');
        expect(cursorPos).toBe(5);
    });

    it('replaces a selected range', () => {
        const ta = makeTextarea('foo BAD bar', 4, 7);
        const { value, cursorPos } = insertAtCursor(ta, 'IF ');
        // 'foo ' + 'IF ' + ' bar' — but we also need to consider the
        // leading-newline rule. After 'foo ' (no newline), the helper
        // PREPENDS \n. So the result is 'foo \nIF  bar'.
        expect(value).toBe('foo \nIF  bar');
        // cursor lands right after the inserted snippet.
        expect(cursorPos).toBe('foo \nIF '.length);
    });

    it('does not prepend newline at the start of the textarea', () => {
        const ta = makeTextarea('', 0);
        const { value } = insertAtCursor(ta, 'WHEN ');
        expect(value).toBe('WHEN ');  // no leading \n
    });

    it('does not prepend newline when previous char is already a newline', () => {
        const ta = makeTextarea('first line\n', 11);
        const { value } = insertAtCursor(ta, 'WHEN ');
        expect(value).toBe('first line\nWHEN ');  // single \n, not double
    });

    it('prepends newline when inserting mid-line', () => {
        const ta = makeTextarea('mid line', 4);
        const { value } = insertAtCursor(ta, 'WHEN ');
        expect(value).toBe('mid \nWHEN line');
    });
});