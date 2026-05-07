# my-cli

A TypeScript command-line tool scaffolded by NexusCode.

## Setup

```bash
npm install
```

## Run

```bash
npm start                              # show help
npm start -- greet --name World        # → "Hello, World!"
npm start -- greet --name World --shout  # → "HELLO, WORLD!"
npm start -- sum 1 2 3 4               # → "10"
```

Or with auto-reload while you're editing:

```bash
npm run dev -- greet --name World
```

## Test

```bash
npm test
```

## Build

```bash
npm run build           # emits dist/
node dist/index.js greet --name World
```

## Install globally

```bash
npm run build
npm link                # makes `my-cli` available on PATH
my-cli greet --name World
```

## Structure

```
src/
├── index.ts            # main() — entry point, subcommand dispatch
└── commands/
    ├── greet.ts        # demonstrates flag parsing
    └── sum.ts          # demonstrates positional args + validation

test/
└── cli.test.ts         # uses node:test (no external test runner)
```

## Adding a new subcommand

1. Create `src/commands/<name>.ts` exporting a function with signature
   `(args: readonly string[]) => number | Promise<number>`.
2. Wire it into the `COMMANDS` map in `src/index.ts`.
3. Add tests to `test/cli.test.ts`.

The CLI uses no parsing libraries by design — keep the dependency
tree empty until the surface area justifies adding `commander` or
`yargs`.

## Exit codes

- `0` — success
- `1` — runtime error (invalid input, IO failure, etc.)
- `2` — usage error (unknown command, missing required flag)
