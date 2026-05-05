# Tech

## Stack

- TypeScript 5.x with `strict: true`
- pnpm / npm / Yarn workspaces (whichever your monorepo uses)
- ESM modules (`"type": "module"` in each package.json)
- Node 20+

## TypeScript discipline

- **`strict: true` + `exactOptionalPropertyTypes: true`** in the base
  tsconfig. Don't relax these per-package without a documented
  reason in the package's README.
- **No `any` in public APIs.** A package's exported types are part
  of its contract; `any` defeats consumers' type-checking. Use
  `unknown` + narrowing if the input shape is genuinely unknown.
- **No `as` casts at API boundaries.** A type assertion at the
  edge of a package is a hidden contract violation. Validate at the
  boundary, then propagate the validated type.
- **Inferred return types are fine for internals; explicit for
  exports.** Exported functions declare their return types.

## Module structure

- ESM-first. CommonJS only for tooling that genuinely doesn't
  support ESM yet (e.g. some Jest setups — but Vitest is preferred
  in new code).
- No deep imports across packages. Consume the package's public
  entry point, never `import 'some-pkg/lib/internal/util'`.
- Each package's `package.json` declares `exports` explicitly. No
  `main` + `types` only — that allows deep imports the workspace
  doesn't intend.

## Cross-package dependencies

- Workspace dependencies use the `workspace:*` protocol (pnpm) or
  `*` (npm/Yarn workspaces). Never pin a workspace package to a
  semver range.
- A `packages/*` package may depend on another only via its public
  entry point.
- Dependency arrows form a DAG — circular dependencies between
  workspace packages are a structural error. The
  `circular-dep-check` hook in this Power scans for them.

## Build + types

- Each package builds independently with `tsc` or `tsup`.
- Type definitions are emitted (`.d.ts`) and pointed at from
  `package.json`'s `exports.types`.
- The monorepo's root `tsconfig.json` is for editor / IDE only;
  per-package `tsconfig.build.json` does the actual emit.

## Testing

- Vitest preferred. Co-located `*.test.ts` files next to source.
- Test code in TypeScript, not JavaScript. The same `tsconfig.json`
  applies to tests as to source.
- Each package has its own test script — the monorepo's root test
  runs them all in parallel via the workspace tool.
