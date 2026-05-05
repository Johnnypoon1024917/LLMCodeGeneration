# Structure

## Layout

A standard pnpm/npm/Yarn workspace:

- `packages/` — workspace packages, one directory per package
  - `packages/<name>/src/` — source
  - `packages/<name>/dist/` — built output (gitignored, hands off)
  - `packages/<name>/package.json` — declares `exports`,
    `dependencies`, `peerDependencies`
- `tsconfig.base.json` — strict-mode TypeScript base
- `tsconfig.json` — root config for IDE / editor support
- `package.json` — root, declares workspaces + dev tooling
- `.changeset/` — Changesets config (if used) for versioning

## Apps vs libs

If this monorepo also has applications (Next.js, Vite, Electron),
they live under `apps/` rather than `packages/`. The distinction:

- `packages/*` — published or internally-consumed libraries; have
  declared `exports`
- `apps/*` — terminal consumers; never published, never imported
  from another workspace member

## Exclude paths

The agent should not read these directories. Build artifacts,
caches, and dependency vendoring drown out signal:

- node_modules/
- dist/
- build/
- out/
- .next/
- .turbo/
- .nx/
- coverage/
- .cache/
- .vite/
- .vitest/
- .parcel-cache/
- .changeset/
- *.tsbuildinfo
