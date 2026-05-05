# Product

> **Customise this file** with your monorepo's product domain. The
> placeholder below describes a generic shape.

## Domain

This is a TypeScript monorepo with multiple inter-dependent packages
under `packages/`. The product context — what the workspace as a
whole produces, who the consumers are — should be filled in here.

## Cross-package principles

- Public-facing packages (those published or consumed by external
  apps) have stable, documented APIs.
- Internal-only packages can change shape freely AS LONG AS their
  consumers within this workspace also update.
- A package's `package.json` `private: true` flag is the
  authoritative signal of "internal".
