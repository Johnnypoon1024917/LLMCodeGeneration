# How to capture your first fixture baseline

The harness is built and 8 fixtures are calibrated. Nobody has run
them against a live LLM endpoint yet — there are no `baselines/*.json`
files. This doc walks you through the first baseline run so you have
a real starting number.

## Why this matters

Without a baseline, every prompt change since this session (the
Coder rewrite, the planner P1.2 enhancement, the chat compaction)
is unmeasured. We don't know if these changes improved or
regressed agent quality.

A baseline locked in TODAY tells you:
- Where Qwen3.6 + the current prompts land on each fixture
- Which fixtures the agent already handles vs which it doesn't
- What "improvement" needs to mean numerically going forward

After you have one baseline, every subsequent baseline is a
trend point. Three baselines in is when the system becomes
predictive — you start seeing "this PR moved the medium tier
down by 1" before you ship it.

## Prerequisites

1. **A live Qwen3.6 endpoint reachable from the test runtime.**
   Your daily-use endpoint is fine. The harness does not need
   anything special.

2. **Node/Python/Go toolchains** for the fixture rubrics that
   exercise them:
   - Node + npm (existing fixtures)
   - Python 3 (fixture 004)
   - Go (fixture 006)
   If a toolchain is missing, the relevant fixture's command
   checks fail — but other fixtures still run. Easier to install
   the missing toolchain than to skip fixtures.

3. **Free disk space.** Each fixture runs in a fresh tempdir.
   Express + Prisma + React fixtures bring in npm dependencies
   that total ~500MB across the suite. The runner cleans up
   after each fixture, but during a run, expect 1-2GB peak.

## Run the baseline

```bash
# 1. Set the endpoint via env vars. The test VS Code instance has
#    its own settings store and won't see your daily VS Code's
#    settings.json — env vars are how you pass through.
set NEXUSCODE_API_ENDPOINT=http://192.168.191.41:8000/v1/chat/completions
set NEXUSCODE_API_KEY=

# 2. Compile + run all fixtures. This takes 30-60 minutes depending
#    on your endpoint's throughput.
npm run fixtures
```

To run a single fixture (much faster for iteration):

```bash
set FIXTURES_ONLY=001-node-fizzbuzz
npm run fixtures
```

The `FIXTURES_ONLY` value is matched as a substring against fixture
ids — `001` matches just fizzbuzz, `node` matches every fixture
with "node" in its name.

## What you'll see

Terminal output streams per-fixture:

```
[fixtures] endpoint=http://...:8000/v1/... (source=env)
[fixtures] running 8 fixture(s) across modes
[fixtures] starting 001-node-fizzbuzz (interactive)
[fixtures] ✓ 001-node-fizzbuzz (interactive) — 5/5 checks passed in 142s
[fixtures] starting 001-node-fizzbuzz (autopilot)
[fixtures] ✓ 001-node-fizzbuzz (autopilot) — 5/5 checks passed in 138s
[fixtures] starting 002-express-validate-endpoint (interactive)
[fixtures] ✗ 002-express-validate-endpoint (interactive) — 4/7 checks failed in 287s
  failed: rejects invalid email with 400 (HTTP 500 instead of 400)
  failed: accepts valid input with 201 + UUID (HTTP 500)
  failed: rejects missing required field (HTTP 500)
  failed: tests pass (none)
...
```

Don't be alarmed by failures on harder fixtures. The whole point
is to know where the bar is. The first run captures reality, not
aspiration.

## After the run

The harness writes two files to `fixtures/baselines/`:

```
fixtures/baselines/
├── scorecard-2026-05-06T15-32-11-456Z.json    (machine-readable)
└── scorecard-2026-05-06T15-32-11-456Z.md      (human-readable)
```

**Open the markdown file first.** It has the per-fixture pass/fail
breakdown, aggregate success rates for both modes, and mean
intervention counts. Read it once end-to-end — that's your
baseline.

**Commit both files** to the repo:

```bash
git add fixtures/baselines/scorecard-2026-05-06T15-32-11-456Z.*
git commit -m "fixtures: first baseline run (Qwen3.6, post-coder-rewrite)"
```

The committed JSON is what future scorecards diff against. If you
don't commit it, you have no historical reference.

## How to interpret your numbers

Your first scorecard tells you four things:

1. **Interactive success rate.** % of fixture-mode pairs where
   ALL rubric checks passed. This is the v1 ship metric. Aim
   for ≥85% by v1 launch (per ROADMAP-STATUS.md exit criteria).

2. **Autopilot success rate.** Same metric, autopilot mode. v2
   north star (target ≥70%). Today autopilot mode is not yet
   semantically distinct from interactive — the number will be
   close to interactive until v2 work lands. That's fine for v1.
   We track it from day 1 so trend lines are continuous.

3. **Mean interventions per project.** Today this is approximated
   by counting "Verifier rejected" log lines (proper
   user-confirmation prompts don't fire because bashAutoApprove
   is forced on in the test runtime). v2's P1.3 will replace
   this with real intervention counting. The current number is
   useful as a relative trend (more retries = worse), not as an
   absolute ground truth.

4. **Per-fixture pass/fail.** Look at which fixtures consistently
   fail. Patterns matter:
   - All Python fixtures fail → agent's Python support is weak
   - All hard fixtures fail with timeout → budget too low
   - One fixture flakes (passes some runs, fails others) →
     fixture itself may be miscalibrated; tighten the rubric

## Refresh cadence

Run a fresh baseline:
- After every prompt change to Coder/Planner/Verifier
- After every model swap (Qwen3.6 → Qwen3.7 → Claude → ...)
- Monthly even if nothing changed (catches infrastructure drift)
- Before any v1-related milestone push

Each new baseline is a JSON committed to `fixtures/baselines/`.
Diff against the previous to see the delta:

```bash
diff fixtures/baselines/scorecard-2026-05-06*.json \
     fixtures/baselines/scorecard-2026-06-01*.json
```

For human review, just open both markdown files side by side.

## What if a fixture is flaky?

A flaky fixture (passes 80% of runs, fails 20% with no code
change) is a fixture problem, not an agent problem. Fix the
fixture:

- Tighten command exit code expectations
- Avoid time-dependent semantic checks
- Don't rely on network resources (Prisma's query engine
  download is the one current exception — flag this if you
  hit it)
- Increase budget_seconds if the agent is genuinely close
  but timing out

If you can't tame the flakiness, mark the fixture's modes as
just `[interactive]` or remove it from the suite. A noisy
fixture trains you to ignore failures.

## Honest current state

As of bundle p1.0-fixtures-and-docs:

- Harness: complete, 20 unit tests passing
- Fixtures: 8 calibrated (target was 50; remaining will accumulate)
- Baselines: NONE captured yet — that's what this doc is for

The next milestone is YOU running the baseline once and
committing the result. Do not skip this. The whole point of
P1.0 was "stop shooting blind"; without a baseline, we're
still shooting blind.

## Known limitations (track as P1.0 follow-ups)

These are flagged in the harness comments themselves; surfacing
them here so they're not surprising:

1. **Autopilot ≠ interactive in code.** v1's agent doesn't yet
   have a meaningfully-different autopilot mode. The harness
   runs both for trend continuity; the autopilot number will
   diverge from interactive once v2's P1.3 (autonomy decisions)
   lands.

2. **Interventions are approximated.** Counts Verifier rejections
   today. Real user-confirmation prompts don't fire in the
   harness because bashAutoApprove is forced on. Replace with
   proper intervention counter as part of v2's P1.3.

3. **Semantic checks need an LLM grader.** Fixtures with
   `kind: semantic` rubrics currently fail with "no grader
   provided" — the harness doesn't yet route them through an
   LLM. Lean on deterministic checks
   (file_exists, command, command_output_contains, integration)
   for now. Adding the grader is a ~half-day bundle when needed.

4. **No fixture-pre-seeding.** Every fixture starts with an
   empty workspace. Bug-fix-style fixtures ("here's broken
   code, fix it") would need a `setup_files` mechanism in the
   loader. Not implemented; deferred until we want that
   axis of difficulty.