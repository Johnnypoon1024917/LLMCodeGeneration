# NexusCode Powers

A "Power" is a curated bundle of steering rules + hooks that pre-
configures NexusCode for a specific project shape. Drop the bundle's
`.nexus/` directory into your project root and the agent immediately
operates with the conventions baked in.

There is no installer, registry, or store — Powers are plain Markdown
files versioned in Git, copy-pasteable, and reviewable.

## Available bundles

| Bundle | What it's for |
|---|---|
| [`banking-compliance-zh/`](./banking-compliance-zh/) | HK / PRC financial-services projects under HKMA / SFC / PBoC oversight. Demonstrates **scoped steering** (`## Applies to`) and audit-focused hooks. |
| [`django/`](./django/) | Django + DRF web applications. ORM discipline, migration awareness. |
| [`typescript-monorepo/`](./typescript-monorepo/) | pnpm/npm/Yarn workspace monorepos. Strict TS, ESM, no circular deps. Demonstrates the **scheduled** hook trigger. |

## Installing a bundle

```bash
# From inside your project root:
cp -r path/to/nexuscode/examples/powers/<bundle-name>/.nexus ./
```

NexusCode picks up the changes automatically — no restart required.
Both the steering panel and the hooks panel will refresh.

If your project already has a `.nexus/` directory, merge selectively:

```bash
cp -r path/to/.../<bundle>/.nexus/steering/* ./.nexus/steering/
cp -r path/to/.../<bundle>/.nexus/hooks/*    ./.nexus/hooks/
```

## What's in a bundle

Each bundle is a directory containing:

```
<bundle-name>/
├── README.md             — what this bundle does, what to customise
└── .nexus/
    ├── steering/
    │   ├── product.md    — domain context (often a placeholder)
    │   ├── tech.md       — language / framework / discipline rules
    │   └── structure.md  — folder layout + ## Exclude paths
    └── hooks/
        └── *.md          — agent hooks (frontmatter + prompt body)
```

The `.nexus/` subtree is what gets copied into the user's project.
The README and the wrapping directory are documentation, not
distributed.

## Authoring your own bundle

Steering files use the conventions documented in NexusCode's main
docs. Briefly:

- **`## Applies to`** — bullet list of path prefixes. When present,
  the steering file ONLY applies to tasks whose target file matches
  one of the prefixes. When absent, the file applies globally.
- **`## Exclude paths`** — bullet list of substring patterns.
  Matching paths are filtered out of the agent's context-picker.
- **HTML comments** are stripped before injection — use them
  liberally for in-file authoring notes that shouldn't reach the
  agent.

Hooks use YAML frontmatter:

```yaml
---
name: My hook
description: One-line description
trigger:
  type: onFileSave    # or onCommand or onSchedule
  pattern: "src/**/*.ts"  # for onFileSave
  # commandId: my-cmd     # for onCommand
  # everySeconds: 3600    # for onSchedule (min 60)
enabled: true
---
```

Below the frontmatter, the prompt body has access to template
variables: `{{workspaceRoot}}`, `{{filePath}}`, `{{fileContent}}`,
`{{triggeredAt}}`, `{{triggerType}}`.

## Why "Powers" as plain repos, not a registry

The roadmap considered building a Powers store with discovery,
ratings, install flow. That's a year of work for benefits a registry
brings only at scale. Plain Git directories are:

- Reviewable as PRs
- Diffable across versions
- Forkable for org-specific adjustments
- Compatible with any code-review workflow you already have

When the ecosystem grows past three bundles, we'll revisit. For now,
Markdown wins.
