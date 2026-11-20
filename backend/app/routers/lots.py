from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import layout, locks
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
                          rows=lot.rows, cols=lot.cols, hourly_rate=lot.hourly_rate_cents / 100, access=layout.access(lot.id),
                          total=len(states), free=sum(state["status"] == "available" for state in states)))
    return out


@router.get("/map")
async def campus_map():
    """Every lot's outline (bookable or not) and the campus landmarks, for the 3D map."""
    data = layout.campus()
    # Every lot's bays (bookable or not) as [lng, lat, angle], so the map can paint them all.
    bays = {lot_id: [[s.lng, s.lat, s.angle] for s in plan.spots] for lot_id, plan in layout.all_layouts().items() if plan}
    return {"lots": data["lots"], "landmarks": data["landmarks"], "bays": bays,
            "islands": data.get("islands", []), "buildings": data.get("buildings", []),
            "spot_width": layout.SPOT_W, "spot_depth": layout.SPOT_D}


@router.get("/parked")
async def parked(session: AsyncSession = Depends(get_session)):
    """Which spots have a car in them, per lot: a string of 0s and 1s in the same order as the bays
    in GET /api/lots/map. Lets the map draw real parked cars in every lot cheaply."""
    rows = (await session.execute(select(Spot.lot_id, Spot.code).where(Spot.occupied.is_(True)))).all()
    taken: dict[str, set[str]] = {}
    for lot_id, code in rows:
        taken.setdefault(lot_id, set()).add(code)
    return {lot_id: "".join("1" if s.code in taken.get(lot_id, ()) else "0" for s in plan.spots)
            for lot_id, plan in layout.all_layouts().items() if plan}


@router.get("/{lot_id}/map")
async def lot_map(lot_id: str):
    """Where each spot sits on the ground: its centre and which way its row runs, plus the lot's outline."""
    plan = layout.layout(lot_id)
    if plan is None:
        raise HTTPException(404, "That lot does not exist.")
    return {"lot_id": lot_id, "angle": plan.angle, "spot_width": layout.SPOT_W, "spot_depth": layout.SPOT_D,
            "outline": layout.outline(lot_id)["geometry"],
            "spots": [{"id": s.code, "lng": s.lng, "lat": s.lat, "angle": s.angle, "row": s.row, "col": s.col} for s in plan.spots]}


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
    if not layout.may_use(lot_id, user.permit.kind if user.permit else None):
        raise HTTPException(403, layout.refusal(lot_id))
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
