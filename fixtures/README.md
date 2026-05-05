# NexusCode fixtures

Test fixtures for measuring end-to-end agent quality. Each fixture is a
one-line requirement plus a pass/fail rubric. The harness submits the
requirement to NexusCode in a clean temporary workspace, then scores
the resulting project against the rubric.

## Why fixtures exist

Without measurement, every PR after Sprint 3 is shooting blind. With
fixtures, every PR has a number we can move:

- **Generation success rate (interactive)** — % of fixtures that produce a
  runnable project with developer reviewing each task. The v1 north star.
- **Generation success rate (autopilot)** — % that succeed hands-off. The
  v2 north star, tracked from day 1.
- **Mean human interventions per project** — by v2, the number we care
  about most.

Fixtures are the experimental harness for both v1 and v2. We start
collecting baseline data immediately so by the time v2 work begins we
have months of trend data, not guesses.

## Layout

```
fixtures/
├── README.md                       (this file)
├── easy/
│   ├── 001-node-cli-csv/
│   │   ├── fixture.yaml            (requirement + rubric)
│   │   └── reference/              (optional canonical impl)
│   │       └── ...
│   └── ...
├── medium/
│   └── ...
├── hard/
│   └── ...
└── baselines/
    └── 2026-05-pr3.3.json          (scorecard snapshots over time)
```

Easy / medium / hard tiers are advisory. Hard fixtures genuinely should
be expected to fail at v1; the point is to track them anyway so v2's
progress on harder projects is visible from day 1.

## Running fixtures

```bash
# Compile + run all fixtures (~30 min depending on agent + endpoint)
npm run fixtures

# Run just one fixture (faster iteration during fixture authoring)
FIXTURES_ONLY=001-node-fizzbuzz npm run fixtures
```

The harness self-skips unless an LLM endpoint is configured (either via
`nexuscode.apiEndpoint` in VS Code settings or the
`NEXUSCODE_API_ENDPOINT` env var). Without an endpoint, the suite logs
"skipped" — so dev workstations without local LLM endpoints don't get
spurious failures.

For quick iteration on the harness itself (loader, scorer, runner,
reporter) without involving an LLM:

```bash
# Runs the Jest unit tests with a stub agent
npx jest src/test/unit/fixtures.test.ts
```

Scorecards land in `fixtures/baselines/scorecard-<timestamp>.{json,md}`.

## Fixture format

Each `fixture.yaml`:

```yaml
id: 001-node-cli-csv
title: Node CLI that fetches GitHub stars and emits CSV
tier: easy

# The exact one-line requirement passed to NexusCode. Treat this as the
# user's prompt — the agent only sees this, nothing else.
requirement: |
  Build a Node CLI that takes a list of GitHub repo names from stdin
  (one per line) and outputs a CSV with columns: name, stars, language.
  Use the public GitHub REST API. Handle rate limiting gracefully.

# Rubric: an ordered list of checks. Each check has a kind, a
# description (for the scorecard), and kind-specific fields. Checks
# run in order; later checks may depend on earlier ones (e.g. a
# "runs without crashing" check assumes "compiles" has passed).
rubric:
  - kind: file_exists
    description: package.json was created
    path: package.json

  - kind: file_exists
    description: entry point exists
    path: src/index.ts

  - kind: command
    description: typecheck passes
    cmd: npx tsc --noEmit

  - kind: command
    description: starts without crash on empty input
    cmd: echo "" | node dist/index.js
    timeout_ms: 5000

  - kind: semantic
    description: handles GitHub API rate limit headers
    # 'semantic' checks are LLM-graded against the generated code. They
    # are noisy — use them sparingly and pair with deterministic checks.
    rubric: |
      The implementation should detect HTTP 403 with X-RateLimit-Remaining: 0
      and either back off or surface a clear error. A 'fetch then catch
      anything' pattern is NOT sufficient.

# Optional: known-good reference implementation. The harness does not
# diff against this — it's for human reviewers comparing failing runs.
# Stored as a directory under reference/.
has_reference: true

# Modes the harness should run this fixture in. v1 only ships against
# 'interactive', but we run both to gather autopilot baseline data.
modes: [interactive, autopilot]

# Maximum wall-clock budget per mode. Hard cap — fixture is scored as
# failed if the agent exceeds it. Tune based on tier.
budget_seconds: 600
```

## Score interpretation

The harness emits a scorecard JSON per run:

```json
{
  "run_id": "2026-05-02T14:32:11Z",
  "git_sha": "abc1234",
  "fixture_count": 50,
  "results": [
    {
      "fixture_id": "001-node-cli-csv",
      "mode": "interactive",
      "status": "pass" | "fail" | "timeout" | "error",
      "checks_passed": 4,
      "checks_total": 5,
      "interventions": 2,
      "wall_clock_seconds": 142,
      "failed_checks": ["semantic: rate limit handling"]
    }
  ],
  "aggregates": {
    "interactive_success_rate": 0.62,
    "autopilot_success_rate": 0.18,
    "mean_interventions_interactive": 3.4,
    "mean_interventions_autopilot": 11.2
  }
}
```

Compare against `fixtures/baselines/<latest>.json` to see trend over
releases. Drop in new baselines after major version cuts.

## Adding a fixture

1. Pick a tier (easy / medium / hard) based on honest difficulty.
2. Create `fixtures/<tier>/<NNN-slug>/fixture.yaml` using the format above.
3. Run `npm run fixtures -- --only <NNN-slug>` to verify the fixture
   itself parses and runs (the agent may still fail — that's fine).
4. If the fixture is non-trivial, add a reference implementation under
   `reference/`. Reviewers comparing failing runs will thank you.
5. Open a PR. CI will rerun all fixtures and report deltas vs baseline.

## Authoring guidelines

**Good fixtures:**
- Have a single clear deliverable (one CLI, one endpoint, one component)
- Use technologies the agent has likely seen (Node/TS, Python, Go, common frameworks)
- Test ONE difficulty axis at a time (correctness, OR error handling, OR multi-file integration — not all three at once)
- Have at least 3 deterministic rubric checks (file_exists, command) before any semantic checks

**Bad fixtures:**
- "Build a SaaS app" (too open-ended; no agent will pass meaningfully)
- Require external API keys (fixtures must be self-contained)
- Have only semantic checks (LLM grading is too noisy on its own)
- Test prompt-following rather than coding ability ("respond in haiku")
- Use proprietary frameworks the agent doesn't know

**Calibration check:** if a junior engineer with the same one-line
requirement and 30 minutes would also struggle, the fixture is probably
testing the wrong thing.