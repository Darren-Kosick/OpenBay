"""Works out what each spot looks like right now, from three sources:

    Postgres  - sensor occupancy and active reservations
    Redis     - short holds while a driver confirms
and pushes changes to every replica through Redis pub/sub.
"""

import json
import math

from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import locks
from .config import settings
from .db import utcnow
from .models import Lot, Reservation, Spot


async def complete_expired(session: AsyncSession) -> list[int]:
    """Marks reservations whose end time has passed as completed. Returns the freed spot ids."""
    result = await session.execute(
        update(Reservation)
        .where(Reservation.status == "active", Reservation.end_at <= utcnow())
        .values(status="completed")
        .returning(Reservation.spot_id)
        .execution_options(synchronize_session=False)
    )
    freed = [row[0] for row in result.all()]
    await session.commit()
    return freed


async def raw_states(session: AsyncSession, redis: Redis, spots: list[Spot]) -> list[dict]:
    """Spot states with the owner's user id still attached. Use public() before sending to a client."""
    if not spots:
        return []
    ids = [spot.id for spot in spots]
    rows = await session.execute(
        select(Reservation.spot_id, Reservation.user_id)
        .where(Reservation.spot_id.in_(ids), Reservation.status == "active", Reservation.end_at > utcnow())
    )
    reserved_by = dict(rows.all())

    pipe = redis.pipeline(transaction=False)
    for spot_id in ids:
        pipe.get(locks.hold_key(spot_id))
        pipe.pttl(locks.hold_key(spot_id))
    replies = await pipe.execute()

    states = []
    for index, spot in enumerate(spots):
        holder, ttl = replies[2 * index], replies[2 * index + 1]
        state = {
            "id": spot.code,
            "lot_id": spot.lot_id,
            "row": spot.row,
            "col": spot.col,
            "type": spot.type,
            "occupied": spot.occupied,
            "status": "available",
            "held_ms": None,
            "owner": None,
        }
        if spot.id in reserved_by:
            state["status"], state["owner"] = "reserved", reserved_by[spot.id]
        elif holder:
            state["status"], state["owner"] = "held", int(holder)
            state["held_ms"] = max(int(ttl), 0)
        elif spot.occupied:
            state["status"] = "occupied"
        states.append(state)
    return states


def public(state: dict, user_id: int | None) -> dict:
    """Swaps the owner's id for a simple 'is this mine' flag."""
    out = {key: value for key, value in state.items() if key != "owner"}
    out["mine"] = user_id is not None and state["owner"] == user_id
    return out


async def lot_states(session: AsyncSession, redis: Redis, lot_id: str) -> list[dict]:
    spots = (await session.scalars(select(Spot).where(Spot.lot_id == lot_id).order_by(Spot.row, Spot.col))).all()
    return await raw_states(session, redis, list(spots))


async def publish(session: AsyncSession, redis: Redis, spot_ids: list[int]) -> None:
    """Tells every replica (and through them every open app) that these spots changed."""
    ids = [spot_id for spot_id in dict.fromkeys(spot_ids) if spot_id]
    if not ids:
        return
    spots = (await session.scalars(select(Spot).where(Spot.id.in_(ids)))).all()
    for state in await raw_states(session, redis, list(spots)):
        message = {"type": "spot", "origin": settings.instance, "spot": state}
        await redis.publish(f"lot:{state['lot_id']}", json.dumps(message))


def distance_m(a: Lot, b: Lot) -> float:
    rad = math.radians
    d_lat, d_lng = rad(b.latitude - a.latitude), rad(b.longitude - a.longitude)
    h = math.sin(d_lat / 2) ** 2 + math.cos(rad(a.latitude)) * math.cos(rad(b.latitude)) * math.sin(d_lng / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))
