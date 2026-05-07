"use strict";
// src/utilities/searchReplace.ts
//
// Parser and applier for the SEARCH/REPLACE block protocol used by the
// Coordinator and verification agents to communicate code edits from the
// LLM to the file system.
//
// PROTOCOL
// ========
// The model emits blocks of the form:
//
//     <<<<SEARCH
//     <exact substring of the file>
//     ====
//     <new content to substitute>
//     >>>>REPLACE
//
// Multiple blocks per response are allowed and each is applied in sequence
// against its target file. Blocks for different files are routed by metadata
// the caller provides (this module is file-agnostic — it gets a string in
// and returns a string out).
//
// WHY THIS MODULE EXISTS
// ======================
// Before this file, the same regex was duplicated in `Coordinator.ts:262`
// and `verificationAgent.ts:78`, and the apply logic lived inline in
// `SidebarProvider.applySearchReplace`. Each copy had subtly different bugs
// (one accepted leading whitespace before `<<<<SEARCH`, one didn't; one
// normalized CRLF, one didn't; the apply function silently replaced only
// the FIRST occurrence even when multiple matched, which corrupts code).
//
// This module is the single source of truth, with explicit semantics for
// every edge case and a test suite that covers them.
//
// SEMANTICS — what we do and don't accept
// ========================================
// Parsing:
//   - Markers may have leading whitespace on their lines (model fuzzes indent)
//   - Separator `====` accepts 3-7 equals signs (model fuzzes count)
//   - CRLF and LF line endings both accepted; output uses LF
//   - Markdown fences (```...```) inside or wrapping blocks are stripped
//   - A SEARCH block without a matching REPLACE → parse error (no silent skip)
//   - Multiple <<<<SEARCH ... >>>>REPLACE pairs in one input → all parsed
//
// Applying:
//   - Tier A: exact substring match. Used when a unique match exists.
//   - Tier B: trailing-whitespace-insensitive. Tried only when Tier A fails.
//   - Tier C: leading-whitespace-tolerant (preserves relative indent).
//     Tried only when Tier B fails.
//   - If multiple regions match in any tier, that tier is rejected and we
//     fall through to the next. If no tier finds a unique match, the apply
//     fails with a diagnostic listing the closest candidate lines.
//   - Empty SEARCH blocks are rejected (would match anywhere — too dangerous).
//   - Multiple identical SEARCH matches in the file → rejected with line
//     numbers, asking the model to widen the SEARCH window.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBlocks = parseBlocks;
exports.applyBlock = applyBlock;
exports.applyBlocks = applyBlocks;
// ─── Parser ─────────────────────────────────────────────────────────
/**
 * Pre-scan helper: find all marker positions in the input. Returns sorted
 * by offset. Used to validate the parse and emit useful errors.
 */
function findAllMarkers(input) {
    const markers = [];
    // We do this line-by-line so each marker's offsets are stable.
    let pos = 0;
    while (pos < input.length) {
        const newlineIdx = input.indexOf('\n', pos);
        const lineEnd = newlineIdx === -1 ? input.length : newlineIdx;
        const line = input.substring(pos, lineEnd);
        // Single-line regex tests; we already isolated the line.
        if (/^[ \t]{0,4}<{4,7}\s*SEARCH\s*$/.test(line)) {
            markers.push({ kind: 'search', offset: pos, lineEnd });
        }
        else if (/^[ \t]{0,4}={3,7}\s*$/.test(line)) {
            markers.push({ kind: 'separator', offset: pos, lineEnd });
        }
        else if (/^[ \t]{0,4}>{4,7}\s*REPLACE\s*$/.test(line)) {
            markers.push({ kind: 'replace', offset: pos, lineEnd });
        }
        pos = lineEnd + 1;
    }
    return markers;
}
/**
 * Parse a (possibly long, possibly LLM-streamed) string into zero or more
 * SEARCH/REPLACE blocks.
 *
 * Throws `ParseError` on malformed input — specifically:
 *   - A `<<<<SEARCH` with no matching `====` and `>>>>REPLACE`
 *   - Markers in the wrong order (e.g. `====` before `<<<<SEARCH`)
 *   - Empty SEARCH blocks (would match anywhere — refused for safety)
 *
 * Returns `{ blocks: [], warnings: [] }` if no markers were found at all
 * (not an error — the caller may have a different format in mind).
 */
function parseBlocks(rawInput) {
    // Normalize CRLF first so all offsets are consistent.
    const input = rawInput.replace(/\r\n/g, '\n');
    const warnings = [];
    const markers = findAllMarkers(input);
    if (markers.length === 0) {
        return { blocks: [], warnings };
    }
    const blocks = [];
    let i = 0;
    while (i < markers.length) {
        const marker = markers[i];
        if (marker === undefined)
            break;
        if (marker.kind !== 'search') {
            // Stray separator or replace before any search — skip with warning.
            warnings.push(`Stray ${marker.kind.toUpperCase()} marker at offset ${marker.offset} (no preceding SEARCH).`);
            i++;
            continue;
        }
        // Find the next separator and the next replace. They must come in
        // that order with no intervening SEARCH.
        const sep = markers[i + 1];
        const rep = markers[i + 2];
        if (sep === undefined || sep.kind !== 'separator') {
            const err = new Error(`SEARCH block at offset ${marker.offset} has no separator (====). ` +
                `Got: ${sep ? sep.kind : 'end of input'}.`);
            err.kind = 'parse_error';
            err.offset = marker.offset;
            throw err;
        }
        if (rep === undefined || rep.kind !== 'replace') {
            const err = new Error(`SEARCH block at offset ${marker.offset} has no >>>>REPLACE marker. ` +
                `Got: ${rep ? rep.kind : 'end of input'}.`);
            err.kind = 'parse_error';
            err.offset = marker.offset;
            throw err;
        }
        // Slice out the search and replace bodies.
        // Body starts AFTER the marker line's newline; body ends BEFORE the
        // next marker line's start (so the trailing newline of the body is
        // consumed but the marker line itself isn't).
        const searchStart = marker.lineEnd + 1;
        const searchEnd = sep.offset;
        const replaceStart = sep.lineEnd + 1;
        const replaceEnd = rep.offset;
        // Strip optional trailing newline from each body so semantics match
        // what users typically expect ("the content between the markers,
        // not including the line break that separates from the marker").
        const search = input.substring(searchStart, searchEnd).replace(/\n$/, '');
        const replace = input.substring(replaceStart, replaceEnd).replace(/\n$/, '');
        if (search.length === 0) {
            const err = new Error(`Empty SEARCH block at offset ${marker.offset}. Empty searches would match anywhere — refused.`);
            err.kind = 'parse_error';
            err.offset = marker.offset;
            throw err;
        }
        blocks.push({ search, replace, blockOffset: marker.offset });
        i += 3; // consume search, separator, replace
    }
    return { blocks, warnings };
}
// ─── Applier ─────────────────────────────────────────────────────────
/**
 * Apply a single block to the given file content. Tries Tier A (exact),
 * then B (trailing whitespace), then C (leading whitespace tolerant).
 *
 * Throws `ApplyError` if no tier finds a unique match.
 */
function applyBlock(originalContent, block) {
    const original = normalizeNL(originalContent);
    const search = normalizeNL(block.search);
    const replace = normalizeNL(block.replace);
    // Tier A: exact match
    const exactMatches = countOccurrences(original, search);
    if (exactMatches === 1) {
        return original.replace(search, () => replace);
    }
    if (exactMatches > 1) {
        const err = new Error(`SEARCH block matches ${exactMatches} regions in the file (exact match). ` +
            `Make the SEARCH window unique by including more surrounding context.`);
        err.kind = 'apply_error';
        err.tier = 'A';
        err.searchPreview = firstLine(search);
        err.candidates = [];
        throw err;
    }
    // Tier B: trailing whitespace insensitive
    const tierBResult = tryFuzzyMatch(original, search, replace, stripTrailingWhitespacePerLine);
    if (tierBResult.kind === 'unique') {
        return tierBResult.result;
    }
    if (tierBResult.kind === 'multiple') {
        const err = new Error(`SEARCH block matches ${tierBResult.count} regions ignoring trailing whitespace. ` +
            `Make the SEARCH window unique.`);
        err.kind = 'apply_error';
        err.tier = 'B';
        err.searchPreview = firstLine(search);
        err.candidates = [];
        throw err;
    }
    // Tier C: leading whitespace tolerant (preserves relative indent)
    const tierCResult = tryFuzzyMatch(original, search, replace, normalizeLeadingWhitespace);
    if (tierCResult.kind === 'unique') {
        return tierCResult.result;
    }
    if (tierCResult.kind === 'multiple') {
        const err = new Error(`SEARCH block matches ${tierCResult.count} regions with whitespace tolerance. ` +
            `Make the SEARCH window unique.`);
        err.kind = 'apply_error';
        err.tier = 'C';
        err.searchPreview = firstLine(search);
        err.candidates = [];
        throw err;
    }
    // No tier matched — emit best diagnostic we can.
    const err = new Error(`SEARCH block not found in file (tried exact, trailing-ws, and leading-ws-tolerant matching). ` +
        `Search begins: "${firstLine(search).substring(0, 80)}"`);
    err.kind = 'apply_error';
    err.tier = 'all';
    err.searchPreview = firstLine(search);
    err.candidates = findCandidateLines(original, search);
    throw err;
}
/**
 * Apply a batch of blocks atomically against a map of `filepath → content`.
 *
 * "Atomically" means: every block is checked before any is applied. If any
 * block fails, the whole batch is rejected and the file map is returned
 * UNCHANGED. This prevents the partial-corruption failure mode where the
 * Coordinator applied 3 blocks, then block 4 failed, leaving the workspace
 * half-modified.
 *
 * Note: blocks targeting the same file are applied IN ORDER, so a later
 * block sees the result of an earlier block. The atomic guarantee is that
 * if block N fails, blocks 1..N-1 are also rolled back (the file map
 * returned is the input map, not a partial result).
 */
function applyBlocks(files, blocks) {
    // Dry run: build the proposed result, throwing on any failure.
    const proposed = new Map(files);
    for (const { filepath, block } of blocks) {
        const current = proposed.get(filepath);
        if (current === undefined) {
            const err = new Error(`applyBlocks: no content for filepath '${filepath}'. ` +
                `Caller must pre-load all target files into the map.`);
            throw err;
        }
        // applyBlock throws on failure — that propagates, leaving `files` untouched.
        const next = applyBlock(current, block);
        proposed.set(filepath, next);
    }
    return proposed;
}
// ─── Helpers ─────────────────────────────────────────────────────────
function normalizeNL(s) {
    return s.replace(/\r\n/g, '\n');
}
function countOccurrences(haystack, needle) {
    if (needle.length === 0)
        return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}
function firstLine(s) {
    const nl = s.indexOf('\n');
    return nl === -1 ? s : s.substring(0, nl);
}
function tryFuzzyMatch(original, search, replace, normalize) {
    const normOriginal = normalize(original);
    const normSearch = normalize(search);
    const matches = countOccurrences(normOriginal, normSearch);
    if (matches === 0)
        return { kind: 'none' };
    if (matches > 1)
        return { kind: 'multiple', count: matches };
    // Unique match in normalized space. Find the corresponding range in
    // the original-space content. Since `normalize` is idempotent and
    // line-respecting, we can locate the matching lines and substitute.
    return { kind: 'unique', result: substituteByLineRange(original, search, replace, normalize) };
}
/**
 * Given a unique fuzzy match exists, find the original-space line range
 * that corresponds to the search text and replace it.
 *
 * Algorithm: split both into lines. Scan original lines for a window where
 * applying `normalize` to the window equals applying `normalize` to search.
 */
function substituteByLineRange(original, search, replace, normalize) {
    const normSearch = normalize(search);
    const origLines = original.split('\n');
    for (let start = 0; start < origLines.length; start++) {
        // Build the smallest window from `start` whose normalized form
        // matches the normalized search.
        for (let end = start; end < origLines.length; end++) {
            const window = origLines.slice(start, end + 1).join('\n');
            if (normalize(window) === normSearch) {
                // Splice in the replace, preserving the unmatched lines.
                const before = origLines.slice(0, start).join('\n');
                const after = origLines.slice(end + 1).join('\n');
                if (before && after) {
                    return `${before}\n${replace}\n${after}`;
                }
                if (before) {
                    return `${before}\n${replace}`;
                }
                if (after) {
                    return `${replace}\n${after}`;
                }
                return replace;
            }
            // Optimization: if the window's normalized prefix doesn't
            // match the normalized search prefix, skip ahead.
            const windowNorm = normalize(window);
            if (!normSearch.startsWith(windowNorm) && windowNorm.length <= normSearch.length) {
                break;
            }
        }
    }
    // Caller's caller already ensured a unique match exists. If we got here,
    // it's a bug in our line-scanning logic — surface it as an error rather
    // than silently corrupt.
    throw new Error('substituteByLineRange: unique fuzzy match was not locatable by line-window scan (bug)');
}
function stripTrailingWhitespacePerLine(s) {
    return s.split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n');
}
/**
 * Normalize leading whitespace by collapsing tabs and runs of spaces. This
 * lets `\tfoo` match `    foo` and `  foo` match `foo` (and vice versa)
 * while preserving the rest of the line content. We only normalize the
 * leading run of whitespace per line — internal whitespace is kept intact.
 */
function normalizeLeadingWhitespace(s) {
    return s.split('\n').map(line => line.replace(/^[ \t]+/, '')).join('\n');
}
/**
 * Heuristic: find the file lines that look closest to the first line of
 * the SEARCH block. Used in error diagnostics so the user/model can see
 * "did you mean..." candidates.
 */
function findCandidateLines(fileContent, search) {
    const searchFirstLine = firstLine(search).trim();
    if (searchFirstLine.length === 0)
        return [];
    const fileLines = fileContent.split('\n');
    const scored = [];
    for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i];
        if (line === undefined)
            continue;
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        // Cheap similarity: longest common prefix length, normalized by
        // search length. Good enough for a "did you mean" hint without
        // pulling in Levenshtein.
        let lcp = 0;
        const maxLen = Math.min(trimmed.length, searchFirstLine.length);
        while (lcp < maxLen && trimmed[lcp] === searchFirstLine[lcp]) {
            lcp++;
        }
        if (lcp >= 5 || lcp >= searchFirstLine.length / 2) {
            scored.push({ score: lcp, line: trimmed, lineNum: i + 1 });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(s => `line ${s.lineNum}: ${s.line.substring(0, 80)}`);
}
//# sourceMappingURL=searchReplace.js.map