# my-api

An Express + TypeScript REST API scaffolded by NexusCode.

## Setup

```bash
npm install
```

## Run

```bash
npm start          # one-shot
npm run dev        # auto-reload on file change
```

Then:

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/echo \
     -H 'Content-Type: application/json' \
     -d '{"hello":"world"}'
```

## Configuration

- `PORT` env var sets the listen port (default 3000)

## Structure

- `src/server.ts` — Express app + routes. Add new routes here or
  split them into `src/routes/<feature>.ts` modules as the API grows.

## Production build

```bash
npm run build
node dist/server.js
```
