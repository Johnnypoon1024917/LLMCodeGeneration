# my-api

A FastAPI service scaffolded by NexusCode.

## Setup

Using uv:

```bash
uv venv
uv pip install -e ".[dev]"
```

Using pip:

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

## Run

```bash
uvicorn my_api.main:app --reload
```

Then:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/echo \
     -H 'Content-Type: application/json' \
     -d '{"message":"hi ","count":3}'
```

Interactive API docs: `http://localhost:8000/docs` (Swagger UI)
or `http://localhost:8000/redoc` (ReDoc).

## Structure

- `src/my_api/main.py` — FastAPI app + routes + Pydantic models.
  Split into `routes/`, `models/`, `services/` modules as the API
  grows. The `lifespan` handler is where DB pools and caches go.

## Tests

```bash
pytest
```

The dev extra installs `httpx` for async test clients —
`from httpx import AsyncClient; from my_api.main import app` lets
you make real requests in tests without spinning up a server.
