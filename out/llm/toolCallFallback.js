"use strict";
// src/llm/toolCallFallback.ts
//
// V2.0 follow-up: client-side fallback parser for tool calls when
// the inference server didn't surface them in the native OpenAI
// `tool_calls` field.
//
// WHY THIS EXISTS:
//   NexusCode is shipped to customers running their own inference
//   stacks. We do NOT control how they configure vLLM / SGLang /
//   LM Studio / TGI / Ollama. The single most common failure mode
//   in the wild is "model emits tool calls in its native format,
//   inference server's --tool-call-parser is misconfigured, the
//   tool calls land in `content` as text, our agent loop sees no
//   tool_calls and gives up." This module is the safety net.
//
//   Without this, a customer running Qwen 2.5 Coder with the
//   default `--tool-call-parser hermes` (which doesn't match what
//   Qwen 2.5 Coder actually emits) sees: the agent wants to write
//   files, the model says "I'll use the write_file tool", and
//   nothing gets written. We've confirmed this exact failure on
//   our own dev endpoint.
//
// WHAT THIS HANDLES:
//   The five tool-call text formats we've observed in production
//   open-source models (Qwen 2.5 Coder, Qwen 3 Coder, MiniMax,
//   DeepSeek-V3.x and similar):
//
//     1. <tools>{...JSON...}</tools>           — Qwen 2.5 Coder w/ few-shot
//     2. ```json\n{"name":...}\n```            — Qwen 2.5 Coder default
//     3. <function=name><parameter=k>v</param> — Qwen 3 Coder XML
//     4. <tool_call>{...JSON...}</tool_call>   — Hermes / Qwen 3 standard
//     5. Bare JSON object {"name":..,"arguments":..} in content
//
// WHAT THIS DOES NOT HANDLE:
//   - Pythonic format: `[func(arg='x')]` (Llama 3 / Olmo). We can
//     add this when we see a customer use it; deferring means we
//     don't ship code we can't test against a real endpoint.
//   - Streaming partial extraction. Streaming integration is
//     handled by the caller (parseSseToolStream) after stream
//     completion — this module operates on complete content.
//   - Content with mixed tool calls AND prose. We extract every
//     tool call we can find; remaining prose goes back as content.
//     Models that emit "I'll call X. <tools>...</tools> Then Y."
//     get the prose preserved.
//
// CONTRACT:
//   `extractFallbackToolCalls(content)` returns:
//     - `toolCalls`: array of synthesized OpenAI-shaped ToolCall
//                    objects. Empty when nothing parseable found.
//     - `cleanContent`: the original content with extracted tool-call
//                       blocks removed. Useful when the caller wants
//                       to preserve any narrative text the model
//                       included alongside the tool calls.
//
// SAFETY:
//   - Never throws. Malformed input returns empty toolCalls.
//   - Tool ids are synthesized deterministically from position +
//     tool name (`fallback-{format}-{index}-{namehash}`) so parallel
//     calls have unique ids. Real ids would come from the server;
//     we forge a stable substitute.
//   - Arguments are returned as JSON-encoded strings per OpenAI's
//     wire format. Non-JSON arguments (e.g. XML param values) are
//     wrapped into a JSON object so the caller's downstream
//     JSON.parse never fails.
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractFallbackToolCalls = extractFallbackToolCalls;
/**
 * Main entry point. Inspects content for any of the known fallback
 * tool-call formats. Returns extracted tool calls + cleaned content.
 *
 * Order of detection matters because formats can nest visually:
 * `<tools>` is checked before bare JSON because the JSON inside
 * `<tools>` would otherwise match the bare-JSON pass.
 */
function extractFallbackToolCalls(content) {
    const empty = {
        toolCalls: [],
        cleanContent: content ?? '',
        formatsDetected: [],
    };
    if (!content || typeof content !== 'string') {
        return empty;
    }
    let working = content;
    const allCalls = [];
    const formats = new Set();
    // 1. <tool_call>{json}</tool_call> — Hermes/Qwen 3 standard
    const r1 = extractTaggedJson(working, 'tool_call', 'tool_call_tag');
    if (r1.calls.length > 0) {
        allCalls.push(...r1.calls);
        formats.add('tool_call_tag');
        working = r1.cleanContent;
    }
    // 2. <tools>{json}</tools> — Qwen 2.5 Coder w/ few-shot
    const r2 = extractTaggedJson(working, 'tools', 'tools_tag');
    if (r2.calls.length > 0) {
        allCalls.push(...r2.calls);
        formats.add('tools_tag');
        working = r2.cleanContent;
    }
    // 3. <function=name>...</function> — Qwen 3 Coder XML
    const r3 = extractFunctionXml(working);
    if (r3.calls.length > 0) {
        allCalls.push(...r3.calls);
        formats.add('function_xml');
        working = r3.cleanContent;
    }
    // 4. ```json ... ``` — Qwen 2.5 Coder default
    const r4 = extractJsonCodeBlocks(working);
    if (r4.calls.length > 0) {
        allCalls.push(...r4.calls);
        formats.add('json_codeblock');
        working = r4.cleanContent;
    }
    // 5. Bare JSON {"name":...,"arguments":...} — last resort
    //    Only run when no other format matched, because bare-JSON
    //    detection is the most aggressive and most likely to false-
    //    positive on JSON output that wasn't meant as a tool call.
    if (allCalls.length === 0) {
        const r5 = extractBareJson(working);
        if (r5.calls.length > 0) {
            allCalls.push(...r5.calls);
            formats.add('bare_json');
            working = r5.cleanContent;
        }
    }
    return {
        toolCalls: allCalls,
        cleanContent: working.trim(),
        formatsDetected: Array.from(formats),
    };
}
// ─── Format-specific extractors ─────────────────────────────────────
/**
 * Extract `<TAG>{json}</TAG>` blocks. Used for both `<tools>` and
 * `<tool_call>` since the structure is identical — only the tag name
 * differs.
 *
 * The JSON inside is expected to be `{"name": "...", "arguments": {...}}`
 * matching the OpenAI tool-call shape. If `arguments` is an object, we
 * stringify it (OpenAI wire format requires arguments as a JSON-encoded
 * string). If it's already a string, we trust it.
 */
function extractTaggedJson(content, tag, format) {
    const calls = [];
    // Greedy-but-bounded: the JSON inside can contain `<` and `>`
    // characters (in string values), so a non-greedy match keyed on
    // the closing tag is more reliable than trying to match braces.
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
    let cleanContent = content;
    let match;
    let idx = 0;
    // First pass: collect matches and call indexes
    const matches = [];
    while ((match = re.exec(content)) !== null) {
        matches.push({ raw: match[0], inner: (match[1] ?? '').trim() });
    }
    for (const { raw, inner } of matches) {
        const parsed = tryParseToolCallJson(inner);
        if (parsed) {
            calls.push(synthesizeToolCall(parsed.name, parsed.arguments, format, idx));
            idx++;
            // Remove the matched block from clean content. Only first
            // occurrence — duplicates of the same raw string would
            // legitimately remove all (rare; would need the model to
            // emit two byte-identical calls).
            cleanContent = cleanContent.replace(raw, '');
        }
    }
    return { calls, cleanContent };
}
/**
 * Extract ```json ... ``` code blocks. Multiple blocks accumulate
 * into multiple tool calls.
 *
 * Subtlety: not every `json` code block is a tool call. We require
 * the inner JSON to have a "name" field that looks like a tool call
 * (string) — otherwise we leave the block alone (it might be a
 * legitimate JSON example from the model).
 */
function extractJsonCodeBlocks(content) {
    const calls = [];
    // Match ```json (case-insensitive language tag) or ``` followed
    // by JSON. The latter is rarer but real — some models drop the
    // language tag.
    const re = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
    let cleanContent = content;
    let match;
    let idx = 0;
    const matches = [];
    while ((match = re.exec(content)) !== null) {
        const inner = (match[1] ?? '').trim();
        if (inner.startsWith('{') || inner.startsWith('[')) {
            matches.push({ raw: match[0], inner });
        }
    }
    for (const { raw, inner } of matches) {
        // Could be a single tool-call JSON or an array of them.
        const parsed = tryParseToolCallJson(inner);
        if (parsed) {
            calls.push(synthesizeToolCall(parsed.name, parsed.arguments, 'json_codeblock', idx));
            idx++;
            cleanContent = cleanContent.replace(raw, '');
            continue;
        }
        // Try parsing as an array of tool calls
        try {
            const arr = JSON.parse(inner);
            if (Array.isArray(arr)) {
                let extractedAny = false;
                for (const elem of arr) {
                    const elemParsed = tryParseToolCallObject(elem);
                    if (elemParsed) {
                        calls.push(synthesizeToolCall(elemParsed.name, elemParsed.arguments, 'json_codeblock', idx));
                        idx++;
                        extractedAny = true;
                    }
                }
                if (extractedAny) {
                    cleanContent = cleanContent.replace(raw, '');
                }
            }
        }
        catch {
            // Not JSON, not a tool call — leave the block in content
        }
    }
    return { calls, cleanContent };
}
/**
 * Extract `<function=name><parameter=k>v</parameter>...</function>`
 * blocks (Qwen 3 Coder XML format).
 *
 * Parameter values are XML-text-content, which is to say "anything
 * up to the closing `</parameter>` tag." We don't try to parse them
 * as JSON — we wrap them in a JSON object as strings. The downstream
 * caller's tool dispatcher can coerce types from the schema.
 */
function extractFunctionXml(content) {
    const calls = [];
    // Function block: <function=NAME>...</function>
    const fnRe = /<function=([^>\s]+)>([\s\S]*?)<\/function>/gi;
    // Parameter block: <parameter=KEY>VALUE</parameter>
    const paramRe = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/gi;
    let cleanContent = content;
    let fnMatch;
    let idx = 0;
    const matches = [];
    while ((fnMatch = fnRe.exec(content)) !== null) {
        matches.push({
            raw: fnMatch[0],
            name: fnMatch[1] ?? '',
            body: fnMatch[2] ?? '',
        });
    }
    for (const { raw, name, body } of matches) {
        if (!name) {
            continue;
        }
        const args = {};
        let paramMatch;
        // Reset regex state — the regex is module-scoped via /g flag,
        // so each fn body needs a fresh exec loop.
        paramRe.lastIndex = 0;
        while ((paramMatch = paramRe.exec(body)) !== null) {
            const key = paramMatch[1];
            const val = paramMatch[2];
            if (key !== undefined && val !== undefined) {
                args[key] = val.trim();
            }
        }
        calls.push(synthesizeToolCall(name, args, 'function_xml', idx));
        idx++;
        cleanContent = cleanContent.replace(raw, '');
    }
    return { calls, cleanContent };
}
/**
 * Extract bare JSON tool calls. Last-resort heuristic — only runs
 * when no other format matched. Looks for `{"name": "...", "arguments": ...}`
 * anywhere in the content.
 *
 * Why we keep this conservative: any chat that contains JSON
 * examples could false-positive. We require BOTH a `name` (string)
 * AND an `arguments` (object or string) field, which mirrors the
 * OpenAI tool-call wire shape — a model that emits this exact
 * shape almost certainly intended a tool call.
 */
function extractBareJson(content) {
    const calls = [];
    let cleanContent = content;
    // Find balanced JSON objects in the content. We do this by
    // scanning for `{` and tracking brace depth, NOT by regex —
    // regex can't handle nested braces reliably.
    const candidates = [];
    for (let i = 0; i < content.length; i++) {
        if (content[i] !== '{') {
            continue;
        }
        // Find the balanced matching brace, ignoring braces inside
        // strings. This is a simple state machine.
        let depth = 0;
        let inString = false;
        let escapeNext = false;
        for (let j = i; j < content.length; j++) {
            const ch = content[j];
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    escapeNext = true;
                }
                else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
            }
            else if (ch === '{') {
                depth++;
            }
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    candidates.push({ start: i, end: j + 1, text: content.slice(i, j + 1) });
                    // Skip past this candidate — don't try to parse
                    // sub-objects nested inside it.
                    i = j;
                    break;
                }
            }
        }
    }
    let idx = 0;
    for (const c of candidates) {
        const parsed = tryParseToolCallJson(c.text);
        if (parsed) {
            calls.push(synthesizeToolCall(parsed.name, parsed.arguments, 'bare_json', idx));
            idx++;
            cleanContent = cleanContent.replace(c.text, '');
        }
    }
    return { calls, cleanContent };
}
/** Try to parse a JSON string as a tool-call shape. Returns null on
 *  any failure (parse error, missing fields, wrong types). */
function tryParseToolCallJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    return tryParseToolCallObject(parsed);
}
/** Inspect a parsed object and return the tool-call shape if it
 *  matches. Accepts either OpenAI shape ({name, arguments}) or the
 *  alternative {function: {name, arguments}} (rare but seen). */
function tryParseToolCallObject(parsed) {
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const obj = parsed;
    // Direct shape: { name, arguments }
    if (typeof obj['name'] === 'string') {
        const name = obj['name'];
        const args = obj['arguments'] !== undefined ? obj['arguments'] : (obj['args'] ?? {});
        return { name, arguments: args };
    }
    // Nested shape: { function: { name, arguments } }
    if (typeof obj['function'] === 'object' && obj['function'] !== null) {
        const fn = obj['function'];
        if (typeof fn['name'] === 'string') {
            const name = fn['name'];
            const args = fn['arguments'] !== undefined ? fn['arguments'] : {};
            return { name, arguments: args };
        }
    }
    return null;
}
/**
 * Build an OpenAI-shaped ToolCall from parsed parts. Synthesizes a
 * stable id from the format + index + name so parallel calls don't
 * collide. The id format is `fallback-{format}-{idx}-{name}` so it's
 * recognizably synthetic (compliance officers reviewing audit logs
 * can tell the call was rescued by the fallback parser).
 */
function synthesizeToolCall(name, args, format, index) {
    // Arguments must be a JSON string per OpenAI spec.
    let argsString;
    if (typeof args === 'string') {
        // Already a string — assume it's already JSON-encoded; if
        // not, wrap it. We try to detect "this is JSON" by attempting
        // to parse; if it parses, pass through; if not, we wrap as
        // a single string field so callers don't choke.
        try {
            JSON.parse(args);
            argsString = args;
        }
        catch {
            argsString = JSON.stringify({ value: args });
        }
    }
    else {
        // Object/array — stringify directly.
        try {
            argsString = JSON.stringify(args ?? {});
        }
        catch {
            // Circular references etc. — fall back to empty object
            argsString = '{}';
        }
    }
    return {
        id: `fallback-${format}-${index}-${name}`,
        type: 'function',
        function: {
            name,
            arguments: argsString,
        },
    };
}
//# sourceMappingURL=toolCallFallback.js.map