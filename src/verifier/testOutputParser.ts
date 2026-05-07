// src/verifier/testOutputParser.ts
//
// P1.1 (2026-05): structured test-failure extraction.
//
// Before this module, when a TDD test run failed in VerifierAgent, the
// Coder retry got a 2000-char raw-output blob attached as a single
// VerifierFailure. The Coder had to parse free text to figure out
// which test failed, in which file, on which line, with which
// expected/actual values. That defeated the structured-failure
// pipeline (formatErrorHint(), per-error retry coaching) which works
// well for compile errors.
//
// This module fills that gap: parse raw output → structured
// PerTestFailure[]. The caller (VerifierAgent) then emits one
// VerifierFailure per parsed failure rather than one summarizing the
// whole run.
//
// Frameworks supported:
//   - Jest      (matches the dominant Node test framework output)
//   - Vitest    (similar shape to Jest, slight format differences)
//   - Pytest    (Python; very different output but bounded patterns)
//
// What this is NOT:
//   - A complete test-result parser. We extract failures only — passes
//     and skipped tests aren't tracked here (Verifier doesn't need
//     them).
//   - A guaranteed-correct parser for every test framework version.
//     Frameworks change output formats over time. The patterns here
//     match current major versions (Jest 29.x, Vitest 1.x-2.x,
//     pytest 7.x-8.x). Older versions may produce un-parseable output;
//     in that case the caller falls back to whole-blob behavior.
//   - A framework-flag injection layer. We don't add `--json` or
//     `--reporters=json` to the test command — that would be
//     auto-discovered project-config tampering. We work with whatever
//     output the project's own test command produces.

/** One extracted test failure. */
export interface PerTestFailure {
    /** Framework that produced this failure, for diagnostics. */
    framework: 'jest' | 'vitest' | 'pytest';
    /** Human-readable test name, like "describes addition > sums two numbers".
     *  May be undefined if the parser couldn't isolate it. */
    testName?: string;
    /** Test file path, relative to workspace root. May be undefined if the
     *  failure couldn't be attributed to a specific file (rare). */
    file?: string;
    /** 1-indexed line in the test file where assertion failed. May be
     *  undefined if the parser couldn't extract a frame. */
    line?: number;
    /** Brief failure message — typically the assertion error or first
     *  line of the stack trace. Capped at 500 chars by the caller's
     *  retry-prompt budgeting; we don't truncate here. */
    message: string;
    /** Expected value, when the failure was an assertion with a clear
     *  expected/actual split (jest's toEqual, etc.). */
    expected?: string;
    /** Actual value, when extractable. */
    actual?: string;
}

/**
 * Parse raw test-runner stdout/stderr into per-test failures.
 *
 * Returns an empty array if no framework could be detected or no
 * failures were extractable. The caller (VerifierAgent) treats empty
 * as "fall back to single whole-blob VerifierFailure" rather than
 * "tests passed" — passes are determined by the runner's exit code,
 * not by this parser's output.
 */
export function parseTestOutput(rawOutput: string): PerTestFailure[] {
    const framework = detectFramework(rawOutput);
    if (!framework) { return []; }

    if (framework === 'jest')   { return parseJestOutput(rawOutput); }
    if (framework === 'vitest') { return parseVitestOutput(rawOutput); }
    if (framework === 'pytest') { return parsePytestOutput(rawOutput); }

    return [];
}

/**
 * Heuristic framework detection. Looks for distinctive output markers
 * that each framework prints on every run. False positives are
 * possible but the per-framework parsers tolerate "wrong-framework
 * input" by returning empty — so a misclassification just means we
 * fall back to whole-blob.
 */
function detectFramework(s: string): 'jest' | 'vitest' | 'pytest' | null {
    // Pytest is the most distinctive — has its own banner.
    if (/^={5,}\s*test session starts\s*={5,}/m.test(s)) { return 'pytest'; }
    if (/^FAILED\s+\S+::/m.test(s)) { return 'pytest'; }
    // Vitest specifically prefixes file failure summaries with "FAIL".
    // Note: Jest also uses "FAIL" sometimes, so we check for vitest-
    // specific markers too. The "RERUN" or "Vitest" name typically
    // appears.
    if (/(?:^|\n)\s*(?:RERUN|Vitest|❯)/m.test(s) && /FAIL\s+/m.test(s)) {
        return 'vitest';
    }
    // Jest: "● <name>" failure markers + "Tests:" summary.
    if (/^\s*●\s/m.test(s)) { return 'jest'; }
    if (/Tests:\s+\d+\s+failed/m.test(s)) { return 'jest'; }
    // Vitest fallback (simpler signal).
    if (/^\s*(?:✓|×|❯)\s/m.test(s) && /\.test\./.test(s)) { return 'vitest'; }
    return null;
}

// ─── Jest ───────────────────────────────────────────────────────────

/**
 * Jest failure shape (default reporter):
 *
 *   FAIL  src/foo.test.ts
 *     describe block
 *       ● describe block > it block name
 *
 *         expect(received).toBe(expected) // Object.is equality
 *
 *         Expected: 4
 *         Received: 5
 *
 *           23 |   it('adds', () => {
 *           24 |     const r = add(2, 2);
 *         > 25 |     expect(r).toBe(4);
 *              |                ^
 *           26 |   });
 *           27 | });
 *
 *           at Object.<anonymous> (src/foo.test.ts:25:18)
 */
function parseJestOutput(raw: string): PerTestFailure[] {
    const failures: PerTestFailure[] = [];
    // Split on the "●" marker. Each chunk after the first is one
    // failure. The first chunk is preamble (FAIL <file>, etc).
    const chunks = raw.split(/\n\s*●\s+/);
    if (chunks.length < 2) { return failures; }

    // Recover the file from any preceding "FAIL <path>" line. We
    // walk forward through each chunk and keep the most-recent
    // "FAIL <path>" we've seen, since multiple files can fail in
    // one run.
    let currentFile: string | undefined;
    // Re-scan including chunk-0 to pick up the FAIL marker.
    const fullText = raw;
    const failMatches = [...fullText.matchAll(/(?:^|\n)\s*FAIL\s+(\S+)/g)];

    for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        // Test name is everything up to the first newline.
        const firstLine = chunk.split('\n', 1)[0]!.trim();
        const testName = firstLine || undefined;

        // Extract file + line from the first stack frame inside this
        // chunk. Look for "at <something> (<file>:<line>:<col>)" or
        // bare "at <file>:<line>:<col>".
        const frameMatch = chunk.match(/at\s+(?:[^\s(]+\s*\()?(?<file>[^\s():]+):(?<line>\d+):\d+\)?/);
        const fileFromFrame = frameMatch?.groups?.['file'];
        const lineFromFrame = frameMatch?.groups?.['line'];

        // If no frame, fall back to the most-recent FAIL marker.
        if (fileFromFrame) {
            currentFile = fileFromFrame;
        } else if (failMatches.length > 0) {
            // Use FAIL marker that's textually nearest before this chunk.
            // Approximation: just use the first one. Multiple-file failures
            // are rare enough that this rarely misattributes.
            const lastFail = failMatches[failMatches.length - 1];
            if (lastFail) { currentFile = lastFail[1]; }
        }

        // Extract Expected / Received pair if present.
        const expectedMatch = chunk.match(/Expected:?\s*(.+)/);
        const receivedMatch = chunk.match(/Received:?\s*(.+)/);

        // Extract the assertion error one-liner. Look for the first
        // "expect(...)" call in the chunk, then take the line that
        // explains the assertion. Falls back to the first non-empty
        // line after the test name.
        const lines = chunk.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
        // First non-empty line that isn't part of the source-context
        // (which Jest indents with line numbers like "  23 |  ...").
        let messageLine: string | undefined;
        for (const l of lines) {
            if (/^\d+\s*\|/.test(l)) { continue; } // source context
            if (/^>\s*\d+\s*\|/.test(l)) { continue; }
            if (/^at\s/.test(l)) { continue; } // stack frame
            messageLine = l;
            break;
        }

        const failure: PerTestFailure = {
            framework: 'jest',
            message: messageLine || 'Test failed (no message extracted)',
        };
        if (testName) { failure.testName = testName; }
        if (currentFile) { failure.file = currentFile; }
        if (lineFromFrame) { failure.line = Number(lineFromFrame); }
        if (expectedMatch?.[1]) { failure.expected = expectedMatch[1].trim(); }
        if (receivedMatch?.[1]) { failure.actual = receivedMatch[1].trim(); }
        failures.push(failure);
    }
    return failures;
}

// ─── Vitest ─────────────────────────────────────────────────────────

/**
 * Vitest failure shape (default reporter):
 *
 *   FAIL  src/foo.test.ts > describe > it name
 *   AssertionError: expected 5 to be 4
 *    ❯ src/foo.test.ts:25:18
 *         23|   it('adds', () => {
 *         24|     const r = add(2, 2);
 *         25|     expect(r).toBe(4);
 *           |                ^
 *
 *   - Expected
 *   + Received
 *
 *   - 4
 *   + 5
 */
function parseVitestOutput(raw: string): PerTestFailure[] {
    const failures: PerTestFailure[] = [];
    // Vitest groups failures with a header line "FAIL <file> > <test>"
    // followed by error details. Use a non-greedy block extractor.
    const blockRegex = /(?:^|\n)\s*FAIL\s+([^\n]+?)(?:\n)([\s\S]*?)(?=\n\s*(?:FAIL|PASS|Test Files|Tests)|$)/g;

    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(raw)) !== null) {
        const headerLine = match[1]!.trim();
        const body = match[2]!;

        // Header is "<file> > <describe> > <test>" or just "<file>".
        const headerParts = headerLine.split('>').map(s => s.trim());
        const file = headerParts[0];
        const testName = headerParts.length > 1 ? headerParts.slice(1).join(' > ') : undefined;

        // Extract first error line (typically AssertionError: ...).
        const errLine = body.match(/^(?:AssertionError|TypeError|ReferenceError|Error):\s*(.+)/m);
        const message = errLine?.[1]?.trim() || body.split('\n').map(l => l.trim()).find(Boolean) || 'Test failed';

        // Extract line from the first frame "❯ file:line:col" or "at file:line:col".
        const frame = body.match(/(?:❯|at)\s+([^\s:]+):(\d+):\d+/);
        const lineNum = frame?.[2];

        // Vitest expected/actual diff is "- Expected" / "+ Received"
        // followed by the values. We take the first line after each.
        const expectedMatch = body.match(/-\s*Expected\s*\n[^\n]*\n-\s*(.+)/);
        const receivedMatch = body.match(/\+\s*Received\s*\n[^\n]*\n\+\s*(.+)/);

        const failure: PerTestFailure = {
            framework: 'vitest',
            message,
        };
        if (testName) { failure.testName = testName; }
        if (file) { failure.file = file; }
        if (lineNum) { failure.line = Number(lineNum); }
        if (expectedMatch?.[1]) { failure.expected = expectedMatch[1].trim(); }
        if (receivedMatch?.[1]) { failure.actual = receivedMatch[1].trim(); }
        failures.push(failure);
    }
    return failures;
}

// ─── Pytest ─────────────────────────────────────────────────────────

/**
 * Pytest failure shape (default reporter):
 *
 *   ============================= test session starts ============================
 *   ...
 *   ___________________________ test_addition __________________________________
 *
 *       def test_addition():
 *   >       assert add(2, 2) == 4
 *   E       assert 5 == 4
 *   E        +  where 5 = add(2, 2)
 *
 *   tests/test_math.py:5: AssertionError
 *   ...
 *   =========================== short test summary info =========================
 *   FAILED tests/test_math.py::test_addition - assert 5 == 4
 *
 * The "FAILED <file>::<test> - <message>" line in short summary is the
 * easiest signal — one line per failure. We use that as the primary
 * signal and fall back to scanning the verbose body for line numbers.
 */
function parsePytestOutput(raw: string): PerTestFailure[] {
    const failures: PerTestFailure[] = [];
    // Match each "FAILED <path>::<testname> - <message>" line in the
    // short summary. Parametrized tests use brackets in the testname
    // (test_foo[1-2]) — we accept those too.
    const summaryRegex = /^FAILED\s+(\S+)::([^\s-]+(?:\[[^\]]*\])?)\s*-\s*(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = summaryRegex.exec(raw)) !== null) {
        const file = m[1]!;
        const testName = m[2]!;
        const message = m[3]!.trim();

        // Extract line from "<file>:<line>: AssertionError" or similar
        // marker that pytest emits in the verbose body.
        const lineRegex = new RegExp(
            // escape file path for regex
            file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):'
        );
        const lineMatch = raw.match(lineRegex);
        const lineNum = lineMatch?.[1];

        const failure: PerTestFailure = {
            framework: 'pytest',
            testName,
            file,
            message,
        };
        if (lineNum) { failure.line = Number(lineNum); }
        // Pytest's "assert X == Y" message has expected/actual implicit;
        // we don't try to split it. The Coder reading "assert 5 == 4"
        // figures it out fine.
        failures.push(failure);
    }
    return failures;
}