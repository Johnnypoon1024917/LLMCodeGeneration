"use strict";
// src/fixtures/scorer.ts
//
// Evaluates a generated workspace against a fixture's rubric.
//
// Each check kind has a specific evaluator. The scorer runs them in
// order and short-circuits NOTHING — every check runs even if earlier
// ones fail, so the scorecard is complete. Failures don't abort.
//
// Why exhaustive-run instead of short-circuit: the scorecard is more
// useful for debugging a regression when it shows "5/8 checks failed"
// vs "1/8 checks failed (and 7 didn't run because we gave up early)."
// If a check is genuinely a precondition for later ones, encode that
// in the rubric ordering — but the runner still tries them all.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreFixture = scoreFixture;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
/**
 * Score a single fixture's generated workspace. Idempotent — re-running
 * gives the same result (assuming the workspace hasn't changed).
 *
 * The semantic check evaluator is injected via `gradeSemantic` rather
 * than imported, so the scorer doesn't depend on llmService and can be
 * unit-tested without LLM calls.
 */
async function scoreFixture(fixture, workspaceDir, options) {
    const checks = [];
    for (const check of fixture.rubric) {
        let result;
        try {
            result = await evaluateCheck(check, workspaceDir, options.gradeSemantic);
        }
        catch (e) {
            result = {
                description: check.description,
                kind: check.kind,
                passed: false,
                detail: `evaluator threw: ${e instanceof Error ? e.message : String(e)}`
            };
        }
        checks.push(result);
    }
    const allChecksPassed = checks.every((c) => c.passed);
    return {
        fixtureId: fixture.id,
        mode: options.mode,
        workspaceDir,
        agentSeconds: options.agentSeconds,
        interventions: options.interventions,
        agentReportedComplete: options.agentReportedComplete,
        checks,
        passed: allChecksPassed && options.agentReportedComplete
    };
}
// ─── Evaluators ─────────────────────────────────────────────────────
async function evaluateCheck(check, workspaceDir, gradeSemantic) {
    switch (check.kind) {
        case 'file_exists':
            return evaluateFileExists(check, workspaceDir);
        case 'command':
            return evaluateCommand(check, workspaceDir);
        case 'command_output_contains':
            return evaluateCommandOutput(check, workspaceDir);
        case 'integration':
            return evaluateIntegration(check, workspaceDir);
        case 'semantic':
            return evaluateSemantic(check, workspaceDir, gradeSemantic);
    }
}
async function evaluateFileExists(check, workspaceDir) {
    const target = path.join(workspaceDir, check.path);
    try {
        const stat = await fs.stat(target);
        return {
            description: check.description,
            kind: check.kind,
            passed: stat.isFile() || stat.isDirectory(),
            detail: stat.isFile() ? `file exists (${stat.size} bytes)` : 'is a directory'
        };
    }
    catch {
        return {
            description: check.description,
            kind: check.kind,
            passed: false,
            detail: `not found: ${check.path}`
        };
    }
}
async function evaluateCommand(check, workspaceDir) {
    const expected = check.expectExitCode ?? 0;
    const result = await runCommand(check.cmd, workspaceDir, check.timeoutMs ?? 30000);
    const passed = result.exitCode === expected;
    return {
        description: check.description,
        kind: check.kind,
        passed,
        detail: passed
            ? `exit ${result.exitCode} in ${result.durationMs}ms`
            : `expected exit ${expected}, got ${result.exitCode}: ${result.stderr.slice(0, 200)}`
    };
}
async function evaluateCommandOutput(check, workspaceDir) {
    const result = await runCommand(check.cmd, workspaceDir, check.timeoutMs ?? 30000);
    if (result.exitCode !== 0) {
        return {
            description: check.description,
            kind: check.kind,
            passed: false,
            detail: `command failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`
        };
    }
    if (check.expectLine !== undefined) {
        const lines = result.stdout.split('\n');
        const idx = check.expectLine - 1;
        const line = lines[idx] ?? '';
        const passed = line.includes(check.expectText);
        return {
            description: check.description,
            kind: check.kind,
            passed,
            detail: passed
                ? `line ${check.expectLine} contains "${check.expectText}"`
                : `line ${check.expectLine} = "${line.slice(0, 80)}", missing "${check.expectText}"`
        };
    }
    const passed = result.stdout.includes(check.expectText);
    return {
        description: check.description,
        kind: check.kind,
        passed,
        detail: passed ? `output contains "${check.expectText}"` : `output missing "${check.expectText}"`
    };
}
async function evaluateIntegration(check, workspaceDir) {
    // Integration tests are stateful — setup, request, expect, teardown.
    // We always run teardown even if the request fails, to avoid
    // leaving zombie processes between fixtures.
    if (check.setup) {
        const s = await runCommand(check.setup, workspaceDir, 30000);
        if (s.exitCode !== 0) {
            return {
                description: check.description,
                kind: check.kind,
                passed: false,
                detail: `setup failed: ${s.stderr.slice(0, 200)}`
            };
        }
    }
    let detail = '';
    let passed = false;
    try {
        const url = `http://localhost:3000${check.request.path}`;
        const res = await fetchWithTimeout(url, {
            method: check.request.method,
            headers: { 'content-type': 'application/json', ...(check.request.headers ?? {}) },
            ...(check.request.body !== undefined ? { body: JSON.stringify(check.request.body) } : {})
        }, 10000);
        const bodyText = await res.text();
        const statusOk = res.status === check.expect.status;
        let bodyOk = true;
        if (check.expect.bodyIncludes) {
            bodyOk = check.expect.bodyIncludes.every((needle) => bodyText.includes(needle));
        }
        if (bodyOk && check.expect.bodyMatchesRegex) {
            bodyOk = new RegExp(check.expect.bodyMatchesRegex).test(bodyText);
        }
        passed = statusOk && bodyOk;
        detail = passed
            ? `${res.status} OK`
            : `status=${res.status} expected=${check.expect.status}, body[0:120]="${bodyText.slice(0, 120)}"`;
    }
    catch (e) {
        detail = `request threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    finally {
        if (check.teardown) {
            await runCommand(check.teardown, workspaceDir, 10000).catch(() => undefined);
        }
    }
    return { description: check.description, kind: check.kind, passed, detail };
}
async function evaluateSemantic(check, workspaceDir, gradeSemantic) {
    if (!gradeSemantic) {
        return {
            description: check.description,
            kind: check.kind,
            passed: false,
            detail: 'semantic grader not provided; skipped'
        };
    }
    const verdict = await gradeSemantic(check.rubric, workspaceDir);
    return {
        description: check.description,
        kind: check.kind,
        passed: verdict.passed,
        detail: verdict.detail
    };
}
function runCommand(cmd, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        // Use a shell so cmd strings can use pipes, redirects, &&, etc.
        // On Windows we'd use cmd.exe; on POSIX we use sh. The fixture
        // runner is documented as POSIX-only for now.
        const proc = (0, child_process_1.spawn)(cmd, { cwd, shell: true });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
        proc.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve({
                exitCode: -1,
                stdout,
                stderr: stderr + `\n[harness: killed after ${timeoutMs}ms]`,
                durationMs: Date.now() - started
            });
        }, timeoutMs);
        proc.on('exit', (code) => {
            clearTimeout(timer);
            resolve({
                exitCode: code ?? -1,
                stdout,
                stderr,
                durationMs: Date.now() - started
            });
        });
    });
}
async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=scorer.js.map