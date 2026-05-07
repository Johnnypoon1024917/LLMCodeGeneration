"use strict";
// src/fixtures/runner.ts
//
// Runs fixtures end-to-end: setup workspace → invoke agent → score result.
//
// The Agent interface is injected: production runs pass a real agent
// invoker that drives the Coordinator, while harness self-tests pass a
// stub that produces deterministic outputs. This separation means we
// can validate the harness logic itself (does scoring work? does the
// scorecard JSON look right?) without an LLM in the loop.
//
// Invocation paths:
//
//   1. From vscode-test (production baseline): the .vscode-test fixture
//      runner imports this module, builds a real agent invoker that
//      calls Coordinator.runTask, runs all fixtures, writes the scorecard.
//
//   2. From a unit test (harness validation): tests build a stub agent
//      and call runFixtures directly with a synthetic fixture set.
//
//   3. From a future CLI subcommand `nexuscode fixtures run`: when the
//      CLI runtime path is unblocked (post-v1), the same runner can be
//      driven from the command line. Currently blocked on the vscode
//      runtime shim. Tracked as future work, not v1 blocker.
//
// The runner does NOT mutate the source repo's working tree. Each
// fixture gets a fresh tempdir; failures don't leak.
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
exports.stubAgent = void 0;
exports.runFixtures = runFixtures;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const scorer_1 = require("./scorer");
const reporter_1 = require("./reporter");
/**
 * Run a list of fixtures and produce a scorecard. The fixture runner
 * is the entry point that gets wired into vscode-test (and eventually
 * a CLI subcommand).
 *
 * Each fixture is run in each of its declared modes. A "mode" is
 * either 'interactive' (auto-approve interventions, count them) or
 * 'autopilot' (no interventions surface). Both modes always run when
 * the fixture declares them, even for v1 where we only ship against
 * the interactive number — the autopilot data is v2 prep.
 */
async function runFixtures(opts) {
    const { fixtures, invoke, gradeSemantic, onFixtureStart, onFixtureEnd } = opts;
    const allResults = [];
    const runId = new Date().toISOString();
    const gitSha = await readGitSha();
    for (const fixture of fixtures) {
        for (const mode of fixture.modes) {
            onFixtureStart?.(fixture, mode);
            const workspaceDir = await mkTempWorkspace(fixture.id);
            try {
                const inv = await invoke({
                    workspaceDir,
                    requirement: fixture.requirement,
                    autopilot: mode === 'autopilot',
                    budgetSeconds: fixture.budgetSeconds
                });
                const result = await (0, scorer_1.scoreFixture)(fixture, workspaceDir, {
                    mode,
                    agentSeconds: inv.agentSeconds,
                    interventions: inv.interventions,
                    agentReportedComplete: inv.reportedComplete,
                    ...(gradeSemantic ? { gradeSemantic } : {})
                });
                allResults.push(result);
                onFixtureEnd?.(result);
            }
            catch (e) {
                // The agent invoker itself threw. Record as a failed
                // fixture rather than crashing the whole run.
                //
                // Surface the error to stderr — without this, every
                // exception looks identical to "agent took too long"
                // in the scorecard, which makes debugging infrastructure
                // problems (endpoint unreachable, missing dep, auth
                // failure) impossible.
                const errMsg = e instanceof Error ? e.message : String(e);
                const errStack = e instanceof Error && e.stack ? e.stack : '';
                process.stderr.write(`\n[fixtures] ✗ ${fixture.id} (${mode}) — invoker threw:\n` +
                    `  ${errMsg}\n` +
                    (errStack ? `${errStack.split('\n').slice(0, 6).map(l => '  ' + l).join('\n')}\n` : ''));
                const errResult = {
                    fixtureId: fixture.id,
                    mode,
                    workspaceDir,
                    agentSeconds: 0,
                    interventions: 0,
                    agentReportedComplete: false,
                    checks: fixture.rubric.map((c) => ({
                        description: c.description,
                        kind: c.kind,
                        passed: false,
                        detail: `agent invoker threw: ${errMsg}`
                    })),
                    passed: false
                };
                allResults.push(errResult);
                onFixtureEnd?.(errResult);
            }
            // Note: we don't clean up workspaceDir on failure. The
            // workspaces stay in os.tmpdir() for post-mortem inspection.
            // CI should clean tmpdir at end of job; local runs leak
            // until reboot, which is acceptable.
        }
    }
    const scorecard = (0, reporter_1.buildScorecard)(runId, gitSha, allResults);
    if (opts.outputDir) {
        await persistScorecard(scorecard, opts.outputDir);
    }
    return scorecard;
}
// ─── Helpers ────────────────────────────────────────────────────────
async function mkTempWorkspace(fixtureId) {
    const safeId = fixtureId.replace(/[^a-z0-9-]/gi, '_');
    const dir = path.join(os.tmpdir(), `nexuscode-fixture-${safeId}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}
async function readGitSha() {
    try {
        const head = await fs.readFile('.git/HEAD', 'utf-8');
        const match = head.trim().match(/^ref:\s+(.+)$/);
        if (match && match[1]) {
            const ref = match[1];
            const sha = await fs.readFile(path.join('.git', ref), 'utf-8');
            return sha.trim().slice(0, 7);
        }
        return head.trim().slice(0, 7);
    }
    catch {
        return 'unknown';
    }
}
async function persistScorecard(card, outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
    // ISO timestamps include colons; replace for cross-platform filenames
    const safeRunId = card.runId.replace(/[:.]/g, '-');
    const jsonPath = path.join(outputDir, `scorecard-${safeRunId}.json`);
    const mdPath = path.join(outputDir, `scorecard-${safeRunId}.md`);
    await fs.writeFile(jsonPath, JSON.stringify(card, null, 2));
    await fs.writeFile(mdPath, (0, reporter_1.renderScorecardMarkdown)(card));
}
// ─── Stub agent (for harness self-tests only) ───────────────────────
/**
 * Deterministic stub agent for testing the harness itself. Reports
 * complete=true, writes a stubbed package.json with the fixture id, and
 * uses the requirement to decide on a "complexity" (longer requirement
 * = longer simulated agent time). NEVER use for real measurement —
 * this is purely for unit-testing the runner/scorer/reporter chain.
 */
const stubAgent = async (call) => {
    await fs.writeFile(path.join(call.workspaceDir, 'package.json'), JSON.stringify({ name: 'stubbed', version: '0.0.0' }, null, 2));
    return {
        reportedComplete: true,
        agentSeconds: Math.min(2, call.budgetSeconds / 60),
        interventions: call.autopilot ? 0 : 1
    };
};
exports.stubAgent = stubAgent;
//# sourceMappingURL=runner.js.map