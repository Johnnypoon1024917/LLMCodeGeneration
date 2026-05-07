# my-app

A React + Vite + TypeScript app scaffolded by NexusCode.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev              # dev server with hot reload (default port 5173)
```

Open <http://localhost:5173>.

## Test

```bash
npm test                 # one-shot
npm run test:watch       # watch mode
```

Tests use Vitest + @testing-library/react with jsdom. The setup file
(`src/test/setup.ts`) extends `expect` with jest-dom matchers and
auto-cleans the DOM between tests.

## Build

```bash
npm run build            # typechecks + emits dist/
npm run preview          # serves dist/ to verify the production build
```

## Typecheck only

```bash
npm run typecheck
```

## Structure

```
src/
├── main.tsx                          # React root, mounts <App />
├── App.tsx                           # Composes the example components
├── styles.css                        # Minimal global styles
├── components/
│   ├── Counter.tsx                   # useState example
│   └── HealthStatus.tsx              # useEffect + fetch with discriminated state
└── test/
    ├── setup.ts                      # vitest setup, jest-dom matchers
    ├── Counter.test.tsx              # user-event interactions
    └── HealthStatus.test.tsx         # fetch mocking, async assertions

index.html                            # Vite entry HTML
vite.config.ts                        # Vite + Vitest config (single file)
tsconfig.json                         # Project references
tsconfig.app.json                     # src/ TS config
tsconfig.node.json                    # vite.config.ts TS config
```

## Patterns to keep

The example components illustrate two patterns worth carrying
through to your real components:

**Discriminated-union state** (see `HealthStatus.tsx`) — instead of
three booleans (`isLoading`, `isError`, `isOk`) that can disagree,
use one tagged union `{ kind: 'idle' | 'loading' | 'error' | 'ok' }`.
Eliminates impossible states.

**AbortController in useEffect** — the fetch hook ties the request
lifetime to the component's mounted state. If the component unmounts
mid-flight, the controller aborts and the catch ignores the
`AbortError`. Prevents "setState on unmounted component" warnings.

## Production notes

- The HealthStatus example fetches `/api/health`. In production you'd
  point this at a real backend or remove the component entirely.
- No CSS framework is shipped by default. Add Tailwind, CSS Modules,
  vanilla-extract, etc. per your team's preference.
- No router shipped. Add `react-router-dom` or `@tanstack/react-router`
  when you need navigation.
- No state management library shipped. `useState` + `useReducer` cover
  most needs; reach for Zustand / Jotai / Redux only when there's a
  real cross-component-tree state requirement.
