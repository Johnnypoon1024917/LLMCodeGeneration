"use strict";
// src/test/fixtures.test.ts
//
// vscode-test driver for the fixture harness. Discovers all fixtures
// under fixtures/, runs each against the real agent pipeline in a
// fresh tempdir, scores the output, and writes a scorecard JSON +
// markdown report to fixtures/baselines/.
//
// HOW TO RUN
// ──────────
//   npm run compile && npx vscode-test --label fixtures
//
// or to run a single fixture:
//   FIXTURES_ONLY=001-node-fizzbuzz npm run compile && npx vscode-test --label fixtures
//
// CI: this test self-skips unless NEXUSCODE_API_ENDPOINT is set, so
// it doesn't fail nightly builds on dev workstations without local
// LLM endpoints.
//
// LIMITATIONS / KNOWN GAPS (track as P1.0 follow-ups)
// ──────────────────────────────────────────────────
// 1. autopilot mode is not yet semantically distinct from interactive
//    in v1's agent code. Both modes go through the same pipeline; the
//    scorecard records the baseline for both so we can see the
//    distinction emerge as v1's P1.3 (autonomy decisions) lands.
// 2. interventions are approximated by counting "Verifier rejected"
//    log lines. Real interventions (user-confirmation prompts) don't
//    happen because bashAutoApprove is forced on. v2 needs a proper
//    intervention counter.
// 3. semantic checks fail with "no grader provided" — we don't
//    currently route them through an LLM grader. That's a separate
//    follow-up; for now lean on deterministic checks.
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
require("mocha");
const assert = __importStar(require("assert"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
const vscode = __importStar(require("vscode"));
const loader_1 = require("../fixtures/loader");
const runner_1 = require("../fixtures/runner");
const reporter_1 = require("../fixtures/reporter");
const realAgent_1 = require("../fixtures/realAgent");
// ─────────────────────────────────────────────────────────────────
// Process-level error handlers
// ─────────────────────────────────────────────────────────────────
//
// Node 16+ exits the process on unhandled promise rejections by default.
// Inside a test runtime that means "extension host exits with code 0
// and no error message." Surface these explicitly so the next baseline
// run produces actionable output instead of mysterious silent exits.
//
// We register globally rather than per-test because rejections may fire
// from background async work (e.g. a `void something().catch(...)` that
// somehow throws inside the catch) at any time during the suite.
process.on('unhandledRejection', (reason, _promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error && reason.stack ? reason.stack : '';
    process.stderr.write(`\n[fixtures] UNHANDLED PROMISE REJECTION:\n  ${msg}\n` +
        (stack ? `${stack.split('\n').slice(0, 8).map(l => '  ' + l).join('\n')}\n` : ''));
});
process.on('uncaughtException', (error) => {
    process.stderr.write(`\n[fixtures] UNCAUGHT EXCEPTION:\n  ${error.message}\n` +
        (error.stack ? `${error.stack.split('\n').slice(0, 8).map(l => '  ' + l).join('\n')}\n` : ''));
});
// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function findRepoRoot(start) {
    // Walk up from the compiled-test location until we find package.json.
    // We're running from out/test/fixtures.test.js, and fixtures/ is at
    // the repo root next to src/.
    let cur = start;
    for (let i = 0; i < 8; i++) {
        try {
            const candidate = path.join(cur, 'package.json');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require(candidate);
            return cur;
        }
        catch {
            const parent = path.dirname(cur);
            if (parent === cur)
                break;
            cur = parent;
        }
    }
    throw new Error(`could not locate repo root from ${start}`);
}
function isEndpointConfigured() {
    // Endpoint can come from any of:
    //   - VS Code settings (nexuscode.apiEndpoint)
    //   - Env var (NEXUSCODE_API_ENDPOINT)
    let settingValue = '';
    let envValue = '';
    try {
        const cfg = vscode.workspace.getConfiguration('nexuscode');
        settingValue = (cfg.get('apiEndpoint') || '').trim();
    }
    catch {
        // ignore
    }
    envValue = (process.env['NEXUSCODE_API_ENDPOINT'] || '').trim();
    const configured = settingValue.length > 0 || envValue.length > 0;
    const details = configured
        ? `endpoint=${settingValue || envValue} (source=${settingValue ? 'settings' : 'env'})`
        : `no endpoint — settings='${settingValue}' env='${envValue}'`;
    return { configured, details };
}
// ─────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────
suite('Fixture harness', function () {
    // Per-fixture timeout is enforced by the runner via budgetSeconds.
    // The mocha-level timeout is the OUTER cap — the whole suite must
    // complete within this. With 3 fixtures × 2 modes × ~5min budget,
    // worst case is 30 minutes. Set generously.
    //
    // Setting at the suite level applies to hooks (suiteSetup, etc.).
    // We ALSO set it inside the test() callback below — Mocha's TDD
    // interface doesn't reliably propagate suite-level timeouts to
    // nested tests, and a 2-second default mid-fixture would kill us
    // silently. Be explicit.
    this.timeout(45 * 60 * 1000);
    suiteSetup(async function () {
        this.timeout(60 * 1000); // 60s should be plenty to activate
        // Force extension activation. The default activation trigger
        // (onView:nexuscode.sidebar) only fires when the user opens
        // the sidebar — which never happens in a headless test run.
        // Without activation, extension.ts's `activate()` never runs,
        // which means setDeps() never runs, which means the first
        // call to getDeps() inside the agent throws — and every
        // fixture appears to "timeout at 0 seconds" because the
        // invoker exception is swallowed by the runner.
        //
        // Publisher id is read from package.json's `publisher` field.
        // Right now this is the placeholder 'your-publisher-id'; will
        // become the real one at marketplace publish (P4.1).
        const ext = vscode.extensions.getExtension('your-publisher-id.nexuscode');
        assert.ok(ext, "extension 'your-publisher-id.nexuscode' not found — " +
            "is the package.json publisher correct, and is the extension " +
            "loaded into the test instance via --extensionDevelopmentPath?");
        if (!ext.isActive) {
            await ext.activate();
        }
        process.stdout.write(`[fixtures] extension activated (id=${ext.id})\n`);
    });
    test('runs all fixtures and emits a scorecard', async function () {
        // Override Mocha's 2-second default. Without this, every fixture
        // run is force-killed mid-execution, the extension host shuts
        // down silently, and you get an unhelpful "Exit code: 1" with
        // no explanation. Cause: Mocha's TDD `suite()` interface doesn't
        // reliably propagate suite-level timeouts to nested test() hooks.
        //
        // Set higher than the suite-level cap so the suite-level cap
        // (45 min) wins for hooks; this just unblocks the test body.
        this.timeout(45 * 60 * 1000);
        const endpointStatus = isEndpointConfigured();
        process.stdout.write(`[fixtures] ${endpointStatus.details}\n`);
        if (!endpointStatus.configured) {
            this.skip();
        }
        const repoRoot = findRepoRoot(__dirname);
        const fixturesDir = path.join(repoRoot, 'fixtures');
        const baselinesDir = path.join(fixturesDir, 'baselines');
        // Optional filter via env var. Useful for iterating on a single
        // fixture without paying the full-suite cost.
        const onlyFilter = process.env['FIXTURES_ONLY'];
        const fixtureDirs = await (0, loader_1.discoverFixtures)(fixturesDir);
        assert.ok(fixtureDirs.length > 0, 'no fixtures found under fixtures/');
        const fixtures = [];
        for (const dir of fixtureDirs) {
            const fixture = await (0, loader_1.loadFixture)(dir);
            if (onlyFilter && !fixture.id.includes(onlyFilter)) {
                continue;
            }
            fixtures.push(fixture);
        }
        assert.ok(fixtures.length > 0, `no fixtures matched filter '${onlyFilter ?? '(all)'}'`);
        process.stdout.write(`\n[fixtures] running ${fixtures.length} fixture(s) across modes\n`);
        for (const f of fixtures) {
            process.stdout.write(`  - ${f.tier}/${f.id}: ${f.title}\n`);
        }
        process.stdout.write('\n');
        const invoker = (0, realAgent_1.buildRealAgentInvoker)();
        const scorecard = await (0, runner_1.runFixtures)({
            fixtures,
            invoke: invoker,
            outputDir: baselinesDir,
            onFixtureStart: (fixture, mode) => {
                process.stdout.write(`[fixtures] ▶ ${fixture.id} (${mode})\n`);
            },
            onFixtureEnd: (result) => {
                const checksPassed = result.checks.filter((c) => c.passed).length;
                const status = result.passed ? '✓' : '✗';
                process.stdout.write(`[fixtures] ${status} ${result.fixtureId} (${result.mode}): ` +
                    `${checksPassed}/${result.checks.length} checks, ` +
                    `${Math.round(result.agentSeconds)}s, ` +
                    `${result.interventions} interventions\n`);
            }
        });
        process.stdout.write('\n=== SCORECARD ===\n');
        process.stdout.write((0, reporter_1.renderScorecardMarkdown)(scorecard));
        process.stdout.write('\n');
        // The test "passes" if the harness ran to completion. We do
        // NOT assert any particular score — that's a quality metric
        // we track over time, not a gate. The whole point of the
        // baseline run is to capture wherever we are today, even if
        // it's embarrassing. Asserting >70% would defeat the purpose.
        assert.strictEqual(scorecard.fixtureCount, fixtures.flatMap(f => f.modes).length, 'scorecard should record one result per (fixture, mode) pair');
        // Sanity: the scorecard should be on disk.
        const baselineFiles = await fs.readdir(baselinesDir);
        const hasJson = baselineFiles.some((f) => f.endsWith('.json'));
        const hasMd = baselineFiles.some((f) => f.endsWith('.md'));
        assert.ok(hasJson, 'scorecard JSON should be persisted');
        assert.ok(hasMd, 'scorecard markdown should be persisted');
    });
});
//# sourceMappingURL=fixtures.test.js.map