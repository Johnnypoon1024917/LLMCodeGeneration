"use strict";
// src/diagnostics/startupTiming.ts
//
// PR P3.2: cold-start instrumentation for the extension host.
//
// What this records:
//   - Phase timestamps during extension activation
//   - Time from extension-load to specific milestones (audit init,
//     services wired, webview registered)
//
// What this does NOT record:
//   - Webview cold paint. That requires browser-side instrumentation
//     in webview-ui/src/App.tsx — see startupTiming.tsx in webview-ui
//     (separate file, separate runtime).
//   - LLM call latency. That's already in the audit log.
//   - Tool-call duration. Same — already in audit log.
//
// API:
//   - mark(name): record a milestone with current performance.now()
//   - getMarks(): inspect the recorded marks
//   - reset(): clear the buffer (test-only)
//
// The marks are written into an in-process ring buffer (capped to
// keep memory bounded if someone calls mark() in a loop). Anyone
// who wants to surface them in the diagnostics panel can query the
// snapshot via getMarks() and forward to the webview.
Object.defineProperty(exports, "__esModule", { value: true });
exports.mark = mark;
exports.getMarks = getMarks;
exports.getMarksRelative = getMarksRelative;
exports.durationBetween = durationBetween;
exports.resetForTests = resetForTests;
const MAX_MARKS = 100;
const marks = [];
/**
 * Record a timing mark. The name should be a stable identifier so
 * downstream consumers can look up specific phases. Use dotted
 * notation for hierarchy ('activate.audit.start' vs '.done' etc.).
 *
 * Idempotent — calling with the same name twice records two marks.
 * That's intentional: a phase that fires multiple times (e.g.
 * config reload) is meaningful to track.
 */
function mark(name) {
    // performance.now() is available in Node 16+ via the global.
    // The extension host runtime is Electron-Node-based and exposes it.
    const ts = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    marks.push({ name, timestamp: ts });
    // Bound the buffer. We keep the most recent MAX_MARKS so that
    // a long-running session that re-marks doesn't grow unbounded.
    if (marks.length > MAX_MARKS) {
        marks.shift();
    }
}
/**
 * Returns a snapshot of recorded marks. The array is a copy — the
 * caller can sort, filter, or otherwise transform without affecting
 * future writes.
 */
function getMarks() {
    return [...marks];
}
/**
 * Compute the elapsed-time-from-start delta for each mark. Convenience
 * over the raw timestamps for displays that want "how long after
 * activation did X happen."
 *
 * Returns an array of {name, sinceStartMs} where sinceStartMs is
 * relative to the FIRST mark in the buffer (treated as t=0). If the
 * buffer is empty, returns [].
 */
function getMarksRelative() {
    if (marks.length === 0) {
        return [];
    }
    const t0 = marks[0].timestamp;
    return marks.map((m) => ({
        name: m.name,
        sinceStartMs: m.timestamp - t0,
    }));
}
/**
 * Compute the duration between two named marks. Returns null when
 * either is missing. Uses the FIRST occurrence of `from` and the
 * LAST occurrence of `to` — captures "the longest span over the
 * whole session" semantics for repeating marks.
 */
function durationBetween(from, to) {
    const fromMark = marks.find((m) => m.name === from);
    if (!fromMark) {
        return null;
    }
    const toMarks = marks.filter((m) => m.name === to);
    const toMark = toMarks[toMarks.length - 1];
    if (!toMark) {
        return null;
    }
    return toMark.timestamp - fromMark.timestamp;
}
/**
 * Test-only: clear all marks. Each test should start with a fresh
 * buffer to avoid cross-test contamination.
 */
function resetForTests() {
    marks.length = 0;
}
//# sourceMappingURL=startupTiming.js.map