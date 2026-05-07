"""FastAPI application entry point.

Replace the routes below with your own. The structure:
- Pydantic models in models.py (or this file for small APIs)
- Routes mounted on the FastAPI app
- Lifespan handler for startup/shutdown logic

Run with:
    uvicorn my_api.main:app --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from pydantic import BaseModel


class EchoRequest(BaseModel):
    """Sample request model. Replace with your own Pydantic schemas."""

    message: str
    count: int = 1


class EchoResponse(BaseModel):
    echoed: str
    repetitions: int


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown hook. Runs once at app start and once at stop.

    Use this to open DB pools, warm caches, register cleanup, etc.
    """
    # Startup
    print("Starting up...")
    yield
    # Shutdown
    print("Shutting down...")


app = FastAPI(
    title="my-api",
    version="0.1.0",
    description="A FastAPI service scaffolded by NexusCode.",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check. Standard convention for readiness/liveness probes."""
    return {"status": "ok"}


@app.post("/api/echo", response_model=EchoResponse)
async def echo(req: EchoRequest) -> EchoResponse:
    """Echo the input message N times."""
    return EchoResponse(
        echoed=req.message * req.count,
        repetitions=req.count,
    )
