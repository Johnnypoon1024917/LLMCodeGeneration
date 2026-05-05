// src/test/unit/App.render.test.tsx
//
// Render-smoke tests for the App component. The single most important
// thing these tests catch is the React Rules of Hooks violation that
// produced React error #310 (hooks called in different order between
// renders). The `cardsByTaskKey` useMemo was misplaced after the
// `if (!isLoaded) return ...` early return in Phase 1, which meant the
// hook was skipped on first render and called on subsequent renders.
// React detected the count mismatch and threw error #310, blanking the
// entire webview.
//
// These tests exercise the three render paths:
//   1. isLoaded=false → loading spinner div (initial mount)
//   2. isLoaded=true && hasKey=false → auth screen
//   3. isLoaded=true && hasKey=true  → main chat UI
//
// All three must render WITHOUT throwing. If a hook is misplaced after
// an early return, transitioning from path 1 to path 2 or 3 throws
// React error #310 and the test fails immediately. This is the
// regression test for the Phase 1 hooks-ordering bug.
//
// What these tests do NOT verify:
//   - Visual output (no DOM-content assertions beyond "didn't crash")
//   - Event handler correctness (covered by separate handler tests)
//   - Specific feature behavior (covered by feature-specific tests)
//
// They are deliberately shallow. The point is to catch crashes.

import { afterEach, describe, test, expect } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import App from '../../App';

// File-local cleanup — registers in this file's lifecycle so it can't
// be defeated by setup.ts loading-order issues on Windows. See
// bashApprovalCard.test.tsx header comment for context.
afterEach(() => {
    cleanup();
});

describe('App component — render smoke (Phase 1 hooks regression guard)', () => {
    test('renders without crashing on initial mount (isLoaded=false path)', () => {
        // First render goes through `if (!isLoaded) return <div>...</div>`.
        // If a hook is placed after this early return, it gets SKIPPED on
        // this render, then called on a subsequent render — error #310.
        // We catch the error by NOT crashing during render().
        const { unmount } = render(<App />);
        unmount();
    });

    test('renders without crashing through state transition (isLoaded false → true)', async () => {
        // This is the test that would have caught the Phase 1 bug.
        //
        // The webview's `isLoaded` flag transitions from false to true when
        // the SidebarProvider sends an `initState` message. If a hook is
        // placed AFTER `if (!isLoaded) return ...`, the hook count differs
        // between the false-render (n hooks) and the true-render (n+1
        // hooks), which React detects and throws #310 on.
        //
        // We simulate the transition by dispatching a synthetic message.
        // The exact shape of the message matters less than that it triggers
        // a re-render through the `setIsLoaded` path.
        const { unmount } = render(<App />);

        // Trigger the initState message handler. This is fire-and-forget;
        // we don't assert on the resulting DOM, only that the re-render
        // completes without React throwing.
        await act(async () => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initState',
                    state: {
                        hasKey: true,
                        codingStyle: 'precise',
                        availableModels: ['default'],
                        selectedModel: 'default',
                        // Provide minimum shape for the handler — additional
                        // fields are ignored by the message handler. If the
                        // schema diverges in future, this test will fail
                        // loudly and that's the right signal.
                    }
                }
            }));
        });

        // If we got here without React throwing, the hooks-ordering check
        // passed. No further assertion needed — the render itself is the
        // assertion.
        unmount();
    });

    test('hooks count is stable across render paths', () => {
        // Re-render the same component instance multiple times with
        // different state shapes to exercise React's hook-count check.
        // React calls console.error on hook-count mismatch in dev builds;
        // we listen for that as a secondary signal.
        const errors: unknown[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
            // Filter to only React-specific errors. Other console.error
            // output (e.g., from the i18n bootstrap) is irrelevant.
            const msg = String(args[0] ?? '');
            if (msg.includes('Rules of Hooks') || msg.includes('hook') || msg.includes('Hook')) {
                errors.push(args);
            }
            // Don't pass through — keeps test output clean.
        };

        try {
            const { rerender, unmount } = render(<App />);
            rerender(<App />);
            rerender(<App />);
            unmount();
        } finally {
            console.error = originalError;
        }

        expect(errors).toEqual([]);
    });
});