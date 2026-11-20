"""OpenBay API.

Run several copies of this behind a load balancer. They share nothing in memory:
Postgres holds the records, Redis holds spot holds and carries live updates between replicas.
"""

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import SessionLocal, engine
from .events import hub
from .redis_client import close_redis, get_redis
from .routers import auth, live, lots, me, payments, reservations, sensors
from .seed import create_schema, seed_lots
from .spots import complete_expired, publish

log = logging.getLogger("openbay")


async def _sweep_forever() -> None:
    """Marks finished reservations as completed and tells open apps those spots are free again."""
    while True:
        await asyncio.sleep(settings.sweep_seconds)
        try:
            async with SessionLocal() as session:
                freed = await complete_expired(session)
                await publish(session, get_redis(), freed)
        except Exception:
            log.exception("Reservation sweep failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = get_redis()
    # Every replica starts at once; a Redis lock makes sure only one creates tables and seeds data.
    async with redis.lock("openbay:startup", timeout=60, blocking_timeout=90):
        await create_schema()
        async with SessionLocal() as session:
            await seed_lots(session)
    hub.start(redis)
    sweeper = asyncio.create_task(_sweep_forever())
    log.info("OpenBay API %s ready", settings.instance)
    yield
    sweeper.cancel()
    with suppress(asyncio.CancelledError):
        await sweeper
    await hub.stop()
    await close_redis()
    await engine.dispose()


app = FastAPI(title="OpenBay API", version="1.0", lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def served_by(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Served-By"] = settings.instance
    return response


@app.exception_handler(RequestValidationError)
async def readable_validation_errors(request: Request, exc: RequestValidationError):
    """Returns the first problem as one sentence the app can show, e.g. 'Enter the vehicle make.'"""
    first = exc.errors()[0] if exc.errors() else {}
    message = str(first.get("msg", "Check the form and try again."))
    message = message.removeprefix("Value error, ")
    if first.get("type") == "missing":
        message = f"Missing {first.get('loc', ['', 'field'])[-1]}."
    return JSONResponse({"detail": message}, status_code=422)


@app.get("/api/health", tags=["system"])
async def health():
    await get_redis().ping()
    return {"ok": True, "instance": settings.instance}


for module in (auth, me, lots, reservations, payments, sensors, live):
    app.include_router(module.router)

# Lets one replica serve the web app too, for running without nginx (see README).
if settings.frontend_dir and Path(settings.frontend_dir).is_dir():
    app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
