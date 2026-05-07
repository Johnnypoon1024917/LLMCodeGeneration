"use strict";
// src/agents/tools/web_fetch.ts
//
// Fetch a URL and return the body. Q1=1C catalog item.
//
// SECURITY SURFACE: Network egress on the user's machine. Implications:
//   - Internal network access (the workstation can reach intranet
//     resources the LLM endpoint can't). The LLM could be tricked
//     by prompt injection in another tool's output to fetch a
//     credential-bearing internal URL.
//   - DNS rebinding / SSRF risks if the LLM is talked into fetching
//     localhost or 169.254.169.254 (cloud metadata).
//
// 2B-2 ships with a minimal mitigations: HTTPS allowed, HTTP allowed,
// content-length cap, timeout. The Coordinator (in 2B-3) can wire
// in URL allowlist policy via the same hook point as bash_exec's
// security check. For now, the tool exists but customers running on
// a restricted network may want to disable it.
//
// The LLM-bound content is the response body, truncated to a budget.
// The UI gets the body too plus status code metadata.
Object.defineProperty(exports, "__esModule", { value: true });
const toolRegistry_1 = require("../toolRegistry");
const definition = {
    type: 'function',
    function: {
        name: 'web_fetch',
        description: "Fetch a URL and return its content as text. Useful for reading documentation, API specs, or other web resources. The response is capped at 1MB; use a more specific URL if the page is too large.",
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: "The URL to fetch (https:// or http://)." }
            },
            required: ['url']
        }
    }
};
const MAX_BYTES = 1024 * 1024; // 1 MB
const TIMEOUT_MS = 30 * 1000;
const LLM_CONTENT_CAP = 64 * 1024; // 64 KB to the LLM
const executor = async (args, ctx) => {
    const url = String(args['url'] ?? '');
    if (!url) {
        return {
            llmContent: "Error: 'url' argument is required.",
            uiPayload: { kind: 'error', message: "'url' argument is required." }
        };
    }
    // Basic scheme check. http/https only.
    if (!/^https?:\/\//i.test(url)) {
        const msg = `URL must use http:// or https:// scheme. Got: ${url.substring(0, 50)}`;
        return {
            llmContent: `Error: ${msg}`,
            uiPayload: { kind: 'error', message: msg }
        };
    }
    // Compose abort signal from caller's signal (per-task cancel) and
    // a timeout. Both should be honored — whichever fires first wins.
    const localAbort = new AbortController();
    const timer = setTimeout(() => localAbort.abort(), TIMEOUT_MS);
    const onCallerAbort = () => localAbort.abort();
    if (ctx.signal) {
        if (ctx.signal.aborted) {
            localAbort.abort();
        }
        else {
            ctx.signal.addEventListener('abort', onCallerAbort, { once: true });
        }
    }
    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: localAbort.signal,
            headers: {
                'User-Agent': 'NexusCode/1.0 (web_fetch tool)'
            }
        });
        // Read body with byte cap. We use response.body as a stream so
        // we can stop reading early if the response is huge — avoids
        // pulling a 100MB page into memory just to truncate it.
        let bodyText = '';
        let bytesRead = 0;
        let truncated = false;
        if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    bytesRead += value.byteLength;
                    if (bytesRead > MAX_BYTES) {
                        truncated = true;
                        // Append the portion of this chunk that fits within the cap.
                        const remaining = MAX_BYTES - (bytesRead - value.byteLength);
                        if (remaining > 0) {
                            bodyText += decoder.decode(value.subarray(0, remaining), { stream: true });
                        }
                        break;
                    }
                    bodyText += decoder.decode(value, { stream: true });
                }
                bodyText += decoder.decode();
            }
            finally {
                try {
                    reader.releaseLock();
                }
                catch { /* ignore */ }
            }
        }
        else {
            bodyText = await response.text();
        }
        const status = response.status;
        const llmHeader = `URL: ${url}\nStatus: ${status} ${response.statusText}\n`;
        const llmBody = bodyText.length > LLM_CONTENT_CAP
            ? bodyText.substring(0, LLM_CONTENT_CAP) + '\n[truncated for token budget]'
            : bodyText;
        const truncationNotice = truncated ? '\n[response body truncated — exceeded 1MB cap]' : '';
        return {
            llmContent: llmHeader + llmBody + truncationNotice,
            uiPayload: {
                kind: 'string',
                content: `${llmHeader}\n${bodyText}${truncationNotice}`
            }
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            llmContent: `Error fetching ${url}: ${msg}`,
            uiPayload: { kind: 'error', message: `Web fetch failed: ${msg}` }
        };
    }
    finally {
        clearTimeout(timer);
        if (ctx.signal)
            ctx.signal.removeEventListener('abort', onCallerAbort);
    }
};
(0, toolRegistry_1.registerTool)(definition, executor);
//# sourceMappingURL=web_fetch.js.map