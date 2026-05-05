// src/fixtures/reporter.ts
//
// Aggregates fixture results into a single scorecard.
//
// The scorecard format is the public artifact this whole machine
// produces — every PR description should reference one. Stable shape
// matters: future tooling will diff scorecards across releases.

import type { FixtureResult } from './scorer';

export interface Scorecard {
    /** ISO-8601 timestamp of when the run started. */
    runId: string;
    /** Git SHA at run time, or 'unknown' if not in a git checkout. */
    gitSha: string;
    /** Total fixtures attempted (across all modes). */
    fixtureCount: number;
    /** Per-fixture results, in the order they ran. */
    results: FixtureResultSummary[];
    /** Aggregates that go on the PR description. */
    aggregates: {
        interactiveSuccessRate: number;
        autopilotSuccessRate: number;
        meanInterventionsInteractive: number;
        meanInterventionsAutopilot: number;
        /** % of fixtures where the agent reported "complete" before
         *  the budget timeout. Useful as a leading indicator: agents
         *  can report-complete with broken code (caught by checks),
         *  or can run forever with good code (not caught by checks). */
        completionRate: number;
    };
}

export interface FixtureResultSummary {
    fixtureId: string;
    mode: 'interactive' | 'autopilot';
    status: 'pass' | 'fail' | 'timeout' | 'error';
    checksPassed: number;
    checksTotal: number;
    interventions: number;
    agentSeconds: number;
    failedChecks: string[];
}

export function buildScorecard(
    runId: string,
    gitSha: string,
    results: FixtureResult[]
): Scorecard {
    const summaries: FixtureResultSummary[] = results.map((r) => {
        const checksPassed = r.checks.filter((c) => c.passed).length;
        // Include the detail field — it has the real failure reason
        // (e.g. "agent invoker threw: ECONNREFUSED ...") which is the
        // single most useful piece of debugging info when fixtures fail
        // en masse. Format: "<kind>: <description> — <detail>"
        const failedChecks = r.checks
            .filter((c) => !c.passed)
            .map((c) => {
                const head = `${c.kind}: ${c.description}`;
                return c.detail ? `${head} — ${c.detail}` : head;
            });
        // Discriminate "error" (invoker threw, 0 seconds elapsed) from
        // "timeout" (invoker ran but ran out of budget). Conflating
        // them hides infrastructure bugs (endpoint unreachable, missing
        // dep) behind what looks like agent-quality regressions.
        let status: FixtureResultSummary['status'];
        if (r.passed) {
            status = 'pass';
        } else if (!r.agentReportedComplete && r.agentSeconds === 0) {
            // Invoker threw immediately. Real timeouts always elapse
            // some non-zero time before the budget kills them.
            status = 'error';
        } else if (!r.agentReportedComplete) {
            status = 'timeout';
        } else {
            status = 'fail';
        }
        return {
            fixtureId: r.fixtureId,
            mode: r.mode,
            status,
            checksPassed,
            checksTotal: r.checks.length,
            interventions: r.interventions,
            agentSeconds: Math.round(r.agentSeconds),
            failedChecks
        };
    });

    const interactive = results.filter((r) => r.mode === 'interactive');
    const autopilot = results.filter((r) => r.mode === 'autopilot');
    const completed = results.filter((r) => r.agentReportedComplete).length;

    return {
        runId,
        gitSha,
        fixtureCount: results.length,
        results: summaries,
        aggregates: {
            interactiveSuccessRate: rate(interactive, (r) => r.passed),
            autopilotSuccessRate: rate(autopilot, (r) => r.passed),
            meanInterventionsInteractive: mean(interactive.map((r) => r.interventions)),
            meanInterventionsAutopilot: mean(autopilot.map((r) => r.interventions)),
            completionRate: results.length > 0 ? completed / results.length : 0
        }
    };
}

/** Render a scorecard as a human-readable Markdown report. Used in
 *  PR descriptions and the harness's stdout summary. */
export function renderScorecardMarkdown(card: Scorecard): string {
    const a = card.aggregates;
    const lines: string[] = [];
    lines.push(`# NexusCode fixture scorecard`);
    lines.push('');
    lines.push(`**Run:** ${card.runId}    **SHA:** \`${card.gitSha}\`    **Fixtures:** ${card.fixtureCount}`);
    lines.push('');
    lines.push(`## Aggregates`);
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Interactive success rate | ${pct(a.interactiveSuccessRate)} |`);
    lines.push(`| Autopilot success rate | ${pct(a.autopilotSuccessRate)} |`);
    lines.push(`| Mean interventions (interactive) | ${a.meanInterventionsInteractive.toFixed(1)} |`);
    lines.push(`| Mean interventions (autopilot) | ${a.meanInterventionsAutopilot.toFixed(1)} |`);
    lines.push(`| Agent-reported completion rate | ${pct(a.completionRate)} |`);
    lines.push('');
    lines.push(`## Per-fixture results`);
    lines.push('');
    lines.push(`| Fixture | Mode | Status | Checks | Interv | Time |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of card.results) {
        const status = statusEmoji(r.status);
        lines.push(
            `| ${r.fixtureId} | ${r.mode} | ${status} ${r.status} | ${r.checksPassed}/${r.checksTotal} | ${r.interventions} | ${r.agentSeconds}s |`
        );
    }
    lines.push('');
    const failedAny = card.results.filter((r) => r.failedChecks.length > 0);
    if (failedAny.length > 0) {
        lines.push(`## Failed checks (detail)`);
        lines.push('');
        for (const r of failedAny) {
            lines.push(`### ${r.fixtureId} (${r.mode})`);
            for (const f of r.failedChecks) {
                lines.push(`- ${f}`);
            }
            lines.push('');
        }
    }
    return lines.join('\n');
}

// ─── helpers ────────────────────────────────────────────────────────

function rate<T>(arr: T[], pred: (x: T) => boolean): number {
    if (arr.length === 0) return 0;
    return arr.filter(pred).length / arr.length;
}

function mean(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
}

function statusEmoji(status: FixtureResultSummary['status']): string {
    switch (status) {
        case 'pass': return '✅';
        case 'fail': return '❌';
        case 'timeout': return '⏱';
        case 'error': return '⚠️';
    }
}