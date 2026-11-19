from redis.asyncio import Redis

from .config import settings

_redis: Redis | None = None


def get_redis() -> Redis:
    global _redis
    if _redis is None:
        if settings.redis_url.startswith("fake://"):
            # In-process stand-in for tests and one-replica local runs. It is not shared between processes.
            from fakeredis import FakeAsyncRedis

            _redis = FakeAsyncRedis()
        else:
            _redis = Redis.from_url(settings.redis_url, health_check_interval=30)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
