# my-app

A React + Vite + Tailwind frontend scaffolded by NexusCode.

## Setup

```bash
npm install
```

## Run

```bash
npm run dev        # dev server with HMR at http://localhost:5173
npm run build      # production build to dist/
npm run preview    # serve dist/ locally to preview
npm run typecheck  # tsc --noEmit
```

## Structure

- `src/main.tsx` — React entry point. Mounts <App> into #root.
- `src/App.tsx` — Sample component. Replace with your own.
- `src/index.css` — Tailwind import. Add custom CSS here.
- `vite.config.ts` — Vite + React + Tailwind plugin setup.
- `tsconfig.json` — strict TypeScript config.

## Tailwind v4

This scaffold uses Tailwind v4, which uses a Vite plugin instead of
the v3 PostCSS setup. There is no `tailwind.config.js` or
`postcss.config.js` — configuration goes in `vite.config.ts` or as
CSS @theme directives in `src/index.css`. See
https://tailwindcss.com/docs/v4-beta for the migration guide.

## Add components

Create `src/components/<Name>.tsx`, export a default function
component, import where needed. For state management beyond useState,
consider `zustand` (small) or `@tanstack/react-query` (server state).
