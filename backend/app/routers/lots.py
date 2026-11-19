from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import locks
from ..db import get_session, utcnow
from ..models import Lot, Reservation, Spot, User
from ..redis_client import get_redis
from ..schemas import LotOut
from ..security import current_user, optional_user
from ..spots import lot_states, public, publish, raw_states

router = APIRouter(prefix="/api/lots", tags=["lots"])


async def _spot(session: AsyncSession, lot_id: str, code: str) -> Spot:
    spot = await session.scalar(select(Spot).where(Spot.lot_id == lot_id, Spot.code == code.upper()))
    if spot is None:
        raise HTTPException(404, "That spot does not exist.")
    return spot


@router.get("", response_model=list[LotOut])
async def list_lots(session: AsyncSession = Depends(get_session)):
    redis = get_redis()
    lots = (await session.scalars(select(Lot).order_by(Lot.id))).all()
    out = []
    for lot in lots:
        states = await lot_states(session, redis, lot.id)
        out.append(LotOut(id=lot.id, name=lot.name, latitude=lot.latitude, longitude=lot.longitude,
                          rows=lot.rows, cols=lot.cols, hourly_rate=lot.hourly_rate_cents / 100,
                          total=len(states), free=sum(state["status"] == "available" for state in states)))
    return out


@router.get("/{lot_id}/spots")
async def list_spots(lot_id: str, user: User | None = Depends(optional_user), session: AsyncSession = Depends(get_session)):
    if await session.get(Lot, lot_id) is None:
        raise HTTPException(404, "That lot does not exist.")
    states = await lot_states(session, get_redis(), lot_id)
    return [public(state, user.id if user else None) for state in states]


@router.post("/{lot_id}/spots/{code}/hold")
async def hold(lot_id: str, code: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """Locks a spot for this driver for HOLD_SECONDS while they confirm. 409 if anyone else has it."""
    redis = get_redis()
    spot = await _spot(session, lot_id, code)
    reserved = await session.scalar(
        select(Reservation.id).where(Reservation.spot_id == spot.id, Reservation.status == "active",
                                     Reservation.end_at > utcnow()))
    if spot.occupied or reserved:
        raise HTTPException(409, "That spot was just taken. Pick another.")

    acquired, previous = await locks.acquire(redis, spot.id, user.id)
    if not acquired:
        raise HTTPException(409, "Someone else is holding that spot. Pick another.")

    await publish(session, redis, [spot.id, previous])
    state = (await raw_states(session, redis, [spot]))[0]
    return public(state, user.id)


@router.delete("/{lot_id}/spots/{code}/hold", status_code=204)
async def release(lot_id: str, code: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    redis = get_redis()
    spot = await _spot(session, lot_id, code)
    if await locks.release(redis, spot.id, user.id):
        await publish(session, redis, [spot.id])
