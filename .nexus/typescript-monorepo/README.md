# nexuscode-power-typescript-monorepo

A NexusCode Power for TypeScript monorepos managed with pnpm
workspaces, npm workspaces, or Yarn workspaces. Steering rules + hooks
for keeping cross-package dependencies sane, surface areas honest,
and the workspace not-on-fire.

## What this bundle does

Three steering files:

- **`product.md`** — placeholder, customise per project.
- **`tech.md`** — TS strict-mode discipline, exactOptionalPropertyTypes,
  no `any` in public APIs, `tsconfig` extends-from-base, ESM-first.
- **`structure.md`** — `packages/*` layout + `## Exclude paths` for
  build artifacts, caches, and node_modules across nested workspaces.

Two hooks:

- **`circular-dep-check-on-command.md`** — manual command. Asks the
  agent to scan workspace package dependency arrows for cycles
  between `packages/*`.
- **`stale-deps-weekly.md`** — scheduled (weekly). Reviews
  `package.json` files for dependencies that are major-version
  behind, with a recommendation to upgrade or pin.

## Install

```bash
cp -r path/to/nexuscode-power-typescript-monorepo/.nexus ./
```
