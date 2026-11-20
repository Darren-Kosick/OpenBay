from collections.abc import AsyncIterator
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)

if engine.dialect.name == "sqlite":
    # SQLite ignores foreign keys unless asked. Turn them on so local runs and tests behave like Postgres.
    @event.listens_for(engine.sync_engine, "connect")
    def _foreign_keys_on(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: datetime) -> datetime:
    """SQLite hands datetimes back without a timezone. Everything is stored in UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
