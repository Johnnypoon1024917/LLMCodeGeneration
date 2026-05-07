// webview-ui/src/components/ReadActivityGroup.tsx
//
// P1.4-compaction (2026-05): groups consecutive read-only tool calls
// (read_file / list_directory / search_codebase) into a single compact
// summary line that the user can click to expand.
//
// Why this exists: in daily use the user reported "too many read_file
// cards, too overhang, makes me scroll a lot from top to bottom." The
// agent does 5-15 reads per task before making a change; each rendered
// as its own ~32px card adds 200-500px of vertical noise. The actual
// information value is "the agent looked at these files" — collapsing
// to one line preserves that without stealing screen real estate.
//
// "Consecutive" semantics: if the agent does read → write → read, we
// produce TWO groups (one before the write, one after) so chronology
// is preserved. The grouping happens at render time in ToolCallList.

import React, { useState } from 'react';
import { ToolCallCard } from './ToolCallCard';
import type { ToolCallState } from '../toolEvents';

interface ReadActivityGroupProps {
    /** All cards in this group. Must be 2+ for grouping to make
     *  sense — single reads should render as individual cards. The
     *  list builder enforces this. */
    cards: ToolCallState[];
}

/** Tools whose value is "we looked at this." Their full card content
 *  is rarely needed once they've completed. The list is intentionally
 *  conservative — anything that mutates state is excluded. */
export const READ_ONLY_TOOLS = new Set<string>([
    'read_file',
    'list_directory',
    'search_codebase',
]);

/** Compact label for one read tool call. Picks the most identifying
 *  arg per tool. Falls back to the tool name for unknown shapes. */
function labelFor(card: ToolCallState): string {
    const args = card.args ?? {};
    if (card.name === 'read_file' && typeof args['filepath'] === 'string') {
        return shortPath(args['filepath']);
    }
    if (card.name === 'list_directory' && typeof args['dirpath'] === 'string') {
        return shortPath(args['dirpath']);
    }
    if (card.name === 'search_codebase' && typeof args['query'] === 'string') {
        const q = String(args['query']);
        return `"${q.length > 24 ? q.slice(0, 24) + '…' : q}"`;
    }
    return card.name;
}

/** Reduce path to last 2 segments so chips fit on narrow sidebars.
 *  /home/foo/src/services/booking.service.ts → services/booking.service.ts */
function shortPath(p: string): string {
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) { return p; }
    return parts.slice(-2).join('/');
}

export function ReadActivityGroup({ cards }: ReadActivityGroupProps): React.ReactElement {
    const [expanded, setExpanded] = useState(false);

    // Card statuses: any error in the group elevates the whole group's
    // status. Otherwise running > success.
    const hasError = cards.some(c => c.status === 'error');
    const hasRunning = cards.some(c => c.status === 'running');
    const allComplete = cards.every(c => c.status === 'success');

    // Build the compact summary text. Show first 3 labels, then
    // "(+N more)" if there are extras. Keeps line under ~80 chars.
    const labels = cards.map(labelFor);
    const SHOW = 3;
    const visible = labels.slice(0, SHOW);
    const extra = labels.length - visible.length;
    const summaryText = `Inspected ${cards.length} ${cards.length === 1 ? 'file' : 'items'}: ${visible.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`;

    // Status dot color tracks the worst status in the group.
    let dotColor = 'var(--vscode-foreground)';
    let dotOpacity = 0.4;
    if (hasError) {
        dotColor = 'var(--vscode-testing-iconFailed, #e53935)';
        dotOpacity = 1;
    } else if (hasRunning) {
        dotColor = 'var(--vscode-progressBar-background, #0e70c0)';
        dotOpacity = 0.85;
    } else if (allComplete) {
        dotColor = 'var(--vscode-testing-iconPassed, #5cb85c)';
        dotOpacity = 0.6;
    }

    if (expanded) {
        // When expanded, render the original ToolCallCards in order.
        // A small "collapse" affordance at the top lets the user
        // re-collapse without scrolling back to the original line.
        return (
            <div className="read-activity-group expanded">
                <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="read-activity-group-collapse-button"
                    aria-label="Collapse read activity"
                    style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--vscode-foreground)',
                        opacity: 0.55,
                        cursor: 'pointer',
                        fontSize: '11px',
                        padding: '2px 6px',
                        marginBottom: '2px',
                    }}
                >
                    ▾ {summaryText} (click to collapse)
                </button>
                {cards.map(c => (
                    <ToolCallCard key={c.callId} state={c} />
                ))}
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={() => setExpanded(true)}
            className="read-activity-group collapsed"
            aria-label={`Expand read activity: ${summaryText}`}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                background: 'transparent',
                border: '1px dashed var(--vscode-widget-border, rgba(128,128,128,0.2))',
                borderRadius: '4px',
                padding: '4px 10px',
                marginTop: '4px',
                color: 'var(--vscode-foreground)',
                opacity: 0.7,
                cursor: 'pointer',
                fontSize: '11px',
                fontFamily: 'var(--vscode-font-family)',
                textAlign: 'left',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    backgroundColor: dotColor,
                    opacity: dotOpacity,
                    flexShrink: 0,
                }}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                ▸ {summaryText}
            </span>
        </button>
    );
}

/**
 * Partition a chronologically-sorted list of tool calls into render
 * units: groups of 2+ consecutive read-only calls become one
 * ReadActivityGroup; everything else stays as individual cards.
 *
 * Returns an array where each element is EITHER:
 *   { kind: 'card', card: ToolCallState }
 *   { kind: 'group', cards: ToolCallState[] }   (cards.length >= 2)
 *
 * Single read calls in isolation render as normal cards (not worth
 * grouping). The 2+ threshold prevents the group affordance from
 * showing up just to wrap a single read.
 */
export type RenderUnit =
    | { kind: 'card'; card: ToolCallState }
    | { kind: 'group'; cards: ToolCallState[] };

export function partitionReadActivity(cards: ToolCallState[]): RenderUnit[] {
    const out: RenderUnit[] = [];
    let buffer: ToolCallState[] = [];

    const flushBuffer = () => {
        if (buffer.length >= 2) {
            out.push({ kind: 'group', cards: buffer });
        } else {
            for (const c of buffer) {
                out.push({ kind: 'card', card: c });
            }
        }
        buffer = [];
    };

    for (const card of cards) {
        if (READ_ONLY_TOOLS.has(card.name)) {
            buffer.push(card);
        } else {
            flushBuffer();
            out.push({ kind: 'card', card });
        }
    }
    flushBuffer();
    return out;
}