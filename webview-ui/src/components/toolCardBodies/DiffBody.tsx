// webview-ui/src/components/toolCardBodies/DiffBody.tsx
//
// Component 2B-4b: body strategy for "modification" tools.
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
//   - Skip large unchanged stretches with a "..." separator
//   - Color-code: green background for additions, red for removals
//   - Render line-by-line with +/-/space prefix (unified-diff style)
//
// Edge cases handled:
//   - before === ''     → new file, all lines render as additions
//   - before === after  → no-op, render "No changes" placeholder
//   - very long files   → cap rendering at N hunks; chat compactness
//
// State source: ToolCallState. Same pattern as InformationalBody.
// While running, shows "Writing…" placeholder. On error, shows
// the error message.

import React from 'react';
import { diffLines, type Change } from 'diff';
import {
    AlertCircle as IconAlert,
    FilePlus as IconNewFile,
    Equal as IconNoChange
} from 'lucide-react';
import type { ToolCallState, ToolResult } from '../../toolEvents';

export interface DiffBodyProps {
    state: ToolCallState;
}

export function DiffBody({ state }: DiffBodyProps): React.ReactElement {
    if (state.status === 'running') {
        return <div className="tool-call-card-empty">Writing…</div>;
    }

    if (state.result?.uiPayload.kind === 'error') {
        return (
            <div className="tool-call-card-error">
                <IconAlert size={14} />
                <span>{state.result.uiPayload.message}</span>
            </div>
        );
    }

    if (!state.result) {
        return <div className="tool-call-card-empty">(no result)</div>;
    }

    const payload = state.result.uiPayload;
    if (payload.kind !== 'diff') {
        // Defensive: shouldn't happen for write_file/edit_file but
        // dispatcher could theoretically return a different kind on
        // error paths. Fall through to llmContent.
        return <pre className="tool-call-card-fallback-output">{state.result.llmContent}</pre>;
    }

    return <DiffView payload={payload} />;
}

// ─── Diff rendering ──────────────────────────────────────────────────

/**
 * Lines of context shown around each change region. Mirrors common
 * `git diff -U3` convention. Higher = more orientation, more chat
 * real estate.
 */
const CONTEXT_LINES = 2;

/**
 * Cap on total rendered lines. For very large diffs, we render the
 * first N lines and then a "(diff truncated)" footer. The user can
 * always look at the actual file in their editor for the full picture.
 */
const MAX_RENDERED_LINES = 200;

/**
 * One displayable line in the rendered diff.
 *   - 'add'      → green background, '+' prefix
 *   - 'remove'   → red background, '-' prefix
 *   - 'context'  → no background, ' ' prefix
 *   - 'separator'→ "..." between non-adjacent hunks
 */
interface DisplayLine {
    type: 'add' | 'remove' | 'context' | 'separator';
    text: string;
}

function DiffView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'diff' }>
}): React.ReactElement {
    // No-op detection: identical strings. Don't bother running diffLines.
    if (payload.before === payload.after) {
        return (
            <div className="tool-call-info-body">
                <div className="tool-call-info-meta">
                    <IconNoChange size={12} />
                    <span className="tool-call-info-meta-item">No changes to {payload.filepath}</span>
                </div>
            </div>
        );
    }

    // New-file detection: before is empty, after has content.
    // Render special header + show all lines as additions.
    const isNewFile = payload.before === '';

    // Run diffLines. The `Change` array has runs of added/removed/
    // unchanged lines. Each run's `value` is multi-line (joined with
    // '\n'); we split to get individual lines for rendering.
    const changes: Change[] = diffLines(payload.before, payload.after);

    // Build the renderable line list with context windows.
    const lines = buildDisplayLines(changes);

    // Cap at MAX_RENDERED_LINES to keep chat compact for huge edits.
    const truncated = lines.length > MAX_RENDERED_LINES;
    const displayLines = truncated ? lines.slice(0, MAX_RENDERED_LINES) : lines;

    // Compute summary stats for the meta header.
    let addCount = 0;
    let removeCount = 0;
    for (const change of changes) {
        if (change.added) addCount += change.count ?? 0;
        if (change.removed) removeCount += change.count ?? 0;
    }

    return (
        <div className="tool-call-info-body">
            <div className="tool-call-info-meta">
                {isNewFile && (
                    <>
                        <IconNewFile size={12} />
                        <span className="tool-call-info-meta-item">new file</span>
                        <span className="tool-call-info-meta-item">·</span>
                    </>
                )}
                <span className="tool-call-info-meta-item tool-call-diff-add-count">
                    +{addCount}
                </span>
                <span className="tool-call-info-meta-item tool-call-diff-remove-count">
                    −{removeCount}
                </span>
                <span className="tool-call-info-meta-item">·</span>
                <span className="tool-call-info-meta-item">{payload.filepath}</span>
            </div>
            <pre className="tool-call-diff-body" tabIndex={0}>
                {displayLines.map((line, i) => (
                    <DiffLineRow key={i} line={line} />
                ))}
                {truncated && (
                    <div className="tool-call-diff-truncated">
                        … diff truncated at {MAX_RENDERED_LINES} lines (showing the start of the change)
                    </div>
                )}
            </pre>
        </div>
    );
}

/**
 * Build the displayable line list from the diff library's Change
 * runs. Algorithm:
 *
 *   1. Flatten each Change into individual lines tagged by type
 *      (add/remove/context).
 *   2. Walk the flattened list. For each run of context lines:
 *      - If the run is short (≤ 2 * CONTEXT_LINES), keep all lines.
 *        This avoids inserting an unnecessary "..." between two
 *        nearby hunks.
 *      - If long, keep CONTEXT_LINES at the start (after a previous
 *        change) and CONTEXT_LINES at the end (before the next
 *        change), separator in between.
 *      - Special case: if this run starts at line 0 (no prior change),
 *        only keep the trailing CONTEXT_LINES — no point showing
 *        leading context for a hunk at the file's top.
 *      - Special case: if this run ends at the file's tail (no next
 *        change), only keep the leading CONTEXT_LINES.
 */
function buildDisplayLines(changes: Change[]): DisplayLine[] {
    // First flatten changes into per-line entries
    const flatLines: DisplayLine[] = [];
    for (const change of changes) {
        const value = change.value;
        // Each Change ends with a trailing newline if the underlying
        // text did. Splitting and discarding the empty trailing element
        // gives us proper line-by-line entries.
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

    // Now collapse long context runs.
    const result: DisplayLine[] = [];
    let i = 0;
    while (i < flatLines.length) {
        const line = flatLines[i]!;
        if (line.type !== 'context') {
            result.push(line);
            i++;
            continue;
        }

        // Collect this run of context lines.
        const runStart = i;
        while (i < flatLines.length && flatLines[i]!.type === 'context') {
            i++;
        }
        const runEnd = i; // exclusive
        const runLength = runEnd - runStart;

        // Decide what to keep. We have prevChange (something before this
        // run that wasn't context) and nextChange (something after).
        const hasPrev = runStart > 0;
        const hasNext = runEnd < flatLines.length;

        if (!hasPrev && !hasNext) {
            // Whole file unchanged. Shouldn't happen — we have a no-op
            // detector upstream. Defensive: include all.
            for (let j = runStart; j < runEnd; j++) result.push(flatLines[j]!);
        } else if (!hasPrev) {
            // Run is at the start: keep last CONTEXT_LINES.
            const keepStart = Math.max(runStart, runEnd - CONTEXT_LINES);
            if (keepStart > runStart) {
                result.push({ type: 'separator', text: '' });
            }
            for (let j = keepStart; j < runEnd; j++) result.push(flatLines[j]!);
        } else if (!hasNext) {
            // Run is at the end: keep first CONTEXT_LINES.
            const keepEnd = Math.min(runEnd, runStart + CONTEXT_LINES);
            for (let j = runStart; j < keepEnd; j++) result.push(flatLines[j]!);
            if (keepEnd < runEnd) {
                result.push({ type: 'separator', text: '' });
            }
        } else if (runLength <= 2 * CONTEXT_LINES) {
            // Short run between two changes: keep all (avoids
            // distracting "..." between nearby hunks).
            for (let j = runStart; j < runEnd; j++) result.push(flatLines[j]!);
        } else {
            // Long run between changes: keep CONTEXT_LINES on each end
            // with separator.
            for (let j = runStart; j < runStart + CONTEXT_LINES; j++) result.push(flatLines[j]!);
            result.push({ type: 'separator', text: '' });
            for (let j = runEnd - CONTEXT_LINES; j < runEnd; j++) result.push(flatLines[j]!);
        }
    }

    return result;
}

function DiffLineRow({ line }: { line: DisplayLine }): React.ReactElement {
    if (line.type === 'separator') {
        return <div className="tool-call-diff-line tool-call-diff-separator">…</div>;
    }
    const prefix =
        line.type === 'add' ? '+' :
        line.type === 'remove' ? '−' :
        ' ';
    const cls =
        line.type === 'add' ? 'tool-call-diff-add' :
        line.type === 'remove' ? 'tool-call-diff-remove' :
        'tool-call-diff-context';
    return (
        <div className={`tool-call-diff-line ${cls}`}>
            <span className="tool-call-diff-prefix" aria-hidden="true">{prefix}</span>
            <span className="tool-call-diff-text">{line.text || '\u00A0'}</span>
        </div>
    );
}