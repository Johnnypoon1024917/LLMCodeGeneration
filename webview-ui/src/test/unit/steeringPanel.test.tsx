// webview-ui/src/test/unit/steeringPanel.test.tsx
//
// Smoke tests for PR 3.3 — useSteering, SteeringPanel rendering,
// create/open actions. Same isolation pattern as hooksPanel tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, act, within } from '@testing-library/react';
import {
    useSteering,
    type SteeringSummary,
    type UseSteeringResult
} from '../../state/useSteering';
import { SteeringPanel } from '../../views/steering/SteeringPanel';

afterEach(() => {
    cleanup();
});

// ─── helpers ─────────────────────────────────────────────────────────

function makeItem(overrides: Partial<SteeringSummary> = {}): SteeringSummary {
    return {
        id: overrides.id ?? 'product',
        name: overrides.name ?? 'Product',
        kind: overrides.kind ?? 'canonical',
        exists: overrides.exists ?? true,
        ...(overrides.description !== undefined ? { description: overrides.description } : {}),
        ...(overrides.lastModified !== undefined ? { lastModified: overrides.lastModified } : {})
    };
}

interface FakeVscode {
    postMessage: ReturnType<typeof vi.fn>;
}
function makeFakeVscode(): FakeVscode {
    return { postMessage: vi.fn() };
}
function asBridge(fake: FakeVscode): { postMessage: (m: { type: string; [k: string]: unknown }) => void } {
    return fake as unknown as { postMessage: (m: { type: string; [k: string]: unknown }) => void };
}

// ─── useSteering ─────────────────────────────────────────────────────

describe('useSteering', () => {
    it('starts loading with empty list', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        expect(result.current.loading).toBe(true);
        expect(result.current.items).toEqual([]);
    });

    it('posts requestSteeringList on mount', () => {
        const vscode = makeFakeVscode();
        renderHook(() => useSteering(asBridge(vscode)));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: 'requestSteeringList' });
    });

    it('responds to steeringListUpdated messages', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        const item = makeItem({ id: 'product', name: 'Product' });
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'steeringListUpdated', items: [item] }
                })
            );
        });
        expect(result.current.loading).toBe(false);
        expect(result.current.items).toHaveLength(1);
        expect(result.current.items[0]?.id).toBe('product');
    });

    it('drops malformed entries', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'steeringListUpdated',
                        items: [
                            makeItem({ id: 'good' }),
                            null,
                            'not-an-object',
                            { id: 'incomplete' }, // missing kind/exists/name
                            makeItem({ id: 'good2', kind: 'custom' })
                        ]
                    }
                })
            );
        });
        expect(result.current.items.map((i) => i.id)).toEqual(['good', 'good2']);
    });

    it('rejects unknown kind values', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        act(() => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        type: 'steeringListUpdated',
                        items: [
                            { ...makeItem(), kind: 'magical' as unknown as 'canonical' }
                        ]
                    }
                })
            );
        });
        expect(result.current.items).toEqual([]);
    });

    it('createSteeringFile posts the right message', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        act(() => result.current.createSteeringFile('product'));
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: 'createSteeringFile',
            id: 'product'
        });
    });

    it('openSteeringFile posts the right message', () => {
        const vscode = makeFakeVscode();
        const { result } = renderHook(() => useSteering(asBridge(vscode)));
        act(() => result.current.openSteeringFile('tech'));
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: 'openSteeringFile',
            id: 'tech'
        });
    });
});

// ─── SteeringPanel ───────────────────────────────────────────────────

function makeSteeringResult(overrides: Partial<UseSteeringResult> = {}): UseSteeringResult {
    return {
        items: [],
        loading: false,
        createSteeringFile: () => {},
        openSteeringFile: () => {},
        setItemsForTest: () => {},
        ...overrides
    };
}

describe('SteeringPanel', () => {
    it('shows loading state when loading=true', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({ loading: true })}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent(/loading steering rules/i);
    });

    it('shows empty state when no items', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({ items: [] })}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent(/no steering rules yet/i);
    });

    it('renders all canonical items even if missing', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [
                        makeItem({ id: 'product', name: 'Product', exists: true, lastModified: '2026-05-02T10:00:00.000Z' }),
                        makeItem({ id: 'structure', name: 'Structure', exists: false }),
                        makeItem({ id: 'tech', name: 'Tech', exists: false })
                    ]
                })}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent('Product');
        expect(container).toHaveTextContent('Structure');
        expect(container).toHaveTextContent('Tech');
    });

    it('shows "Create" button on missing canonical files', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [makeItem({ id: 'tech', name: 'Tech', exists: false })]
                })}
                onClose={() => {}}
            />
        );
        expect(within(container).getByRole('button', { name: /create/i })).toBeInTheDocument();
    });

    it('shows "Open in editor" button on existing files', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [makeItem({ id: 'product', name: 'Product', exists: true })]
                })}
                onClose={() => {}}
            />
        );
        expect(within(container).getByRole('button', { name: /open in editor/i })).toBeInTheDocument();
    });

    it('clicking "Create" fires createSteeringFile', () => {
        const createSteeringFile = vi.fn();
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [makeItem({ id: 'tech', name: 'Tech', exists: false })],
                    createSteeringFile
                })}
                onClose={() => {}}
            />
        );
        fireEvent.click(within(container).getByRole('button', { name: /create/i }));
        expect(createSteeringFile).toHaveBeenCalledWith('tech');
    });

    it('clicking "Open in editor" fires openSteeringFile', () => {
        const openSteeringFile = vi.fn();
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [makeItem({ id: 'product', exists: true })],
                    openSteeringFile
                })}
                onClose={() => {}}
            />
        );
        fireEvent.click(within(container).getByRole('button', { name: /open in editor/i }));
        expect(openSteeringFile).toHaveBeenCalledWith('product');
    });

    it('subtitle counts active vs total', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [
                        makeItem({ id: 'product', exists: true }),
                        makeItem({ id: 'structure', exists: false }),
                        makeItem({ id: 'tech', exists: true })
                    ]
                })}
                onClose={() => {}}
            />
        );
        // 2 active, 3 total
        expect(container).toHaveTextContent(/2.*active.*3.*total/i);
    });

    it('shows kind pill — canonical and custom render distinct text', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [
                        makeItem({ id: 'product', kind: 'canonical' }),
                        makeItem({ id: 'project-rules', name: 'project-rules', kind: 'custom' })
                    ]
                })}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent(/canonical/i);
        expect(container).toHaveTextContent(/custom/i);
    });

    it('shows "not created" footer text on missing files', () => {
        const { container } = render(
            <SteeringPanel
                steering={makeSteeringResult({
                    items: [makeItem({ id: 'tech', exists: false })]
                })}
                onClose={() => {}}
            />
        );
        expect(container).toHaveTextContent(/not created/i);
    });
});