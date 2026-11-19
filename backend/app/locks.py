"""Spot holds, kept in Redis so every API replica sees the same locks.

A hold is two keys that expire together:
    hold:{spot_id}    -> user id     (who holds this spot)
    holder:{user_id}  -> spot id     (which spot this user holds; one at a time)

Each change runs as a Lua script, which Redis executes atomically. Two drivers tapping the same
spot at the same moment, even on different replicas, cannot both get it.
"""

from redis.asyncio import Redis

from .config import settings

# KEYS: hold:{spot}, holder:{user}   ARGV: user id, ttl ms, spot id
_ACQUIRE = """
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return {0, ''} end
local previous = redis.call('GET', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
if previous and previous ~= ARGV[3] then
  local old = 'hold:' .. previous
  if redis.call('GET', old) == ARGV[1] then redis.call('DEL', old) end
  return {1, previous}
end
return {1, ''}
"""

# KEYS: hold:{spot}, holder:{user}   ARGV: user id, spot id
_RELEASE = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
return 1
"""


def hold_key(spot_id: int) -> str:
    return f"hold:{spot_id}"


def holder_key(user_id: int) -> str:
    return f"holder:{user_id}"


async def acquire(redis: Redis, spot_id: int, user_id: int, seconds: int | None = None) -> tuple[bool, int | None]:
    """Hold a spot for a user. Returns (acquired, the spot id of a hold the user gave up, if any)."""
    ttl_ms = int((seconds or settings.hold_seconds) * 1000)
    ok, previous = await redis.eval(_ACQUIRE, 2, hold_key(spot_id), holder_key(user_id), user_id, ttl_ms, spot_id)
    previous = previous.decode() if isinstance(previous, bytes) else previous
    return bool(int(ok)), int(previous) if previous else None


async def release(redis: Redis, spot_id: int, user_id: int) -> bool:
    released = await redis.eval(_RELEASE, 2, hold_key(spot_id), holder_key(user_id), user_id, spot_id)
    return bool(int(released))


async def holder_of(redis: Redis, spot_id: int) -> int | None:
    value = await redis.get(hold_key(spot_id))
    return int(value) if value else None


async def held_spot(redis: Redis, user_id: int) -> int | None:
    value = await redis.get(holder_key(user_id))
    return int(value) if value else None


async def try_lock(redis: Redis, spot_id: int, user_id: int, seconds: int = 10) -> bool:
    """Short exclusive lock used when the server itself moves a reservation (violation reports)."""
    return bool(await redis.set(hold_key(spot_id), user_id, nx=True, ex=seconds))


async def unlock(redis: Redis, spot_id: int, user_id: int) -> None:
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
                     1, hold_key(spot_id), user_id)
