// webview-ui/src/test/unit/bashApprovalCard.test.tsx
//
// Smoke tests for the PR 2.3 BashApprovalCard component. Covers:
//   1. Renders the verbatim command string (no truncation, no escaping)
//   2. The three buttons fire onRespond with the correct mode
//   3. Both verdict pills (denylist + monitor) render in the header
//   4. The card has role="alert" for screen readers
//
// Test isolation strategy:
//   We register `afterEach(cleanup)` IN THIS TEST FILE rather than
//   relying on the global setup.ts hook. The global hook works on
//   most environments but exhibited inconsistent behavior on Windows
//   during PR 2.3 — symptoms looked like cleanup wasn't firing at all,
//   so DOM accumulated across tests and `screen.getByRole('button',
//   { name: /block/i })` would find N copies of "Block" by the Nth
//   test. Registering cleanup at the file level (where the imports
//   are guaranteed bound by the time the describe() block evaluates)
//   makes the lifecycle reliable everywhere.
//
//   On top of that, every `render()` destructures `{ container }` and
//   queries scope through `within(container)`. That way, even if some
//   future change accidentally breaks the cleanup hook, queries can't
//   see DOM from prior renders — they'd just fail to find what they're
//   looking for instead of finding too many.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { BashApprovalCard } from '../../views/workspace/BashApprovalCard';

// File-local cleanup hook. See header comment for the rationale.
afterEach(() => {
    cleanup();
});

describe('BashApprovalCard — smoke', () => {
    it('renders the command verbatim without truncation', () => {
        const cmd = 'find . -name "*.py" -exec grep -l "import os" {} \\;';
        const { container } = render(
            <BashApprovalCard command={cmd} onRespond={() => {}} />
        );
        expect(within(container).getByText(cmd)).toBeInTheDocument();
    });

    it('preserves shell metachars without HTML escaping', () => {
        const cmd = 'echo "<script>" > /tmp/x && echo done';
        const { container } = render(
            <BashApprovalCard command={cmd} onRespond={() => {}} />
        );
        expect(within(container).getByText(cmd)).toBeInTheDocument();
    });

    it('Block button fires onRespond with mode="block"', () => {
        const onRespond = vi.fn();
        const { container } = render(
            <BashApprovalCard command="rm /tmp/x" onRespond={onRespond} />
        );
        const btn = within(container).getByRole('button', { name: /block/i });
        fireEvent.click(btn);
        expect(onRespond).toHaveBeenCalledTimes(1);
        expect(onRespond).toHaveBeenCalledWith('block');
    });

    it('Allow once button fires onRespond with mode="allow"', () => {
        const onRespond = vi.fn();
        const { container } = render(
            <BashApprovalCard command="ls" onRespond={onRespond} />
        );
        const btn = within(container).getByRole('button', { name: /allow once/i });
        fireEvent.click(btn);
        expect(onRespond).toHaveBeenCalledWith('allow');
    });

    it('Allow for this task button fires onRespond with mode="allow-always"', () => {
        const onRespond = vi.fn();
        const { container } = render(
            <BashApprovalCard command="ls" onRespond={onRespond} />
        );
        const btn = within(container).getByRole('button', {
            name: /allow for this task/i
        });
        fireEvent.click(btn);
        expect(onRespond).toHaveBeenCalledWith('allow-always');
    });

    it('renders both verdict pills (denylist + monitor) in the header', () => {
        const { container } = render(
            <BashApprovalCard command="ls" onRespond={() => {}} />
        );
        expect(container).toHaveTextContent(/denylist/);
        expect(container).toHaveTextContent(/monitor/);
    });

    it('uses role="alert" so screen readers announce the prompt', () => {
        const { container } = render(
            <BashApprovalCard command="ls" onRespond={() => {}} />
        );
        expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    });

    it('renders an empty-string command without crashing', () => {
        // Defensive — shouldn't happen in practice but guards against a
        // protocol bug surfacing as a render crash. The card should still
        // show all three buttons so the user can decide.
        const onRespond = vi.fn();
        const { container } = render(
            <BashApprovalCard command="" onRespond={onRespond} />
        );
        expect(within(container).getByRole('button', { name: /block/i })).toBeInTheDocument();
        expect(within(container).getByRole('button', { name: /allow once/i })).toBeInTheDocument();
        expect(within(container).getByRole('button', { name: /allow for this task/i })).toBeInTheDocument();
    });
});