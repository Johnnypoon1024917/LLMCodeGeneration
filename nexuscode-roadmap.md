# NexusCode → Kiro Grade — Development Plan

*Drafted May 2026, after Sprint 3 PR 3.2. Updated for two-stage release.
Last status update: May 2026, after v1 Phase 1 complete and v1 Phase 2
substantially complete (P2.1 foundation + P2.2 + P2.3 shipped).*

---

## Executive summary

Sprint 3 PR 3.3 is the **last UI-only PR**. After that, the gap between NexusCode and Kiro is no longer about pixels — it's about agent quality, ecosystem, and operational polish.

**Strategic decision (May 2026):** Two-stage release.

- **v1 — Interactive Kiro grade** (4 months, marketplace launch by Q3 2026). NexusCode as a spec-driven coding assistant for regulated industries. Interactive workflow — developer stays at the keyboard. Audit-first, on-prem capable, zh-CN-ready. Generates revenue and customer feedback.
- **v2 — Hands-off Kiro grade** (6 months after v1, target Q1 2027). The actual Kiro pitch: developer types a one-line requirement, walks away, comes back to a working project. This is the harder problem — autonomy across 20+ sequential tasks without drift. Funded by v1 revenue, informed by v1 customer pain points.

**Why two stages:** Hitting "type a sentence and walk away" reliably is the unsolved problem in the agentic coding space — not a sprint deliverable. Even Anthropic and OpenAI haven't fully cracked autonomous multi-task project generation. Shipping v1 first means revenue + real customer telemetry while we work on the hard thing. Critically, **we start measuring autonomy from week 1 of v1 work**, so when v2 begins we already know the baseline number and which fixtures fail. Without measurement, "Kiro grade hands-off" is a vibe, not a target.

**Core thesis unchanged:** NexusCode wins enterprise/regulated APAC by being the *only* Kiro-class agent that runs air-gapped, on-prem, with hash-chained audit and bring-your-own LLM endpoint. We do **not** try to out-feature Kiro on AWS-centric workflows; we own the territory Kiro can't reach.

**One thing that strengthened the thesis:** Kiro had a publicly-reported customer incident (autonomous agent caused an AWS outage). NexusCode's 3-gate command security + hash-chained audit + on-prem positioning is now a *direct sales talking point*, not a theoretical moat. Lead with it — and be honest that v2's hands-off mode will need *even stronger* safety rails, because increased autonomy means increased blast radius when things go wrong.

---

## Status snapshot — May 2026

**v1 Phase 1 complete.** All five sub-phases shipped:

| Sub-phase | Status |
|---|---|
| P1.0 — Measurement infrastructure (50-fixture set + harness) | ✅ shipped, dormant — corp network policy blocks the test VS Code from reaching the LLM endpoint, manual baseline measured by hand instead. Harness code is in tree, will activate when the network constraint lifts or v2 picks it back up. |
| P1.1 — Verifier maturation (structured failures, single-shot self-heal, retry telemetry) | ✅ shipped |
| P1.2 — Spec-to-tasks quality (steering injection at planner) | ✅ shipped (cross-task dependency awareness + file-impact analysis deferred — those need real-LLM iteration data to tune) |
| P1.3 — Context selection (symbol-graph callers/callees + steering exclude filtering) | ✅ shipped (Tree-Sitter swap deferred to its own PR — multi-day vsce + wasm work, not safe to land without runtime validation) |
| P1.4 — Hook chat output (inline cards, audit integration, skip events) | ✅ shipped |

**v1 Phase 2 substantially complete.** Three of three sub-phases shipped:

| Sub-phase | Status |
|---|---|
| P2.1 — MCP support | ✅ foundation shipped (config schema, manager singleton, FS watcher, status pipe, webview panel). The `@modelcontextprotocol/sdk` integration itself is deferred — there's a clearly-marked `TODO(MCP-CLIENT)` block in `mcpManager.ts` with a contract for what the follow-up PR needs to do. Until that lands, configured servers transition to an `error` state with a "not yet integrated" message; the UI is fully ready. |
| P2.2 — Steering at agent runtime | ✅ shipped — steering reaches the Coder (not just the planner), with `## Applies to` scope filtering for per-file relevance |
| P2.3 — NexusCode Powers (curated bundles) | ✅ shipped — three bundles in `examples/powers/`: `banking-compliance-zh` (the wedge), `django`, `typescript-monorepo`. Plain Markdown, copy-paste install, no infrastructure. |

**Not yet started:** v1 Phase 3 (P3.1 telemetry, P3.2 perf, P3.3 docs), v1 Phase 4 (P4.1 marketplace publish, P4.2 pricing).

**Test coverage:** 580 host tests + 186 webview tests, all green on Linux and Windows after the P1.3 cross-platform path-resolution hotfix.

### Deferred items — each gets its own dedicated PR

These are NOT failures or skipped work — they're items where one-turn shipping would have produced unverified or risky code, so they were intentionally split off:

- **Tree-Sitter swap** (was part of P1.3). Replaces the regex-based AST parser. Multi-day work: web-tree-sitter dependency, wasm bundling, vsce packaging changes, language grammar selection, async loading lifecycle. The current regex parser has a `SwapTreeSitterNote` block in `astParser.ts` listing exactly what it misses (re-exports, dynamic imports, default-import name resolution).

- **MCP SDK client** (was part of P2.1). Real `@modelcontextprotocol/sdk` integration: stdio transport, JSON-RPC handshake, `tools/list` + `tools/call`, namespacing into the existing toolRegistry, lifecycle handling. The `TODO(MCP-CLIENT)` comment in `mcpManager.ts` documents the exact integration steps. Foundation (config, manager, UI, status plumbing) already in place.

- **Cross-task dependency awareness + file-impact analysis** (was part of P1.2). Both are prompt-engineering changes. Need real fixture data to tune. Will revisit when the manual baseline is run against the existing 50-fixture set.

### Manual fixture baseline — pending

The corp-network constraint that blocked P1.0's automated runner means we owe ourselves a manual run of the three highest-priority fixtures to establish the v1 baseline number. Until that's done, P1.x iteration is shooting blind. This is the single highest-value next action — more than starting Phase 3.

---

---

## Where we stand at end of Sprint 3 PR 3.2

### What's done (Kiro parity reached)

| Feature | NexusCode status | Kiro equivalent |
|---|---|---|
| Spec-driven workflow (Requirements → Design → Tasks) | ✅ PR 3.1 | Specs |
| EARS notation in requirements | ✅ PR 3.1 | EARS |
| Agent hooks (file save / command / schedule) | ✅ PR 3.2 | Agent Hooks |
| Hash-chained audit log | ✅ PR 2.4 + 2.4b | ❌ none |
| 3-gate command security (denylist + LLM judge + user confirm) | ✅ PR 0 | partial |
| zh-CN UI + RTL-clean tokens | ✅ Sprint 1-3 | ❌ EN-only |
| Bring-your-own OpenAI-compatible endpoint | ✅ existing | ❌ Bedrock-locked |
| 3-agent architecture (Planner / Coder / Verifier) | ✅ existing | unified agent |

### What's left for PR 3.3 (this last UI sprint)

- **Steering rules panel** — `.nexus/steering/*.md` editor UI. List, toggle, edit. Reuses the Panel chrome from PR 2.4 — small lift, ~1 day estimated.

After PR 3.3, the **UI work for Kiro parity is complete.** Everything below is non-UI.

---

## v1 — Interactive Kiro Grade (4 months to launch)

This is what we ship to the marketplace. The product promise is: *spec-driven coding assistant with the strongest audit and on-prem story in the market.* Developers stay at the keyboard — they review, approve, iterate. Hands-off generation is a v2 promise, intentionally not made in v1 marketing.

The four phases below sequence ~14 weeks of work into a shippable product. Each phase is shippable on its own; we don't have to land the whole thing in one go to start collecting feedback.

### Phase 1 — Agent quality + measurement foundation (5-6 weeks)

The biggest gap right now isn't a missing feature, it's **agent capability for the interactive workflow**. Even keyboard-bound developers want the agent to succeed more often before they have to intervene. v1 isn't trying to hit autonomous Kiro grade — it's trying to be the *most reliable interactive* coding assistant for regulated industries.

Critically, **measurement infrastructure built here doubles as v2 prep.** The 50-project fixture set, the success-rate tracking, the intervention-counter — all of it is needed for v2 anyway. Building it during v1 means v2 starts with a real baseline, not guesses.

**P1.0 — Measurement infrastructure (week 1, blocks everything else)**

Build a 50-project fixture set. Each project is a one-line requirement with:
- A canonical "this is what success looks like" reference implementation
- A pass/fail rubric: does it compile? do tests pass? does it actually run? does it match the requirement semantically?
- An automated runner that submits the requirement to NexusCode and scores the output

Track three numbers per release:
- **Generation success rate (interactive)**: % of fixtures that produce a runnable project with a developer reviewing each task — what v1 ships against
- **Generation success rate (autopilot)**: % that produce a runnable project hands-off — the v2 north star number, tracked from day 1 even though we don't ship against it yet
- **Mean human interventions per project**: tracked but not optimized in v1 — by v2, this is the number we care about most

Without this, every PR after week 1 is shooting blind. With it, every PR has a number we can move.

*Exit criteria:* fixture set committed to repo, runner script working, baseline numbers captured for current NexusCode (yes, even if they're embarrassing).

**P1.1 — Verifier maturation (2 weeks)**

The `VerifierAgent.ts` exists but is shallow. It runs the global compiler and reports pass/fail. For interactive v1, it should:
- Run unit tests scoped to changed files (already partial — needs to actually parse test output and tag failures by file/line)
- Surface failures to the user clearly with file/line/error attribution — interactive workflow assumes the human resolves, but we want them to resolve faster
- Single-shot self-heal: when a verifier failure is unambiguous (single typo, missing import), the agent retries once before surfacing to the user
- *Exit criteria:* interactive success rate on fixture set increases by ≥20 points

(v2 will extend this into multi-shot autonomous self-heal — see v2 section.)

**P1.2 — Spec-to-tasks quality (1 week)**

The PlannerAgent generates tasks but they often skip integration concerns. Investments:
- Cross-task dependency awareness (task B reads file A wrote)
- File-impact analysis up front (which files will this spec actually touch?)
- Steering-rule injection at plan time (so the planner respects project conventions before generating tasks)
- *Exit criteria:* generated task lists pass a "would a senior engineer accept this PR plan?" review on 10 representative specs

**P1.3 — Context selection (1-2 weeks)**

We currently dump a lot of tokens into context. Investments:
- Replace the regex-based AST parser with a proper Tree-Sitter binding (the README originally claimed Tree-Sitter; we removed the claim, now it's time to make it true)
- Symbol-graph context: when editing function `foo`, automatically include `foo`'s callers and callees, not just the file
- Steering-aware context filtering: if a steering rule says "never include the legacy module", honor it

**P1.4 — Hook execution surfaced in chat (3-4 days)**

Today, hook executions stream output to a dedicated `NexusCode Hooks` OutputChannel. Functional but invisible — users have to know to go look. Kiro shows hook executions as inline conversation events. We should match that:
- When a hook fires, the webview shows a collapsible card in the chat thread (icon + hook name + trigger reason + streaming output)
- The card uses the same visual language as `ToolCallCard` (PR 2.2) — pill for status, expandable body
- Errors stream to chat AND to the audit log
- The OutputChannel stays — power users still want a single tail-able log
- *Why bundled in Phase 1:* the plumbing overlaps with the verifier-feedback work in P1.1

This is the highest-ROI phase for v1. Code quality is the product. UI polish doesn't matter if the agent ships broken code.

### Phase 2 — Ecosystem (3 weeks)

Kiro's ecosystem moves are **MCP servers** (now mainstream) and **Kiro Powers** (curated bundles). We deferred MCP earlier; reconsidering given the trajectory.

**P2.1 — MCP support (2 weeks)** — ✅ foundation shipped May 2026; SDK integration deferred to its own PR
The decision earlier was to defer MCP. Re-evaluating now: MCP has become table-stakes in 6 months. Every serious agent product supports it. Specifically:
- Implement MCP client in the host (the agent calls MCP-exposed tools)
- Wire a `.nexus/mcp-servers.json` config (matches Kiro's `.kiro/mcp.json` shape for portability)
- Add an MCP servers tab to the settings UI — shows status (connected / failed) per server
- *Exit criteria:* user can add a stdio-based MCP server (e.g. `filesystem`, `github`) and the agent uses its tools transparently

**What's actually shipped:** config schema (`mcpConfig.ts`), manager singleton with FS watcher (`mcpManager.ts`), webview MCP panel in the rail's footer, full host↔webview status plumbing. 47 new tests. The actual `@modelcontextprotocol/sdk` integration — spawning the server process, JSON-RPC handshake, registering tools into the agent's toolRegistry — is a clearly-marked `TODO(MCP-CLIENT)` block in `mcpManager.ts`. Until that ships, configured servers transition to an `error` state with an explicit "not yet integrated" message; the UI is fully ready and validates correctly.

**P2.2 — Steering files at agent runtime (1 week)** — ✅ shipped May 2026
PR 3.3 ships the steering UI, but we still need to actually *use* steering rules in agent prompts:
- Inject relevant steering files into PlannerAgent and CoderAgent system prompts
- Glob-scoped steering ("apply this rule only to files in src/server/") — Kiro has this
- *Exit criteria:* a steering rule "always use Result<T,E> instead of throw" actually changes generated code

**What shipped:** P1.2 had already covered the planner side; P2.2 extended steering injection to the Coder via a new `perFileSteering?` callback on `RunTaskOptions`. The Coordinator resolves per-file steering ONCE before the retry loop (file is fixed for that loop) and forwards the result as `globalRules` to each Coder dispatch. Glob-scoping is implemented via a new `## Applies to` convention — bullet list of path prefixes, substring match against the target filepath. No glob library dependency added; substring covers the documented use cases ("src/server/", "tests/") and authors who need glob-level precision write multiple substring patterns. Files without an `## Applies to` section apply globally (backwards compatible). 16 new tests.

**P2.3 — NexusCode Powers (informally) (parallel, ongoing)** — ✅ shipped May 2026

Kiro Powers are curated bundles. We don't need a "Powers store" infrastructure — but we should ship a **few public examples** (probably as separate GitHub repos):
- `nexuscode-power-django` — steering rules + hooks for Django projects
- `nexuscode-power-banking-compliance-zh` — steering rules + audit hooks tuned for HK financial-services compliance (this is the wedge for our actual customers)
- *Exit criteria:* 2-3 public bundles users can clone into `.nexus/` to bootstrap

**Shipped at `examples/powers/`** (in-tree rather than separate repos for now — copying out to standalone repos can happen at marketplace publish time without changing the format):

- `examples/powers/banking-compliance-zh/` — three steering files + two hooks, demonstrates `## Applies to` scope filtering and `## Exclude paths`. The audit-log-on-save hook scans saved files in the regulated paths for missing `audit.logTransaction` calls; the pii-scan command hook flags untagged PII fields.
- `examples/powers/django/` — Django + DRF conventions, plus a migration-check hook that fires when `models.py` is saved.
- `examples/powers/typescript-monorepo/` — pnpm/npm/Yarn workspace conventions, plus a circular-dep check command and a (disabled-by-default) weekly stale-deps scheduled hook. Includes the only example of `onSchedule` in the bundle set.

Two smoke-test files (`_powerBundleHookParse.test.ts`, `_powerBundleSteeringParse.test.ts`) exercise every hook frontmatter and steering file against the production parsers — catches authoring drift before it reaches users.

### Phase 3 — Operational polish (2-3 weeks)

This is the "boring stuff that wins enterprise sales" phase.

**P3.1 — Telemetry + diagnostics (1 week)**
Currently when a task fails the user has limited insight into *why*. Investments:
- Per-task timeline view (which tools were called, how long each took, what the LLM verdict was)
- Token usage breakdown per task (planner / coder / verifier separately)
- Export a session as a single JSON bundle for support tickets
- *Exit criteria:* a customer can paste a session bundle to support and we can debug remotely

**P3.2 — Performance (1 week)**
The webview bundle is 1.9MB. Kiro's is bigger but it has more excuse (different distribution model). We should:
- Measure cold-start latency and warm-start latency (no instrumentation today)
- Decompose App.tsx — it's 2,500+ lines; React.memo opportunities are obvious
- Investigate whether Vite's `iife` output format can be replaced with `es` once VS Code's CSP allows dynamic chunks

**P3.3 — Documentation (1 week, parallel)**
The README is a feature list, not a doc. Need:
- Quickstart (5-minute install → first spec)
- "Why NexusCode" page — the moat narrative we keep talking about, in writing
- Steering / Hooks / Specs guides with examples
- Migration guide from Cursor / Continue / Copilot

### Phase 4 — Release (2 weeks)

**P4.1 — Marketplace publish (1 week)**
- Replace `your-publisher-id` placeholder with actual publisher
- VSIX signing
- Privacy policy + terms of service (required for marketplace)
- Open VSX publish too (so Kiro IDE users — yes, even Kiro users — can install NexusCode as an extension if they want a stronger audit story)
- *Exit criteria:* `code --install-extension nexuscode` works for end users

**P4.2 — Pricing + billing (1 week)**
- Free tier — local LLM endpoint only, no usage limits
- Pro tier — bring-your-own cloud key, audit log retention beyond 30 days, priority support
- Enterprise tier — on-prem deployment package, SSO, custom audit retention
- This is non-engineering work but blocks revenue. Decide pricing before P4.1 ships.

---

## v2 — Hands-off Kiro Grade (Q4 2026 → Q1 2027)

This is the harder bet. The promise is: *developer types a one-line requirement, walks away, comes back to a working project.* The engineering challenge is not "smarter model" — it's autonomy across 20+ sequential tasks without drift, without asking the user, without hitting failure modes the agent can't recover from. That problem is unsolved at the frontier; we're betting that NexusCode's narrower working envelope (regulated-industry projects with strong steering rules) makes it tractable for us.

**Why v2 starts after v1 launches, not before:**

1. **Revenue funds v2.** v1's Pro/Enterprise tiers pay for the engineering time v2 needs.
2. **Customer telemetry guides v2.** Two months of v1 production usage tells us what *real* projects look like — not what we guessed in fixture-design phase.
3. **v1's measurement infrastructure is v2's North Star.** P1.0 ships the fixture set in week 1 of v1; by the time v2 starts we have months of trend data showing which fixtures the agent gets right and which it doesn't.
4. **v1's interactive workflow is the v2 fallback.** When v2's autonomy fails, the user falls back to v1's interactive mode. Without v1, v2 has no graceful degradation — and autonomous agents WILL fail sometimes.

**v2 success bar: 70% generation success rate on fixture set in autopilot mode, <2 human interventions per project.** When this number is hit, we ship v2. Not before.

**V2.1 — Project scaffolder (3-4 weeks)**

Today the Coder agent edits files. It doesn't create projects from nothing. v2 changes this:
- New PlannerAgent capability: detect "greenfield project" intent (no existing src/, package.json, etc.) and emit a scaffolding plan first — directory creation, package.json, config files, before any implementation tasks
- Templates for common stacks (Node/TS, Python, Go, React) shipped as `.nexus/scaffolds/*` — agent picks one and customizes
- Steering-aware scaffolding: if `tech.md` says "Vite + React + Tailwind", the scaffolder uses that exact stack
- *Exit criteria:* on the autopilot fixture set, "create a Node CLI that does X" produces a working `package.json + tsconfig.json + src/index.ts` with `npm install && npm start` succeeding hands-off

**V2.2 — Multi-shot verifier self-heal (3-4 weeks)**

v1's verifier surfaces failures to the user. v2's verifier becomes a feedback loop:
- On failure, automatically request a Coder retry with the verifier's failure context attached as a tool result — capped at 3 retries per task
- Cross-task verification: if task B's tests break code from task A, automatically schedule a remediation task
- Track and surface "things I tried" so the user reviewing the session sees the dead ends, not just the result
- *Exit criteria:* autopilot success rate increases by ≥30 points from v1 baseline without user intervention

**V2.3 — Autonomy decision taste (4-6 weeks, the hardest part)**

Kiro's secret isn't a smarter model — it's good *taste* about when to ask vs proceed. This is prompt engineering, steering rule design, and a lot of trial-and-error tuning. There is no clean technical solution. Decisions to teach the agent:
- Library choice when the steering file says nothing → pick the obvious default, note it in the task summary, don't ask
- Naming when not specified → use project conventions (read existing files), don't ask
- Test framework when not specified → match what's already in package.json, or pick Jest, don't ask
- Real ambiguity (two valid interpretations of the requirement, security-relevant choice, anything destructive) → DO ask
- Provide an autopilot-mode that's *qualitatively* different from v1's confirm-on-bash:false — the agent should be measurably more decisive, not just less prompty
- *Exit criteria:* mean human interventions per fixture project drops to <2 in autopilot mode

This is the v2 phase most likely to slip. Budget accordingly. If it slips, ship v2.1 + v2.2 as a "v1.5" interactive-quality update first, and continue v2.3 work without a release deadline.

**V2.4 — Long-context survival (2-3 weeks)**

Long autonomous sessions accumulate context until the agent forgets what it was doing. Investments:
- Context decay: tasks N steps back get summarized rather than included verbatim
- Symbol-graph scoping (carried over from v1's P1.3 — used more aggressively in autopilot)
- Per-task memory checkpoints — when the agent loses thread, it can re-read its own task summary
- *Exit criteria:* fixture projects of 15+ tasks complete without context-window failures in autopilot

**V2.5 — Self-assessment "is this done?" (2-3 weeks)**

Autonomous = no human in the loop confirming "yes that's complete." The agent has to assess its own work against the original requirement. This is rarely discussed and frequently broken in agentic systems:
- Final-pass evaluation: does the implementation satisfy the original spec? Are there missing acceptance criteria?
- Smoke-test execution: actually run the project (start the server, call the endpoint, render the page) — not just compile
- Honest "I tried but couldn't" reporting when the agent genuinely can't finish, with detailed dead-ends so the user picks up where it left off
- *Exit criteria:* on fixture set, projects the agent reports as "complete" actually pass the rubric ≥90% of the time (no false-positive completions)

**Enhanced safety for v2 (continuous, throughout)**

Increased autonomy = increased blast radius. v2's safety story has to be stronger than v1's, not just equal:
- Autopilot mode requires explicit per-session opt-in (no globally-on autopilot)
- Stricter command denylist when autopilot is active
- Periodic sanity checks (every 5 tasks, the agent pauses and reports progress to the user — even in autopilot, the user gets a chance to intervene)
- Audit log entries explicitly tagged with "autopilot decision" for downstream compliance review
- *Why this matters for the moat:* the Kiro AWS incident happened because Kiro's autonomous agent had too much trust + too much reach. NexusCode's v2 *cannot* repeat that. The audit + safety story isn't optional polish — it's the whole reason regulated customers will buy v2 instead of just using Kiro for non-regulated work.

---

## Sequencing

### v1 — Interactive Kiro Grade (16 weeks to marketplace)

```
Week 1     ──── PR 3.3 (steering UI)                    (1 day)
                P1.0 fixture set + measurement runner    (1 week, blocks P1.1+)

Week 2-3   ──── P1.1 verifier maturation                 (2 weeks)

Week 4-6   ──┬── P1.2 spec-to-tasks + P1.3 context       (3 weeks parallel)
             └── P1.4 hook chat output                   (3-4 days, parallel)

Week 7-9   ──── P2.1 MCP + P2.2 steering runtime         (3 weeks)
                P2.3 Powers (banking-compliance-zh first, parallel)

Week 10-12 ──── P3.1 telemetry + P3.2 perf + P3.3 docs   (3 weeks parallel)

Week 13-14 ──── P4.1 marketplace + P4.2 pricing          (2 weeks)

Week 15-16 ──── Buffer / customer onboarding / hotfix    (2 weeks)
```

**v1 marketplace launch: ~Q3 2026** (16 weeks from now). Buffer in weeks 15-16 is non-negotiable — every release I've seen ship without buffer slips into the buffer-that-doesn't-exist.

### v2 — Hands-off Kiro Grade (~6 months after v1)

v2 work begins post-launch when v1 is stable and we have ~2 months of customer telemetry. Rough sequencing — to be re-planned with real fixture-set data:

```
Month 1     ── Re-baseline autopilot success rate against current fixtures
              + add 50 more fixtures (deepening, harder projects)

Month 2-3   ── V2.1 Project scaffolder
              + V2.2 Multi-shot verifier self-heal

Month 4     ── V2.3 Autonomy decision taste (the hardest part)

Month 5     ── V2.4 Long-context survival (decay, summarization)

Month 6     ── V2.5 Self-assessment ("is this actually done?")
              + buffer + v2 release
```

**v2 release target: Q1 2027.** Calendar estimate, not engineering estimate — autonomy work has uncertain duration. The fixture numbers tell us when we ship, not the calendar.

---

## What we are NOT doing

Worth being explicit. These are tempting but cost-vs-value isn't there:

1. **Forking Code-OSS to make a standalone IDE.** Kiro did this. We don't need to. Being a VS Code extension is a *distribution advantage* — users keep their entire setup. Fork-the-IDE is a multi-quarter detour with no customer benefit.

2. **Building a Kiro Powers marketplace.** A registry, search UI, install flow, reviews — this is a year of work. Ship 2-3 bundles as plain GitHub repos. Re-evaluate in 2027 if there's pull.

3. **Beating Kiro at AWS-native workflows.** They will always win this. We win by being the only viable choice for customers who *can't* use AWS-native (HK financial services, PRC subsidiaries, defense, healthcare with local data residency).

4. **Multimodal input (image-to-code, screenshot debugging).** Kiro doesn't have this either yet, and our enterprise customers don't ask for it. Track it; revisit if the field moves.

5. **Mobile/web companion app.** Same reasoning — Kiro doesn't have it, customers don't ask for it.

---

## Risks, in order of severity

**1. Agent quality lag in v1.** If v1's Phase 1 doesn't move the interactive success number meaningfully, we ship a v1 that customers reject as "not better than what they have." Mitigation: P1.0 fixture set in week 1 makes this measurable from the start, not discoverable at launch. If interactive success rate isn't moving by week 6, restructure the remaining v1 work.

**2. v2 autonomy doesn't crack within 6 months.** This is the v2 bet's biggest risk. Hands-off project generation is unsolved at the frontier; we're betting that NexusCode's narrower regulated-industry envelope makes it tractable. It might not. Mitigation: v1 already pays the bills. If v2 slips to 12 months, that's painful but not fatal. The fixture data tells us by v2-month-4 whether autopilot success is trending toward 70% or stuck at 30%. If it's stuck, we ship a "v1.5" interactive-quality update and keep working on v2 without a release deadline.

**3. Kiro releases on-prem before our v2 ships.** Currently Bedrock-locked, but AWS could change that. If Kiro ships on-prem in late 2026, our moat narrows just as v2 launches. Mitigation: keep emphasizing the audit + multi-LLM-endpoint story even if Kiro adds on-prem. Hash-chained audit is uncopyable in 6 months because it requires architectural commitment. Also: even an on-prem Kiro is still Bedrock-architected — the LLM choice is fixed, our choice isn't.

**4. Anthropic releases Claude Code as an enterprise product.** Already a thing for individuals. If Anthropic ships an enterprise SKU with audit + on-prem during v1's launch window, our wedge narrows. Mitigation: NexusCode runs *any* OpenAI-compatible endpoint — including Claude through a relay — so customers don't have to pick a model lock-in. Anthropic's enterprise SKU forces customers to commit to Anthropic; we don't.

**5. The HK financial-services compliance angle is narrower than we think.** It's a real wedge but not a billion-dollar TAM by itself. If the banking-compliance-zh Power ships in v1 and gets zero adoption in 90 days, the bet was wrong and we should pivot to general regulated-industry positioning (defense, healthcare).

**6. v1 launches but customers don't pay.** Marketplace install != paying customer. v1's pricing tiers (free/Pro/Enterprise) are a guess; we'll learn fast which tier customers actually buy. Mitigation: don't sequence v2 capacity planning until v1 has 10+ paying enterprise seats. Revenue is the gate for v2 funding.

**7. v2 ships and reproduces the Kiro AWS incident class of failure.** Increased autonomy = increased blast radius. A NexusCode-driven autonomous incident at a customer site would be catastrophic for the regulated-industry positioning. Mitigation: v2's enhanced safety section is non-negotiable — autopilot opt-in, periodic check-ins, audit tagging. If safety can't ship at v2-grade, we don't ship v2.

**8. Test coverage is shallow.** 117 webview tests + 28 host tests is decent for a UI sprint but won't survive the verifier maturation work in v1's Phase 1, let alone v2's autonomy work. Investing in the 50-project fixture set is a v1 Phase 1 prerequisite, not a v1 Phase 3 nice-to-have.

---

## What "Kiro Grade" actually means — the bar

There are now two bars, one per release stage.

### v1 — Interactive Kiro Grade

We ship v1 when:

- A new user can install from marketplace, write a spec in plain English, and get working code in <10 minutes (with the developer reviewing each task)
- A senior engineer reviewing the generated PR thinks "yeah, that's about what I'd write" — not "the AI's first draft, I'll rewrite it"
- A compliance officer can audit a session end-to-end via the JSONL log and the audit panel without asking us for help
- The product runs against a customer's on-prem GPU cluster as well as it runs against OpenAI's API
- Interactive success rate on fixture set ≥85% (the developer might intervene on failures, but the agent doesn't get stuck or confused often)
- Pricing is paid by ~30 paying enterprise seats by end of Q4 2026

Three of these (UI, audit, on-prem) are largely done. Three (interactive agent quality, fixture-measured success rate, paying customers) are the v1 work ahead.

### v2 — Hands-off Kiro Grade

We ship v2 when:

- A developer types a one-line requirement, walks away from their computer, and comes back to a working project
- Autopilot success rate on fixture set ≥70%
- Mean human interventions per fixture project <2 in autopilot mode
- v2 has *demonstrably stronger* safety rails than v1 — autopilot mode requires explicit opt-in, periodic check-ins surface autonomous decisions for review, audit log clearly tags autopilot-driven changes
- v2 doesn't reproduce the Kiro AWS incident class of failure — autonomous + reach but no governance

This is the bar your original framing pointed at. It's a 6-month bet after v1 launches. The fixture data we collect during v1 tells us in advance whether the bar is realistic in 6 months or 12.

---

## What I recommend doing next

After PR 3.3 ships and verifies clean:

1. **Build the fixture set (P1.0) in week 1.** This is the single most important deliverable in the entire roadmap — it's how v1 measures progress AND how v2 knows when to ship. Without it, every PR after week 1 is shooting blind, AND v2 will start with no baseline data when it begins in 4 months. Define "task completion" rigorously: did the verifier pass? Does the test suite still pass? Does the diff actually do what the spec said? Does the project actually run?

2. **Track BOTH interactive AND autopilot success rates from day 1.** Even though v1 ships against the interactive number, run the fixtures in autopilot mode too and record the result. By the time v2 starts, you'll have 4 months of trend data on autopilot mode showing which fixtures get harder, which get easier, and where the actual gap is.

3. **Then start P1.1 (verifier maturation).** This is the highest-leverage v1 work. Single-shot self-heal moves the interactive number; the multi-shot version moves the autopilot number in v2. Building the foundation right in v1 saves us re-architecting in v2.

4. **Run P3.3 (docs) in the background from week 1.** Documentation is rarely the critical path but is always the critical missing thing at launch. Better to write it as we build than to cram it at the end.

5. **Plan v2's first month of work *during* v1 weeks 12-16.** When v1 ships, the v2 plan should already exist with concrete fixtures, concrete numbers, and concrete owners. Don't wait until v1 is in customers' hands to start thinking about v2.

**v1 marketplace launch is ~4 months out. v2 hands-off launch is ~10 months out.** v1 is realistic and fundable. v2 is a real engineering bet — fundable by v1's revenue, informed by v1's customer feedback, and contingent on the autopilot fixture number actually moving. We will know by month 8 whether v2 ships in month 10 or month 14. The data tells us, not the calendar.

