# nexuscode-power-banking-compliance-zh

A NexusCode Power for HK / PRC financial-services projects working under
HKMA, SFC, or PBoC compliance regimes. Steering rules + hooks to keep
agent-generated code aligned with banking-grade standards: explicit
error handling, no PII leaks, mandatory audit-log statements for
state-changing operations, and Cantonese-friendly logging messages.

> **Power 是什麼？**
> NexusCode Power 是一組 steering rule（`.nexus/steering/*.md`）加上
> hook（`.nexus/hooks/*.md`），用來把 agent 引導到符合特定行業要求的
> 寫法。把 `.nexus/` 整個資料夾複製到你的 project root 就會生效。

## What this bundle does

Three steering files shape the agent's behaviour:

- **`product.md`** — banking-domain context (HKD precision, MOP/CNY
  cross-currency, regulator references). Globally applied.
- **`tech.md`** — TypeScript and Python conventions for the regulated
  code paths: `Result<T, E>` over `throw`, no implicit `any`, every
  PII field tagged with a `@pii` JSDoc/docstring, every state mutation
  funneled through `audit.logTransaction(...)`. **Scoped** to
  `src/banking/`, `src/compliance/`, and `src/transactions/` via a
  `## Applies to` block — generic utility code is NOT subjected to
  these stricter rules.
- **`structure.md`** — folder layout expectations + an `## Exclude paths`
  block that hides `legacy/`, `vendor/`, and `generated/` from the
  agent's context picker.

Two hooks:

- **`audit-log-on-save.md`** — fires when any file under
  `src/banking/**`, `src/compliance/**`, or `src/transactions/**` is
  saved. Asks the agent to scan for state-changing operations missing
  an `audit.logTransaction` call and report them as a JSON diff. The
  user reviews and applies — no auto-write.
- **`pii-scan-on-command.md`** — manual command (`nexuscode.hook.pii-scan`)
  that scans the entire workspace for fields that look like PII (HKID,
  phone, address, account number patterns) but lack the `@pii` tag.

## What this bundle does NOT do

- It does not provide regulatory compliance certification — it just
  steers the agent toward writing code that passes a normal compliance
  review faster.
- It does not encrypt or redact data.
- It does not run any kind of static analysis tool — the hooks ask the
  LLM to look at the code; treat its output as advisory.
- It does not auto-write any file. Every change still goes through
  the agent's normal review-then-apply flow.

## Install

From your project root:

```bash
# Option A: copy verbatim
cp -r path/to/nexuscode-power-banking-compliance-zh/.nexus ./

# Option B: merge into existing .nexus/
cp -r path/to/nexuscode-power-banking-compliance-zh/.nexus/steering/* ./.nexus/steering/
cp -r path/to/nexuscode-power-banking-compliance-zh/.nexus/hooks/* ./.nexus/hooks/
```

NexusCode picks up the changes automatically — no restart required.

## Customisation

The steering rules are written for a "typical" HK retail-banking shape.
You'll likely want to:

1. Edit `product.md` to name your specific business domain (deposits,
   credit cards, securities, etc.).
2. Edit the `## Applies to` paths in `tech.md` to match your
   monorepo's actual folder layout.
3. Add organisation-specific patterns to the PII regex hints in the
   PII-scan hook.

These files are plain Markdown — version them with the rest of your
repo, code-review them, treat them like config-as-code.

## Why scope filtering matters here

Banking codebases typically have a regulated core + a much larger
non-regulated periphery (admin tools, internal dashboards, marketing
microsites). Applying `Result<T, E>` and audit-logging conventions to
EVERY file would cause friction in the non-regulated parts. The
`## Applies to` block in `tech.md` keeps the strict rules confined to
where they earn their keep.

If your repo doesn't have that split, edit `tech.md` and remove the
`## Applies to` section — the rules will then apply globally.
