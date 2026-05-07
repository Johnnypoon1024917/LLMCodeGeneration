# my-api

A FastAPI service scaffolded by NexusCode.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate     # Linux/macOS
.venv\Scripts\activate        # Windows

pip install -e ".[dev]"
```

## Run

For development with auto-reload:

```bash
uvicorn my_api.main:app --reload
```

Or run programmatically (no auto-reload):

```bash
python -m my_api
```

The server listens on port 8000 by default. Override with `PORT`.

Once running:

```bash
# Health check
curl http://localhost:8000/health

# Interactive API docs (Swagger UI)
open http://localhost:8000/docs

# Alternative docs (ReDoc)
open http://localhost:8000/redoc

# List items
curl http://localhost:8000/api/items

# Create
curl -X POST http://localhost:8000/api/items \
     -H 'Content-Type: application/json' \
     -d '{"name":"Widget","quantity":5}'

# Fetch one
curl http://localhost:8000/api/items/1

# Delete
curl -X DELETE http://localhost:8000/api/items/1
```

## Test

```bash
pytest
```

Tests use FastAPI's `TestClient` — no real server needed, runs in-process.

## Configuration

| Env var | Default | Description |
|---|---|---|
| `PORT` | `8000` | Listen port (when using `python -m my_api`) |

## Structure

```
src/my_api/
├── __init__.py
├── __main__.py             # python -m my_api entry point
├── main.py                 # FastAPI app factory, lifespan, exception handlers
├── errors.py               # ApiError class
└── routers/
    ├── __init__.py
    ├── health.py           # /health
    └── items.py            # /api/items CRUD with pydantic validation

tests/
└── test_api.py             # Integration tests using TestClient
```

## Adding a new router

1. Create `src/my_api/routers/<feature>.py` with `router = APIRouter()`.
2. Define your routes on `router`.
3. In `main.py`, add `app.include_router(<feature>.router, prefix="/api/<feature>")`.
4. Raise `ApiError(<status>, <message>)` for client-visible errors;
   the registered exception handler maps them to JSON responses.
5. Add tests to `tests/test_api.py`.

## Production notes

- Replace the in-memory `_items` dict with a real database. The
  router shape (FastAPI dependency-injected sessions, etc.) stays
  compatible — only the storage layer changes.
- For production deployment, prefer `gunicorn` with uvicorn workers,
  or your container platform's native scheduler. Don't run
  `uvicorn --reload` in production.
- CORS, auth, rate limiting are NOT included by default. Add them
  per your deployment context (`fastapi.middleware.cors` is built in).
- Pydantic 2 returns 422 for validation failures by default; the
  shape includes field-level error details. Don't manually re-validate
  what FastAPI already validates from the model.
