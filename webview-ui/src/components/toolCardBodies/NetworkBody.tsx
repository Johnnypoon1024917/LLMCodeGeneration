// webview-ui/src/components/toolCardBodies/NetworkBody.tsx
//
// Body strategy for "network" tools.
//
// One tool uses this body:
//   - web_fetch → fetch a URL and return its content
//
// Payload shape (from src/agents/tools/web_fetch.ts):
//
//   On success:
//     uiPayload: { kind: 'string', content: <string> }
//
//   The string contains a structured header followed by the body:
//
//     URL: https://example.com
//     Status: 200 OK
//
//     <response body>
//     [response body truncated — exceeded 1MB cap]   ← optional last line
//
//   On failure:
//     uiPayload: { kind: 'error', message: <string> }
//
// We parse the string instead of consuming a structured payload because
// the toolProtocol's ToolResult union doesn't currently have a
// dedicated kind for web fetch. Lifting `kind: 'string'` to a proper
// `kind: 'web_fetch_result'` would touch the protocol, the dispatcher,
// and the frontend mirror — out of scope for this PR. Parsing is a
// controlled hack: we own both the producer (web_fetch.ts) and the
// consumer (this file). If the format ever drifts, the fallback
// (verbatim render with a "couldn't parse" note) keeps cards
// functional.
//
// State source: ToolCallState. While running, shows "Fetching…"
// placeholder. web_fetch is atomic (no streaming), so outputBuffer
// is unused — the result lands in one shot.
//
// PR 2.2 (Sprint 2): visual overhaul. Chrome (meta, error, empty)
// uses shared body atoms + design tokens. Status chip rewritten using
// the Pill primitive — color ramp now matches the security strip.
// parseWebFetchPayload preserved verbatim.

import React from 'react';
import {
    Globe as IconGlobe,
    ExternalLink as IconExternal
} from 'lucide-react';
import type { ToolCallState } from '../../toolEvents';
import { cn } from '../ui/cn';
import { Pill } from '../ui/Pill';
import {
    BodyContainer,
    BodyEmpty,
    BodyError,
    BodyFallbackPre,
    BodyMeta,
    BodyMetaItem
} from './shared';

export interface NetworkBodyProps {
    state: ToolCallState;
}

const MAX_BODY_PREVIEW_CHARS = 4000;

interface ParsedWebFetch {
    url?: string;
    status?: number;
    statusText?: string;
    body: string;
    truncated: boolean;
    /** True when parsing succeeded and the URL/status header was
     *  cleanly extracted. False means we fell back to verbatim
     *  rendering. The card adjusts visuals accordingly. */
    parsed: boolean;
}

export function NetworkBody({ state }: NetworkBodyProps): React.ReactElement {
    if (state.status === 'running') {
        return <BodyEmpty>Fetching…</BodyEmpty>;
    }
    if (state.result?.uiPayload.kind === 'error') {
        return <BodyError message={state.result.uiPayload.message} />;
    }
    if (!state.result) {
        return <BodyEmpty>(no result)</BodyEmpty>;
    }

    const payload = state.result.uiPayload;
    if (payload.kind !== 'string') {
        return <BodyFallbackPre>{state.result.llmContent}</BodyFallbackPre>;
    }

    const parsed = parseWebFetchPayload(payload.content);

    return (
        <BodyContainer>
            <BodyMeta className="flex-wrap">
                <IconGlobe size={12} className="text-text-tertiary shrink-0" />
                {parsed.url ? (
                    <a
                        href={parsed.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={parsed.url}
                        className={cn(
                            'inline-flex items-center gap-1 min-w-0 flex-1',
                            'text-text-link no-underline hover:underline',
                            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus rounded-xs'
                        )}
                    >
                        <span className="truncate min-w-0 max-w-full">
                            {parsed.url}
                        </span>
                        <IconExternal size={10} className="shrink-0" />
                    </a>
                ) : (
                    <BodyMetaItem className="text-text-tertiary">
                        (URL unparseable)
                    </BodyMetaItem>
                )}
                {parsed.status !== undefined && (
                    <StatusChip
                        status={parsed.status}
                        {...(parsed.statusText !== undefined
                            ? { statusText: parsed.statusText }
                            : {})}
                    />
                )}
                {parsed.truncated && (
                    <BodyMetaItem truncated>truncated</BodyMetaItem>
                )}
            </BodyMeta>
            <BodyPreview body={parsed.body} parsed={parsed.parsed} />
        </BodyContainer>
    );
}

// ─── Parsing (preserved verbatim) ────────────────────────────────────

function parseWebFetchPayload(content: string): ParsedWebFetch {
    let working = content;
    let truncated = false;
    const truncMatch = working.match(/\n?\[response body truncated[^\]]*\]\s*$/);
    if (truncMatch) {
        truncated = true;
        working = working.substring(0, truncMatch.index ?? 0);
    }

    const headerRegex = /^URL:\s*(.+?)\nStatus:\s*(\d+)(?:[ \t]+([^\n]+))?\n/;
    const match = working.match(headerRegex);
    if (!match) {
        return {
            body: content,
            truncated,
            parsed: false
        };
    }

    const [headerSection, url, statusStr, statusText] = match;
    const status = parseInt(statusStr!, 10);

    let body = working.substring(headerSection!.length);
    if (body.startsWith('\n')) body = body.substring(1);

    return {
        url: url!.trim(),
        status,
        ...(statusText !== undefined ? { statusText: statusText.trim() } : {}),
        body,
        truncated,
        parsed: true as const
    };
}

// ─── Status chip ─────────────────────────────────────────────────────

/**
 * HTTP status chip using Pill. Color follows the standard ramp:
 *   - 2xx → secure (green)
 *   - 3xx → info (blue)
 *   - 4xx → pending (orange)
 *   - 5xx → blocked (red)
 *   - other → neutral
 *
 * Label always shows numeric code; statusText is appended if non-empty.
 */
function StatusChip({
    status,
    statusText
}: {
    status: number;
    statusText?: string;
}): React.ReactElement {
    let variant: 'secure' | 'info' | 'pending' | 'blocked' | 'neutral' = 'neutral';
    if (status >= 200 && status < 300) variant = 'secure';
    else if (status >= 300 && status < 400) variant = 'info';
    else if (status >= 400 && status < 500) variant = 'pending';
    else if (status >= 500 && status < 600) variant = 'blocked';

    const label = statusText ? `${status} ${statusText}` : String(status);

    return (
        <Pill variant={variant} className="font-mono">
            {label}
        </Pill>
    );
}

// ─── Body preview ────────────────────────────────────────────────────

function BodyPreview({
    body,
    parsed
}: {
    body: string;
    parsed: boolean;
}): React.ReactElement {
    if (!body) {
        return <BodyEmpty>(empty response body)</BodyEmpty>;
    }

    const truncatedDisplay = body.length > MAX_BODY_PREVIEW_CHARS;
    const displayBody = truncatedDisplay
        ? body.substring(0, MAX_BODY_PREVIEW_CHARS)
        : body;

    return (
        <>
            {!parsed && (
                <div
                    className={cn(
                        'px-4 py-2',
                        'text-xs text-status-pending italic',
                        'bg-status-pending-bg/40 border-b border-status-pending/20'
                    )}
                >
                    Response format wasn't recognized — showing raw output.
                </div>
            )}
            <pre
                tabIndex={0}
                className={cn(
                    'px-4 py-3 m-0',
                    'font-mono text-xs leading-relaxed',
                    'bg-surface-base text-text-secondary',
                    'whitespace-pre-wrap break-all',
                    'max-h-80 overflow-auto',
                    'outline-none focus:ring-1 focus:ring-border-focus focus:ring-inset'
                )}
            >
                {displayBody}
                {truncatedDisplay && (
                    <span className="block mt-2 text-status-pending italic">
                        {`\n\n… preview cut at ${MAX_BODY_PREVIEW_CHARS} characters (full body sent to LLM)`}
                    </span>
                )}
            </pre>
        </>
    );
}