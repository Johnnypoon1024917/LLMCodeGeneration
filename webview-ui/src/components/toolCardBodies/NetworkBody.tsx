
// webview-ui/src/components/toolCardBodies/NetworkBody.tsx
//
// Component 2B-4d: body strategy for "network" tools.
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
// Why we parse the string instead of consuming a structured payload:
// the toolProtocol's ToolResult union doesn't currently have a
// dedicated kind for web fetch. Lifting `kind: 'string'` to a
// proper `kind: 'web_fetch_result'` would touch the protocol, the
// dispatcher, and the frontend mirror — out of scope for 2B-4d.
// The parsing is a controlled hack: we own both the producer
// (web_fetch.ts) and the consumer (this file), so the format
// invariant is enforceable. If the format ever drifts, the
// fallback (verbatim render with a "couldn't parse" note) keeps
// cards functional.
//
// State source: ToolCallState. While running, shows "Fetching…"
// placeholder. web_fetch is atomic (no streaming chunks), so the
// outputBuffer is unused here — the result lands in one shot.
//
// Reuses CSS:
//   - .tool-call-card-empty, .tool-call-card-error (from 2B-4a)
//   - .tool-call-info-body, .tool-call-info-meta, .tool-call-info-meta-item (from 2B-4a)
//   - .tool-call-info-code (from 2B-4a — for the body preview <pre>)
//
// Adds CSS:
//   - .tool-call-net-* family for status chip + URL link

import React from 'react';
import {
    AlertCircle as IconAlert,
    Globe as IconGlobe,
    ExternalLink as IconExternal
} from 'lucide-react';
import type { ToolCallState } from '../../toolEvents';

export interface NetworkBodyProps {
    state: ToolCallState;
}

/**
 * Cap on the body preview length. Cards in chat shouldn't dump a
 * 1MB HTML page at the user. The dispatcher already capped the
 * response body at 1MB before sending; we cap *display* further to
 * keep the chat compact. Full body still reachable via "Open URL"
 * if the user wants to see everything.
 */
const MAX_BODY_PREVIEW_CHARS = 4000;

/**
 * Parsed shape of the web_fetch payload. Optional fields handle
 * the case where parsing partially fails — we extract whatever we
 * can and render the rest verbatim.
 */
interface ParsedWebFetch {
    url?: string;
    status?: number;
    statusText?: string;
    body: string;
    truncated: boolean;
    /**
     * True when parsing succeeded and the URL/status header was
     * cleanly extracted. False means we fell back to verbatim
     * rendering. The card adjusts visuals accordingly.
     */
    parsed: boolean;
}

export function NetworkBody({ state }: NetworkBodyProps): React.ReactElement {
    if (state.status === 'running') {
        return <div className="tool-call-card-empty">Fetching…</div>;
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
    if (payload.kind !== 'string') {
        // Defensive — shouldn't happen for web_fetch but the protocol
        // permits it. Fall back to llmContent as a courtesy.
        return <pre className="tool-call-card-fallback-output">{state.result.llmContent}</pre>;
    }

    const parsed = parseWebFetchPayload(payload.content);

    return (
        <div className="tool-call-info-body">
            {/* Meta header: URL link + status chip + truncation flag */}
            <div className="tool-call-info-meta tool-call-net-meta">
                <IconGlobe size={12} />
                {parsed.url ? (
                    <a
                        href={parsed.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="tool-call-net-url"
                        title={parsed.url}
                    >
                        <span className="tool-call-net-url-text">{parsed.url}</span>
                        <IconExternal size={10} />
                    </a>
                ) : (
                    <span className="tool-call-info-meta-item tool-call-net-url-text">
                        (URL unparseable)
                    </span>
                )}
                {parsed.status !== undefined && (
                    <StatusChip status={parsed.status} statusText={parsed.statusText} />
                )}
                {parsed.truncated && (
                    <span className="tool-call-info-meta-item tool-call-info-truncated">
                        truncated
                    </span>
                )}
            </div>

            {/* Body preview */}
            <BodyPreview body={parsed.body} parsed={parsed.parsed} />
        </div>
    );
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse the structured string emitted by web_fetch's executor.
 * Format (see web_fetch.ts):
 *
 *   URL: <url>
 *   Status: <code> <statusText>
 *   <blank line>
 *   <body>
 *   [response body truncated — exceeded 1MB cap]   ← optional
 *
 * The leading blank line in the dispatcher's output (between
 * `Status:` and the body) gets eaten by the join — we look for
 * the body after the second newline.
 *
 * If parsing fails (header missing, malformed), we set parsed=false
 * and put the entire input into `body`. The caller renders it
 * verbatim with a note.
 */
function parseWebFetchPayload(content: string): ParsedWebFetch {
    // Detect and strip a final truncation notice. The dispatcher
    // appends it as its own line, prefixed with a newline.
    let working = content;
    let truncated = false;
    const truncMatch = working.match(/\n?\[response body truncated[^\]]*\]\s*$/);
    if (truncMatch) {
        truncated = true;
        working = working.substring(0, truncMatch.index ?? 0);
    }

    // Look for "URL: ...\nStatus: ...\n" at the start.
    // The statusText capture must stay on the Status: line — matching
    // [^\n]+ rather than .+? prevents the regex from spilling onto
    // the body if statusText is empty.
    const headerRegex = /^URL:\s*(.+?)\nStatus:\s*(\d+)(?:[ \t]+([^\n]+))?\n/;
    const match = working.match(headerRegex);
    if (!match) {
        // Fall back to verbatim. The card will show the body
        // unparsed but at least visible.
        return {
            body: content,  // include the truncation notice if present
            truncated,
            parsed: false
        };
    }

    const [headerSection, url, statusStr, statusText] = match;
    const status = parseInt(statusStr!, 10);

    // Body is everything after the header. The dispatcher inserts a
    // blank line between Status: and the body, so trim a single
    // leading newline if present.
    let body = working.substring(headerSection!.length);
    if (body.startsWith('\n')) body = body.substring(1);

    return {
        url: url!.trim(),
        status,
        statusText: statusText?.trim(),
        body,
        truncated,
        parsed: true
    };
}

// ─── Status chip ─────────────────────────────────────────────────────

/**
 * Color-coded HTTP status chip:
 *   - 2xx → green ("200 OK")
 *   - 3xx → blue
 *   - 4xx → orange
 *   - 5xx → red
 *   - other → grey
 *
 * The label always shows the numeric code; statusText is appended
 * if non-empty (e.g., "200 OK" vs just "200" if the server didn't
 * include text — uncommon but valid HTTP).
 */
function StatusChip({
    status,
    statusText
}: {
    status: number;
    statusText?: string;
}): React.ReactElement {
    let cls = 'tool-call-net-chip-other';
    if (status >= 200 && status < 300) cls = 'tool-call-net-chip-2xx';
    else if (status >= 300 && status < 400) cls = 'tool-call-net-chip-3xx';
    else if (status >= 400 && status < 500) cls = 'tool-call-net-chip-4xx';
    else if (status >= 500 && status < 600) cls = 'tool-call-net-chip-5xx';

    const label = statusText ? `${status} ${statusText}` : String(status);

    return (
        <span className={`tool-call-net-chip ${cls}`}>
            {label}
        </span>
    );
}

// ─── Body preview ────────────────────────────────────────────────────

/**
 * Render the response body in a scrollable <pre>, capped at
 * MAX_BODY_PREVIEW_CHARS. Empty bodies show a friendly placeholder.
 * If parsing failed, prepend a small note so the user knows the
 * verbatim render is a fallback.
 */
function BodyPreview({
    body,
    parsed
}: {
    body: string;
    parsed: boolean;
}): React.ReactElement {
    if (!body) {
        return <div className="tool-call-info-empty">(empty response body)</div>;
    }

    const truncatedDisplay = body.length > MAX_BODY_PREVIEW_CHARS;
    const displayBody = truncatedDisplay
        ? body.substring(0, MAX_BODY_PREVIEW_CHARS)
        : body;

    return (
        <>
            {!parsed && (
                <div className="tool-call-net-fallback-note">
                    Response format wasn't recognized — showing raw output.
                </div>
            )}
            <pre className="tool-call-info-code tool-call-net-body" tabIndex={0}>
                {displayBody}
                {truncatedDisplay && (
                    <span className="tool-call-net-preview-cut">
                        {`\n\n… preview cut at ${MAX_BODY_PREVIEW_CHARS} characters (full body sent to LLM)`}
                    </span>
                )}
            </pre>
        </>
    );
}