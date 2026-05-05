// src/test/unit/verifierFailures.test.ts
//
// P1.1: structured verifier failures + retry-message construction.
//
// These tests cover the pure-data layer:
//   - classifyTscError correctly identifies unambiguous-typo patterns
//   - buildRetryMessage produces structured retry prompts when failures
//     are present, and falls back to prose when they're not
//
// They do NOT exercise the full retry loop — that requires a real
// LLM endpoint and lives in fixture-harness territory. The unit tests
// here protect the deterministic logic that P1.1 introduces.

import {
    classifyTscError,
    type ParsedTscError,
    type VerificationResult,
    type VerifierFailure
} from '../../agents/VerifierAgent';
import { buildRetryMessage } from '../../agents/Coordinator';

// ─── classifyTscError ──────────────────────────────────────────────

describe('classifyTscError', () => {
    function tscError(overrides: Partial<ParsedTscError> = {}): ParsedTscError {
        return {
            file: 'src/foo.ts',
            line: 42,
            column: 7,
            code: '2304',
            message: "Cannot find name 'unknownThing'.",
            raw: "src/foo.ts(42,7): error TS2304: Cannot find name 'unknownThing'.",
            ...overrides
        };
    }

    it('flags TS2304 (Cannot find name) as unambiguous_typo', () => {
        const result = classifyTscError(tscError({ code: '2304' }), '/repo');
        expect(result.severity).toBe('unambiguous_typo');
        expect(result.kind).toBe('compile');
    });

    it('flags TS2305 (no exported member) as unambiguous_typo', () => {
        const result = classifyTscError(
            tscError({
                code: '2305',
                message: "Module './bar' has no exported member 'Baz'."
            }),
            '/repo'
        );
        expect(result.severity).toBe('unambiguous_typo');
    });

    it('flags TS2307 (Cannot find module) as unambiguous_typo', () => {
        const result = classifyTscError(
            tscError({ code: '2307', message: "Cannot find module 'lodash'." }),
            '/repo'
        );
        expect(result.severity).toBe('unambiguous_typo');
    });

    it('flags TS2552 (Did you mean) as unambiguous_typo', () => {
        const result = classifyTscError(
            tscError({
                code: '2552',
                message: "Cannot find name 'foo'. Did you mean 'Foo'?"
            }),
            '/repo'
        );
        expect(result.severity).toBe('unambiguous_typo');
    });

    it('does NOT flag TS2322 (type assignment) as unambiguous', () => {
        const result = classifyTscError(
            tscError({ code: '2322', message: "Type 'string' is not assignable to type 'number'." }),
            '/repo'
        );
        expect(result.severity).toBe('error');
    });

    it('does NOT flag TS2554 (wrong number of args) as unambiguous', () => {
        const result = classifyTscError(
            tscError({ code: '2554', message: 'Expected 2 arguments, but got 3.' }),
            '/repo'
        );
        expect(result.severity).toBe('error');
    });

    it('preserves file/line/column/code/message in the failure', () => {
        const err = tscError({ file: 'src/util.ts', line: 10, column: 5, code: '2304' });
        const result = classifyTscError(err, '/repo');
        expect(result.file).toBe('src/util.ts');
        expect(result.line).toBe(10);
        expect(result.column).toBe(5);
        expect(result.code).toBe('2304');
        expect(result.message).toBe("Cannot find name 'unknownThing'.");
    });

    it('normalizes absolute paths to workspace-relative', () => {
        const result = classifyTscError(
            tscError({ file: '/repo/src/foo.ts' }),
            '/repo'
        );
        expect(result.file).toBe('src/foo.ts');
    });

    it('leaves paths outside workspace alone', () => {
        const result = classifyTscError(
            tscError({ file: '/elsewhere/foo.ts' }),
            '/repo'
        );
        expect(result.file).toBe('/elsewhere/foo.ts');
    });

    it('handles relative paths unchanged', () => {
        const result = classifyTscError(
            tscError({ file: 'src/foo.ts' }),
            '/repo'
        );
        expect(result.file).toBe('src/foo.ts');
    });
});

// ─── buildRetryMessage ─────────────────────────────────────────────

describe('buildRetryMessage', () => {
    function fail(overrides: Partial<VerifierFailure> = {}): VerifierFailure {
        return {
            kind: 'compile',
            file: 'src/foo.ts',
            line: 10,
            column: 5,
            code: '2304',
            message: "Cannot find name 'bar'.",
            severity: 'unambiguous_typo',
            ...overrides
        };
    }

    it('falls back to prose critique when failures absent', () => {
        const result: VerificationResult = {
            passed: false,
            critique: 'Test failed because of stuff.'
        };
        const msg = buildRetryMessage(result);
        // Prose path keeps the legacy banner + critique
        expect(msg).toMatch(/VERIFIER REJECTED/);
        expect(msg).toContain('Test failed because of stuff.');
        // And the legacy revert + phantom-import warnings
        expect(msg).toContain('REVERT NOTICE');
        expect(msg).toContain('PHANTOM IMPORT');
    });

    it('falls back to prose when failures is empty array', () => {
        const result: VerificationResult = {
            passed: false,
            critique: 'Empty failures should still fall back.',
            failures: []
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('Empty failures should still fall back.');
    });

    it('uses structured format when failures present', () => {
        const result: VerificationResult = {
            passed: false,
            critique: 'Should be ignored when failures present',
            failures: [fail({ message: "Cannot find name 'foo'." })]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('1 issue(s) to fix');
        expect(msg).toContain('Compile errors');
        expect(msg).toContain('src/foo.ts:10:5');
        expect(msg).toContain("Cannot find name 'foo'");
    });

    it('groups failures by kind: compile, then test, then review', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                fail({ kind: 'review', message: 'review issue' }),
                fail({ kind: 'compile', message: 'compile issue' }),
                fail({ kind: 'test', message: 'test issue' })
            ]
        };
        const msg = buildRetryMessage(result);
        // Compile section appears before test section, which appears before review
        const compileIdx = msg.indexOf('Compile errors');
        const testIdx = msg.indexOf('Test failures');
        const reviewIdx = msg.indexOf('Spec/PRD review');
        expect(compileIdx).toBeGreaterThan(-1);
        expect(testIdx).toBeGreaterThan(compileIdx);
        expect(reviewIdx).toBeGreaterThan(testIdx);
    });

    it('marks routine-fix when ALL failures are unambiguous_typo', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                fail({ severity: 'unambiguous_typo' }),
                fail({ severity: 'unambiguous_typo', message: 'another typo' })
            ]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('routine syntax/import issues');
        expect(msg).toContain('do not rewrite the file');
    });

    it('does NOT mark routine-fix when even one failure is severity=error', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                fail({ severity: 'unambiguous_typo' }),
                fail({ severity: 'error', message: 'real bug' })
            ]
        };
        const msg = buildRetryMessage(result);
        expect(msg).not.toContain('routine syntax/import issues');
    });

    it('handles failures without line/column gracefully', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                {
                    kind: 'compile',
                    file: 'src/foo.ts',
                    code: '2304',
                    message: "Cannot find name 'bar'.",
                    severity: 'error'
                }
            ]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('src/foo.ts');
        // No line/column means the location formatter just shows the filename
        expect(msg).not.toMatch(/src\/foo\.ts:undefined/);
    });

    it('handles project-wide failures (file=null) with sensible label', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                {
                    kind: 'compile',
                    file: null,
                    code: '2304',
                    message: "Cannot find name 'bar'.",
                    severity: 'error'
                }
            ]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('(project-wide)');
    });

    it('always includes the revert + phantom-import notice', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [fail()]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('REVERT NOTICE');
        expect(msg).toContain('PHANTOM IMPORT');
    });

    it('formats compile errors with TS prefix in code tag', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [fail({ kind: 'compile', code: '2304' })]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('[TS2304]');
    });

    it('formats test failures without TS prefix', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [
                {
                    kind: 'test',
                    file: 'src/foo.test.ts',
                    message: 'test exec failed',
                    severity: 'error'
                }
            ]
        };
        const msg = buildRetryMessage(result);
        expect(msg).not.toContain('[TS');
        expect(msg).toContain('test exec failed');
    });

    it('flags routine-fix items inline', () => {
        const result: VerificationResult = {
            passed: false,
            critique: '',
            failures: [fail({ severity: 'unambiguous_typo' })]
        };
        const msg = buildRetryMessage(result);
        expect(msg).toContain('[routine fix]');
    });
});