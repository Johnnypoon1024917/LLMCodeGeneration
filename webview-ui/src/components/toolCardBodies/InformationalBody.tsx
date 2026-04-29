// webview-ui/src/components/toolCardBodies/InformationalBody.tsx
//
// Component 2B-4a: body strategy for "informational" tools.
//
// Three tools share this body:
//   - read_file       → file_contents payload (filepath + content)
//   - list_directory  → directory payload (path + entries[])
//   - search_codebase → search_matches payload (matches[])
//
// All three return result atomically (no streaming output events) so
// the body renders only the final result. While running, it shows
// a placeholder.
//
// Body shape per tool:
//
//   read_file:        Filepath header + scrollable code preview
//   list_directory:   Path header + tree-style entries
//   search_codebase:  Match count header + per-match clickable rows

import React from 'react';
import {
    File as IconFile,
    Folder as IconFolder,
    Link as IconSymlink,
    AlertCircle as IconAlert
} from 'lucide-react';
import type { ToolCallState, ToolResult } from '../../toolEvents';

export interface InformationalBodyProps {
    state: ToolCallState;
}

export function InformationalBody({ state }: InformationalBodyProps): React.ReactElement {
    // While running: show a placeholder. These tools don't stream, so
    // there's no useful intermediate output.
    if (state.status === 'running') {
        return <div className="tool-call-card-empty">Reading…</div>;
    }

    // Error: render error message regardless of which informational
    // tool it was. Same visual treatment.
    if (state.result?.uiPayload.kind === 'error') {
        return (
            <div className="tool-call-card-error">
                <IconAlert size={14} />
                <span>{state.result.uiPayload.message}</span>
            </div>
        );
    }

    // No payload: shouldn't happen for completed informational tools,
    // but defend anyway.
    if (!state.result) {
        return <div className="tool-call-card-empty">(no result)</div>;
    }

    const payload = state.result.uiPayload;
    if (payload.kind === 'file_contents') {
        return <FileContentsView payload={payload} />;
    }
    if (payload.kind === 'directory') {
        return <DirectoryView payload={payload} />;
    }
    if (payload.kind === 'search_matches') {
        return <SearchMatchesView payload={payload} />;
    }
    // Other payload kinds shouldn't reach this body — defensive fallback.
    return <pre className="tool-call-card-fallback-output">{state.result.llmContent}</pre>;
}

// ─── file_contents view ──────────────────────────────────────────────

function FileContentsView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'file_contents' }>
}): React.ReactElement {
    const lineCount = payload.content.split('\n').length;
    const byteCount = new Blob([payload.content]).size;

    return (
        <div className="tool-call-info-body">
            <div className="tool-call-info-meta">
                <span className="tool-call-info-meta-item">{lineCount} lines</span>
                <span className="tool-call-info-meta-item">·</span>
                <span className="tool-call-info-meta-item">{formatBytes(byteCount)}</span>
                {payload.truncated && (
                    <>
                        <span className="tool-call-info-meta-item">·</span>
                        <span className="tool-call-info-meta-item tool-call-info-truncated">truncated</span>
                    </>
                )}
            </div>
            <pre className="tool-call-info-code" tabIndex={0}>
                {payload.content}
            </pre>
        </div>
    );
}

// ─── directory view ──────────────────────────────────────────────────

function DirectoryView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'directory' }>
}): React.ReactElement {
    if (payload.entries.length === 0) {
        return <div className="tool-call-info-empty">(empty directory)</div>;
    }
    // Sort: directories first, then files, then symlinks. Each group
    // alphabetical. Mirrors Finder/Explorer convention.
    const sorted = [...payload.entries].sort((a, b) => {
        const order = { dir: 0, file: 1, symlink: 2 };
        const ordA = order[a.kind];
        const ordB = order[b.kind];
        if (ordA !== ordB) return ordA - ordB;
        return a.name.localeCompare(b.name);
    });
    return (
        <div className="tool-call-info-body">
            <div className="tool-call-info-meta">
                <span className="tool-call-info-meta-item">{payload.entries.length} entries</span>
            </div>
            <ul className="tool-call-info-tree">
                {sorted.map((entry, i) => {
                    const Icon =
                        entry.kind === 'dir' ? IconFolder :
                        entry.kind === 'symlink' ? IconSymlink : IconFile;
                    return (
                        <li key={`${entry.name}-${i}`} className="tool-call-info-tree-item">
                            <Icon size={12} />
                            <span>{entry.name}</span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

// ─── search_matches view ─────────────────────────────────────────────

function SearchMatchesView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'search_matches' }>
}): React.ReactElement {
    if (payload.matches.length === 0) {
        return <div className="tool-call-info-empty">(no matches)</div>;
    }
    return (
        <div className="tool-call-info-body">
            <div className="tool-call-info-meta">
                <span className="tool-call-info-meta-item">{payload.matches.length} matches</span>
            </div>
            <ul className="tool-call-info-matches">
                {payload.matches.map((match, i) => (
                    <li key={`${match.filepath}-${match.line}-${i}`} className="tool-call-info-match">
                        <span className="tool-call-info-match-loc">
                            {match.filepath}:{match.line}
                        </span>
                        <code className="tool-call-info-match-text">
                            {match.text}
                        </code>
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatBytes(b: number): string {
    if (b < 1024) return `${b}B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}