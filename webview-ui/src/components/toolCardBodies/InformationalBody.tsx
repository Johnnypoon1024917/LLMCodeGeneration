// webview-ui/src/components/toolCardBodies/InformationalBody.tsx
//
// Body strategy for "informational" tools:
//   - read_file       → file_contents payload (filepath + content)
//   - list_directory  → directory payload (path + entries[])
//   - search_codebase → search_matches payload (matches[])
//
// All three return result atomically (no streaming output events) so
// the body renders only the final result. While running, it shows
// a placeholder.
//
// PR 2.2 (Sprint 2): visual overhaul — uses shared body atoms
// (BodyEmpty/BodyError/BodyContainer/BodyMeta/BodyMetaItem/BodyMetaDivider)
// and design tokens. Logic unchanged — same payload-kind dispatch,
// same sort order, same formatBytes helper.

import React from 'react';
import {
    File as IconFile,
    Folder as IconFolder,
    Link as IconSymlink
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

export interface InformationalBodyProps {
    state: ToolCallState;
}

export function InformationalBody({ state }: InformationalBodyProps): React.ReactElement {
    if (state.status === 'running') {
        return <BodyEmpty>Reading…</BodyEmpty>;
    }
    if (state.result?.uiPayload.kind === 'error') {
        return <BodyError message={state.result.uiPayload.message} />;
    }
    if (!state.result) {
        return <BodyEmpty>(no result)</BodyEmpty>;
    }

    const payload = state.result.uiPayload;
    if (payload.kind === 'file_contents') { return <FileContentsView payload={payload} />; }
    if (payload.kind === 'directory') { return <DirectoryView payload={payload} />; }
    if (payload.kind === 'search_matches') { return <SearchMatchesView payload={payload} />; }
    // Other payload kinds shouldn't reach this body — defensive fallback.
    return <BodyFallbackPre>{state.result.llmContent}</BodyFallbackPre>;
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
        <BodyContainer>
            <BodyMeta>
                <BodyMetaItem>{lineCount} lines</BodyMetaItem>
                <BodyMetaDivider />
                <BodyMetaItem>{formatBytes(byteCount)}</BodyMetaItem>
                {payload.truncated && (
                    <>
                        <BodyMetaDivider />
                        <BodyMetaItem truncated>truncated</BodyMetaItem>
                    </>
                )}
            </BodyMeta>
            <pre
                tabIndex={0}
                className={cn(
                    'px-4 py-3 m-0',
                    'font-mono text-xs leading-relaxed',
                    'bg-surface-base text-text-secondary',
                    'whitespace-pre',
                    'max-h-60 overflow-auto',
                    'outline-none focus:ring-1 focus:ring-border-focus focus:ring-inset'
                )}
            >
                {payload.content}
            </pre>
        </BodyContainer>
    );
}

// ─── directory view ──────────────────────────────────────────────────

function DirectoryView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'directory' }>
}): React.ReactElement {
    if (payload.entries.length === 0) {
        return <BodyEmpty>(empty directory)</BodyEmpty>;
    }
    // Sort: directories first, then files, then symlinks. Each group
    // alphabetical. Mirrors Finder/Explorer convention.
    const sorted = [...payload.entries].sort((a, b) => {
        const order = { dir: 0, file: 1, symlink: 2 };
        const ordA = order[a.kind];
        const ordB = order[b.kind];
        if (ordA !== ordB) { return ordA - ordB; }
        return a.name.localeCompare(b.name);
    });
    return (
        <BodyContainer>
            <BodyMeta>
                <BodyMetaItem>{payload.entries.length} entries</BodyMetaItem>
            </BodyMeta>
            <ul className="px-4 py-2 m-0 list-none">
                {sorted.map((entry, i) => {
                    const Icon =
                        entry.kind === 'dir' ? IconFolder :
                        entry.kind === 'symlink' ? IconSymlink : IconFile;
                    return (
                        <li
                            key={`${entry.name}-${i}`}
                            className={cn(
                                'flex items-center gap-2',
                                'py-0.5',
                                'font-mono text-xs text-text-primary'
                            )}
                        >
                            <Icon size={12} className="shrink-0 text-text-tertiary" />
                            <span className="truncate">{entry.name}</span>
                        </li>
                    );
                })}
            </ul>
        </BodyContainer>
    );
}

// ─── search_matches view ─────────────────────────────────────────────

function SearchMatchesView({
    payload
}: {
    payload: Extract<ToolResult, { kind: 'search_matches' }>
}): React.ReactElement {
    if (payload.matches.length === 0) {
        return <BodyEmpty>(no matches)</BodyEmpty>;
    }
    return (
        <BodyContainer>
            <BodyMeta>
                <BodyMetaItem>{payload.matches.length} matches</BodyMetaItem>
            </BodyMeta>
            <ul className="m-0 list-none">
                {payload.matches.map((match, i) => (
                    <li
                        key={`${match.filepath}-${match.line}-${i}`}
                        className={cn(
                            'flex flex-col gap-0.5',
                            'px-4 py-2',
                            'border-b border-border-subtle last:border-b-0',
                            'font-mono text-xs'
                        )}
                    >
                        <span className="text-text-tertiary">
                            {match.filepath}:{match.line}
                        </span>
                        <code className="text-text-primary whitespace-pre-wrap break-words bg-transparent px-0">
                            {match.text}
                        </code>
                    </li>
                ))}
            </ul>
        </BodyContainer>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatBytes(b: number): string {
    if (b < 1024) { return `${b}B`; }
    if (b < 1024 * 1024) { return `${(b / 1024).toFixed(1)}KB`; }
    return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}