// webview-ui/src/components/toolCardBodies/DiffBody.tsx
//
// Body strategy for "modification" tools.
//
// Two tools share this body:
//   - write_file → diff payload with full before/after content
//   - edit_file  → diff payload with full file content (the surgical
//                  edit was applied internally; we still receive
//                  full-file before/after for diffing)
//
// Rendering approach:
//   - Use the `diff` library's diffLines to get added/removed/unchanged hunks
//   - Show changed regions with N lines of surrounding context
//   - Skip large unchanged stretches with a "…" separator
//   - Color-code: green background for additions, red for removals
//   - Render line-by-line with +/-/space prefix (unified-diff style)
//
// Edge cases handled:
//   - before === ''     → new file, all lines render as additions
//   - before === after  → no-op, render "No changes" placeholder
//   - very long files   → cap rendering at MAX_RENDERED_LINES
//
// State source: ToolCallState. While running, shows "Writing…"
// placeholder. On error, shows the error message.
//
// PR 2.2 (Sprint 2): visual overhaul of the chrome (meta, empty, error)
// using shared body atoms + design tokens. Diff-line colors deliberately
// stay GitHub-dark (green for additions, red for removals) — that
// palette is the standard developers expect from any diff renderer.
// buildDisplayLines / CONTEXT_LINES / MAX_RENDERED_LINES algorithm
// preserved verbatim.

import React from 'react';
import { diffLines, type Change } from 'diff';
import {
    FilePlus as IconNewFile,
    Equal as IconNoChange
} from 'lucide-react';
import type { ToolCallState, ToolResult } from '../../toolEvents';
import { cn } from '../ui/cn';
import {
    BodyContainer,
    BodyEmpty,
    BodyError,
    BodyFallbackPre,
    BodyMeta,
    BodyMetaItem,
    BodyMetaDivider
} from './shared';

export interface DiffBodyProps {
    state: ToolCallState;
}

export function DiffBody({ state }: DiffBodyProps): React.ReactElement {
    if (state.status === 'running') {
        return <BodyEmpty>Writing…</BodyEmpty>;
    }
    if (state.result?.uiPayload.kind === 'error') {
        return <BodyError message={state.result.uiPayload.message} />;
    }
    if (!state.result) {
        return <BodyEmpty>(no result)</BodyEmpty>;
    }

    const payload = state.result.uiPayload;
    if (payload.kind !== 'diff') {
        // Defensive: shouldn't happen for write_file/edit_file but
        // dispatcher could theoretically return a different kind on
        // error paths. Fall through to llmContent.
        return <BodyFallbackPre>{state.result.llmContent}</BodyFallbackPre>;
    }

    return <DiffView payload={payload} />;
}

// ─── Diff rendering ──────────────────────────────────────────────────

/** Lines of context shown around each change region. Mirrors common
 *  `git diff -U3` convention. Higher = more orientation, more chat
 *  real estate. */
const CONTEXT_LINES = 2;

/** Cap on total rendered lines. For very large diffs, we render the
 *  first N lines and then a "(diff truncated)" footer. The user can
 *  always look at the actual file in their editor for the full picture. */
const MAX_RENDERED_LINES = 200;

/** One displayable line in the rendered diff.
 *   - 'add'      → green background, '+' prefix
 *   - 'remove'   → red background, '−' prefix
 *   - 'context'  → no background, ' ' prefix
 *   - 'separator'→ "…" between non-adjacent hunks */
interface DisplayLine {
    type: 'add' | 'remove' | 'context' | 'separator';
    text: string;
}

function DiffView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'diff' }>
}): React.ReactElement {
    // No-op detection.
    if (payload.before === payload.after) {
        return (
            <BodyContainer>
                <BodyMeta>
                    <span className="inline-flex items-center gap-1.5">
                        <IconNoChange size={12} />
                        <BodyMetaItem>No changes to {payload.filepath}</BodyMetaItem>
                    </span>
                </BodyMeta>
            </BodyContainer>
        );
    }

    const isNewFile = payload.before === '';

    const changes: Change[] = diffLines(payload.before, payload.after);
    const lines = buildDisplayLines(changes);

    const truncated = lines.length > MAX_RENDERED_LINES;
    const displayLines = truncated ? lines.slice(0, MAX_RENDERED_LINES) : lines;

    let addCount = 0;
    let removeCount = 0;
    for (const change of changes) {
        if (change.added) { addCount += change.count ?? 0; }
        if (change.removed) { removeCount += change.count ?? 0; }
    }

    return (
        <BodyContainer>
            <BodyMeta>
                {isNewFile && (
                    <>
                        <span className="inline-flex items-center gap-1.5">
                            <IconNewFile size={12} />
                            <BodyMetaItem>new file</BodyMetaItem>
                        </span>
                        <BodyMetaDivider />
                    </>
                )}
                {/* Diff stats. Green/red kept verbatim from the
                    GitHub-dark palette — developer convention.
                    Hex chosen to match the diff line backgrounds below
                    (which intentionally stay tied to those constants). */}
                <span className="text-[#3fb950] font-medium">+{addCount}</span>
                <span className="text-[#f85149] font-medium">−{removeCount}</span>
                <BodyMetaDivider />
                <BodyMetaItem className="text-text-secondary">
                    {payload.filepath}
                </BodyMetaItem>
            </BodyMeta>
            <pre
                tabIndex={0}
                className={cn(
                    'm-0 py-1.5',
                    'font-mono text-xs leading-relaxed',
                    'bg-[#0d1117]',
                    'max-h-100 overflow-auto',
                    'outline-none focus:ring-1 focus:ring-border-focus focus:ring-inset'
                )}
            >
                {displayLines.map((line, i) => (
                    <DiffLineRow key={i} line={line} />
                ))}
                {truncated && (
                    <div
                        className={cn(
                            'px-4 py-1.5 mt-1.5',
                            'border-t border-[#30363d]',
                            'text-[#cca700] italic'
                        )}
                    >
                        … diff truncated at {MAX_RENDERED_LINES} lines (showing the start of the change)
                    </div>
                )}
            </pre>
        </BodyContainer>
    );
}

/**
 * Build the displayable line list from the diff library's Change runs.
 * (Algorithm verbatim from PR 2.1 — see prior comments.)
 */
function buildDisplayLines(changes: Change[]): DisplayLine[] {
    const flatLines: DisplayLine[] = [];
    for (const change of changes) {
        const value = change.value;
        const lines = value.endsWith('\n')
            ? value.slice(0, -1).split('\n')
            : value.split('\n');
        const type: DisplayLine['type'] =
            change.added ? 'add' :
            change.removed ? 'remove' :
            'context';
        for (const line of lines) {
            flatLines.push({ type, text: line });
        }
    }

    const result: DisplayLine[] = [];
    let i = 0;
    while (i < flatLines.length) {
        const line = flatLines[i]!;
        if (line.type !== 'context') {
            result.push(line);
            i++;
            continue;
        }

        const runStart = i;
        while (i < flatLines.length && flatLines[i]!.type === 'context') {
            i++;
        }
        const runEnd = i;
        const runLength = runEnd - runStart;

        const hasPrev = runStart > 0;
        const hasNext = runEnd < flatLines.length;

        if (!hasPrev && !hasNext) {
            for (let j = runStart; j < runEnd; j++) { result.push(flatLines[j]!); }
        } else if (!hasPrev) {
            const keepStart = Math.max(runStart, runEnd - CONTEXT_LINES);
            if (keepStart > runStart) {
                result.push({ type: 'separator', text: '' });
            }
            for (let j = keepStart; j < runEnd; j++) { result.push(flatLines[j]!); }
        } else if (!hasNext) {
            const keepEnd = Math.min(runEnd, runStart + CONTEXT_LINES);
            for (let j = runStart; j < keepEnd; j++) { result.push(flatLines[j]!); }
            if (keepEnd < runEnd) {
                result.push({ type: 'separator', text: '' });
            }
        } else if (runLength <= 2 * CONTEXT_LINES) {
            for (let j = runStart; j < runEnd; j++) { result.push(flatLines[j]!); }
        } else {
            for (let j = runStart; j < runStart + CONTEXT_LINES; j++) { result.push(flatLines[j]!); }
            result.push({ type: 'separator', text: '' });
            for (let j = runEnd - CONTEXT_LINES; j < runEnd; j++) { result.push(flatLines[j]!); }
        }
    }

    return result;
}

function DiffLineRow({ line }: { line: DisplayLine }): React.ReactElement {
    if (line.type === 'separator') {
        return (
            <div
                className={cn(
                    'flex items-center justify-center',
                    'py-0.5',
                    'text-[#6e7681] italic tracking-wider'
                )}
            >
                …
            </div>
        );
    }
    const prefix =
        line.type === 'add' ? '+' :
        line.type === 'remove' ? '−' :
        ' ';
    const lineBg =
        line.type === 'add'    ? 'bg-[#2ea04326]' :
        line.type === 'remove' ? 'bg-[#f8514926]' :
        '';
    const prefixColor =
        line.type === 'add'    ? 'text-[#3fb950]' :
        line.type === 'remove' ? 'text-[#f85149]' :
        'text-[#6e7681]';
    return (
        <div className={cn('flex items-start px-4 leading-relaxed', lineBg)}>
            <span
                aria-hidden="true"
                className={cn(
                    'shrink-0 w-3.5 text-center select-none',
                    prefixColor
                )}
            >
                {prefix}
            </span>
            <span className="flex-1 text-[#c9d1d9] whitespace-pre">
                {line.text || '\u00A0'}
            </span>
        </div>
    );
}