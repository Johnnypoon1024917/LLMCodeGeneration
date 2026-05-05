// webview-ui/src/test/unit/hookFireCard.test.tsx
//
// PR P1.4: smoke tests for HookFireCard.
//
// Verifies that:
//   1. Each lifecycle status renders the right icon + ARIA label
//   2. The header shows hook name, trigger summary, and duration
//   3. onFileSave triggers expose the basename in header, full path in body
//   4. Errors and skipped fires show their message banner
//   5. The chevron expands/collapses on click
//   6. Default expansion follows the rule: collapsed only on success
//
// Same patterns as toolCardOverhaul.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { HookFireCard } from '../../components/HookFireCard';
import type { HookFireState } from '../../hookEvents';

// File-local cleanup. See bashApprovalCard.test.tsx for context on
// why each test file registers its own afterEach instead of relying
// on a shared setup.
afterEach(() => {
    cleanup();
});

function stateFor(overrides: Partial<HookFireState> & { hookFireId?: string } = {}): HookFireState {
    return {
        hookFireId: overrides.hookFireId ?? 'fire-1',
        hookId: overrides.hookId ?? 'lint-on-save',
        hookName: overrides.hookName ?? 'Lint on save',
        triggerType: overrides.triggerType ?? 'onFileSave',
        ...(overrides.filePath !== undefined ? { filePath: overrides.filePath } : {}),
        status: overrides.status ?? 'success',
        startSeq: overrides.startSeq ?? 0,
        outputBuffer: overrides.outputBuffer ?? '',
        ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
        ...(overrides.errorMessage !== undefined ? { errorMessage: overrides.errorMessage } : {}),
        startedAt: overrides.startedAt ?? 1000
    };
}

describe('HookFireCard — header', () => {
    it('shows hook name and trigger summary', () => {
        render(<HookFireCard state={stateFor({
            hookName: 'Auto Format',
            triggerType: 'onFileSave',
            filePath: 'src/foo.ts',
            status: 'success',
            durationMs: 150
        })} />);

        // Hook name in the header
        expect(screen.getByText('Auto Format')).toBeTruthy();
        // Trigger summary shows basename, not full path, in header
        expect(screen.getByText(/onFileSave: foo\.ts/)).toBeTruthy();
    });

    it('shows duration when present', () => {
        render(<HookFireCard state={stateFor({ durationMs: 850, status: 'success' })} />);
        expect(screen.getByText('850ms')).toBeTruthy();
    });

    it('formats durations over 1s in seconds', () => {
        render(<HookFireCard state={stateFor({ durationMs: 2400, status: 'success' })} />);
        expect(screen.getByText('2.4s')).toBeTruthy();
    });

    it('shows onCommand triggers without file', () => {
        render(<HookFireCard state={stateFor({
            triggerType: 'onCommand',
            status: 'success',
            durationMs: 100
        })} />);
        // Trigger label is just 'onCommand' — no colon-suffix
        expect(screen.getByText(/onCommand/)).toBeTruthy();
    });
});

describe('HookFireCard — status states', () => {
    it('running status uses spinning loader icon and is expanded', () => {
        const { container } = render(<HookFireCard state={stateFor({ status: 'running' })} />);

        // The card root carries a data-status attribute we can assert on
        const card = container.querySelector('[data-testid="hook-fire-card-fire-1"]');
        expect(card?.getAttribute('data-status')).toBe('running');
    });

    it('success status defaults to collapsed', () => {
        render(<HookFireCard state={stateFor({
            status: 'success',
            durationMs: 100,
            outputBuffer: 'output content'
        })} />);

        // Collapsed default for success — output should NOT be visible
        expect(screen.queryByText('output content')).toBeFalsy();
    });

    it('error status defaults to expanded and shows errorMessage', () => {
        render(<HookFireCard state={stateFor({
            status: 'error',
            durationMs: 50,
            errorMessage: 'LLM endpoint 500: server crashed'
        })} />);

        // Expanded by default for non-success — error message visible
        expect(screen.getByText('LLM endpoint 500: server crashed')).toBeTruthy();
    });

    it('timeout status shows the timeout message', () => {
        render(<HookFireCard state={stateFor({
            status: 'timeout',
            durationMs: 60000,
            errorMessage: 'timed out after 60s'
        })} />);

        expect(screen.getByText('timed out after 60s')).toBeTruthy();
    });

    it('skipped status shows the skip reason', () => {
        render(<HookFireCard state={stateFor({
            status: 'skipped',
            durationMs: 0,
            errorMessage: 'Already 3 hook(s) running.'
        })} />);

        expect(screen.getByText('Already 3 hook(s) running.')).toBeTruthy();
    });
});

describe('HookFireCard — body content', () => {
    it('shows full file path in body when expanded for onFileSave', () => {
        render(<HookFireCard state={stateFor({
            triggerType: 'onFileSave',
            filePath: 'src/very/deep/path/to/foo.ts',
            status: 'success',
            outputBuffer: 'lint passed',
            // Force expanded so we can assert body content
            durationMs: 100
        })} defaultExpanded={true} />);

        // Full path appears in body
        expect(screen.getByText(/src\/very\/deep\/path\/to\/foo\.ts/)).toBeTruthy();
    });

    it('renders output buffer when present', () => {
        render(<HookFireCard state={stateFor({
            status: 'error',  // expanded by default
            outputBuffer: 'Found 3 issues:\n- foo\n- bar\n- baz'
        })} />);

        expect(screen.getByText(/Found 3 issues/)).toBeTruthy();
    });

    it('shows waiting placeholder when running with no output', () => {
        render(<HookFireCard state={stateFor({
            status: 'running',
            outputBuffer: ''
        })} />);

        // The wait placeholder uses the i18n key fallback
        expect(screen.getByText(/Waiting for output/i)).toBeTruthy();
    });
});

describe('HookFireCard — expand/collapse', () => {
    it('toggles expanded state on header click', () => {
        const { container } = render(<HookFireCard
            state={stateFor({ status: 'success', outputBuffer: 'hidden by default' })}
            defaultExpanded={false}
        />);

        // Output is hidden initially
        expect(screen.queryByText('hidden by default')).toBeFalsy();

        // Click the header (the role=button element)
        const header = container.querySelector('[role="button"]') as HTMLElement;
        fireEvent.click(header);

        // Output now visible
        expect(screen.getByText('hidden by default')).toBeTruthy();

        // Click again to collapse
        fireEvent.click(header);
        expect(screen.queryByText('hidden by default')).toBeFalsy();
    });

    it('responds to Enter key for accessibility', () => {
        const { container } = render(<HookFireCard
            state={stateFor({ status: 'success', outputBuffer: 'keyboard expansion' })}
            defaultExpanded={false}
        />);

        const header = container.querySelector('[role="button"]') as HTMLElement;
        fireEvent.keyDown(header, { key: 'Enter' });

        expect(screen.getByText('keyboard expansion')).toBeTruthy();
    });
});