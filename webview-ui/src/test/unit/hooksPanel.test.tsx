// webview-ui/src/test/unit/hooksPanel.test.tsx
//
// Smoke tests for PR 3.2 — useHooks state hook, HooksPanel rendering,
// toggle/run/open actions. Same isolation pattern as previous PRs:
// file-local afterEach(cleanup), within(container) scoping.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, act, within } from '@testing-library/react';
import { useHooks, type HookSummary, type UseHooksResult } from '../../state/useHooks';
import { HooksPanel } from '../../views/hooks/HooksPanel';

afterEach(() => {
    cleanup();
});

// ─── helpers ─────────────────────────────────────────────────────────

function makeHook(overrides: Partial<HookSummary> = {}): HookSummary {
    return {
        id: overrides.id ?? 'lint-on-save',
        name: overrides.name ?? 'Lint on save',
        enabled: overrides.enabled ?? true,
        triggerSummary: overrides.triggerSummary ?? 'on save: src/**/*.ts',
        triggerType: overrides.triggerType ?? 'onFileSave',
        inflight: overrides.inflight ?? false,
        ...(overrides.description !== undefined ? { description: overrides.description } : {}),
        ...(overrides.lastFiredAt !== undefined ? { lastFiredAt: overrides.lastFiredAt } : {})
    };
}

interface FakeVscode {
    postMessage: ReturnType<typeof vi.fn>;
}

function makeFakeVscode(): FakeVscode {
    return { postMessage: vi.fn() };
}

/** Type-cast helper: vi.fn() produces a Mock<...> which doesn't
 *  structurally match the (message) => void bridge signature, so we
 *  cast through unknown. The test still verifies behavior through
 *  toHaveBeenCalledWith(); typing is just to satisfy useHooks's
 *  parameter type. */
function asBridge(fake: FakeVscode): { postMessage: (message: { type: string; [k: string]: unknown }) => void } {
    return fake as unknown as { postMessage: (message: { type: string; [k: string]: unknown }) => void };
}

// ─── useHooks ────────────────────────────────────────────────────────

describe('useHooks', () => {
    it('starts in loading state with empty list', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        expect(result.current.loading).toBe(true);
        expect(result.current.hooks).toEqual([]);
    });

    it('posts requestHookList on mount', () => {
        const vscode = makeFakeVscode();
        renderHook(() => useHooks(asBridge(vscode)));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'requestHookList' });
    });

    it('responds to hookListUpdated messages', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        const hook = makeHook({ id: 'lint', name: 'Lint hook' });
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'hookListUpdated', hooks: [hook] }
                })
            );
        });
        expect(result.current.loading).toBe(false);
        expect(result.current.hooks).toHaveLength(1);
        expect(result.current.hooks[0]?.id).toBe('lint');
    });

    it('drops malformed hook entries from the payload', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'hookListUpdated',
                        hooks: [
                            makeHook({ id: 'good' }),
                            null,
                            'not-an-object',
                            { id: 'missing-fields' }, // missing required fields
                            makeHook({ id: 'good2', triggerType: 'onSchedule' })
                        ]
                    }
                })
            );
        });
        // Only the two well-formed hooks survived.
        expect(result.current.hooks).toHaveLength(2);
        expect(result.current.hooks.map((h) => h.id)).toEqual(['good', 'good2']);
    });

    it('rejects unknown triggerType values', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'hookListUpdated',
                        hooks: [
                            { ...makeHook(), triggerType: 'onMagic' as unknown as 'onFileSave' }
                        ]
                    }
                })
            );
        });
        expect(result.current.hooks).toEqual([]);
    });

    it('toggleHook posts the right message', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        act(() => result.current.toggleHook('lint', false));
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: 'toggleHook',
            id: 'lint',
            enabled: false
        });
    });

    it('runHook posts the right message and marks inflight', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        // Seed with one hook so we can observe inflight flip
        act(() => result.current.setHooksForTest([makeHook({ id: 'lint' })]));
        act(() => result.current.runHook('lint'));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'runHook', id: 'lint' });
        expect(result.current.hooks[0]?.inflight).toBe(true);
    });

    it('ignores unrelated messages', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useHooks(asBridge(vscode)));
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', { data: { type: 'unrelated' } })
            );
        });
        expect(result.current.hooks).toEqual([]);
    });
});

// ─── HooksPanel ──────────────────────────────────────────────────────

function makeHooksResult(overrides: Partial<UseHooksResult> = {}): UseHooksResult {
    return {
        hooks: [],
        loading: false,
        toggleHook: () => {},
        runHook: () => {},
        setHooksForTest: () => {},
        ...overrides
    };
}

describe('HooksPanel', () => {
    it('shows loading state when loading=true', () => {
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({ loading: true })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        expect(container).toHaveTextContent(/loading hooks/i);
    });

    it('shows empty state when no hooks', () => {
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({ loading: false, hooks: [] })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        expect(container).toHaveTextContent(/no hooks yet/i);
    });

    it('renders one row per hook with name + trigger summary', () => {
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [
                        makeHook({ id: 'a', name: 'Hook A', triggerSummary: 'on save: src/**' }),
                        makeHook({ id: 'b', name: 'Hook B', triggerSummary: 'every 60s', triggerType: 'onSchedule' })
                    ]
                })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        expect(container).toHaveTextContent('Hook A');
        expect(container).toHaveTextContent('Hook B');
        expect(container).toHaveTextContent('on save: src/**');
        expect(container).toHaveTextContent('every 60s');
    });

    it('toggle switch fires toggleHook with inverted state', () => {
        const toggleHook = vi.fn();
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [makeHook({ id: 'lint', enabled: true })],
                    toggleHook
                })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        // Find the switch — it has aria-label "Disable hook" when enabled
        const sw = within(container).getByRole('switch', { name: /disable hook/i });
        fireEvent.click(sw);
        expect(toggleHook).toHaveBeenCalledWith('lint', false);
    });

    it('run-now button fires runHook', () => {
        const runHook = vi.fn();
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [makeHook({ id: 'lint' })],
                    runHook
                })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        const btn = within(container).getByRole('button', { name: /run hook now/i });
        fireEvent.click(btn);
        expect(runHook).toHaveBeenCalledWith('lint');
    });

    it('run-now button is disabled when hook is disabled', () => {
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [makeHook({ id: 'lint', enabled: false })]
                })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        const btn = within(container).getByRole('button', { name: /run hook now/i });
        expect(btn).toBeDisabled();
    });

    it('open-in-editor button fires onOpenHook', () => {
        const onOpenHook = vi.fn();
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [makeHook({ id: 'lint' })]
                })}
                onClose={() => {}}
                onOpenHook={onOpenHook}
            />
        );
        const btn = within(container).getByRole('button', { name: /open in editor/i });
        fireEvent.click(btn);
        expect(onOpenHook).toHaveBeenCalledWith('lint');
    });

    it('subtitle counts enabled hooks', () => {
        const { container } = render(
            <HooksPanel
                hooks={makeHooksResult({
                    loading: false,
                    hooks: [
                        makeHook({ id: 'a', enabled: true }),
                        makeHook({ id: 'b', enabled: false }),
                        makeHook({ id: 'c', enabled: true })
                    ]
                })}
                onClose={() => {}}
                onOpenHook={() => {}}
            />
        );
        // 3 hooks, 2 enabled
        expect(container).toHaveTextContent(/3.*hooks.*2.*enabled/i);
    });
});