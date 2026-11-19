import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import locks
from ..db import aware, get_session, utcnow
from ..models import Lot, Reservation, Spot, User, ViolationReport
from ..redis_client import get_redis
from ..schemas import ReservationOut, ReserveIn, ViolationIn, ViolationOut, ViolationResult
from ..security import current_user
from ..spots import complete_expired, distance_m, publish

router = APIRouter(prefix="/api", tags=["reservations"])


def reservation_out(reservation: Reservation, lot_name: str) -> ReservationOut:
    end = aware(reservation.end_at)
    return ReservationOut(
        id=reservation.id, lot_id=reservation.spot.lot_id, lot_name=lot_name, spot=reservation.spot.code,
        plate=reservation.plate, start=aware(reservation.start_at), end=end,
        total=reservation.total_cents / 100, status=reservation.status,
        active=reservation.status == "active" and end > utcnow(), moved_from=reservation.moved_from)


def report_out(report: ViolationReport) -> ViolationOut:
    return ViolationOut(id=report.id, created_at=aware(report.created_at), lot_name=report.lot_name,
                        spot=report.spot_code, offender_plate=report.offender_plate, note=report.note,
                        outcome=report.outcome)


async def _lot_names(session: AsyncSession) -> dict[str, str]:
    return dict((await session.execute(select(Lot.id, Lot.name))).all())


async def _owned(session: AsyncSession, reservation_id: str, user_id: int) -> Reservation:
    reservation = await session.get(Reservation, reservation_id)
    if reservation is None or reservation.user_id != user_id:
        raise HTTPException(404, "Reservation not found.")
    return reservation


@router.get("/reservations", response_model=list[ReservationOut])
async def my_reservations(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    names = await _lot_names(session)
    rows = (await session.scalars(
        select(Reservation).where(Reservation.user_id == user.id).order_by(Reservation.created_at.desc()).limit(50)
    )).all()
    return [reservation_out(reservation, names[reservation.spot.lot_id]) for reservation in rows]


@router.post("/reservations", response_model=ReservationOut, status_code=201)
async def reserve(body: ReserveIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """Turns this driver's hold into a reservation."""
    redis = get_redis()
    if not any(vehicle.plate == body.plate for vehicle in user.vehicles):
        raise HTTPException(400, "Choose one of the vehicles on your account.")
    if user.card is None:
        raise HTTPException(400, "Add a payment method in your profile first.")

    lot = await session.get(Lot, body.lot_id)
    spot = await session.scalar(select(Spot).where(Spot.lot_id == body.lot_id, Spot.code == body.spot.upper()))
    if lot is None or spot is None:
        raise HTTPException(404, "That spot does not exist.")
    if await locks.holder_of(redis, spot.id) != user.id:
        raise HTTPException(409, "Your hold expired. Select the spot again.")

    freed = await complete_expired(session)
    now = utcnow()
    reservation = Reservation(
        id="R" + secrets.token_hex(4).upper(), user_id=user.id, spot_id=spot.id, plate=body.plate,
        start_at=now, end_at=now + timedelta(hours=body.hours),
        total_cents=lot.hourly_rate_cents * body.hours, status="active")
    session.add(reservation)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "That spot was just reserved by someone else. Pick another.")

    await locks.release(redis, spot.id, user.id)
    await publish(session, redis, [spot.id, *freed])
    await session.refresh(reservation, ["spot"])
    return reservation_out(reservation, lot.name)


@router.delete("/reservations/{reservation_id}", response_model=ReservationOut)
async def cancel(reservation_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    reservation = await _owned(session, reservation_id, user.id)
    if reservation.status != "active":
        raise HTTPException(409, "That reservation is no longer active.")
    reservation.status = "cancelled"
    await session.commit()
    await publish(session, get_redis(), [reservation.spot_id])
    return reservation_out(reservation, (await _lot_names(session))[reservation.spot.lot_id])


@router.post("/reservations/{reservation_id}/violations", response_model=ViolationResult, status_code=201)
async def report_violation(reservation_id: str, body: ViolationIn,
                           user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """Someone is parked in this driver's reserved spot.

    Marks the spot as occupied, then moves the reservation to the closest free spot of the same
    kind in the same lot, falling back to a standard spot, then to the nearest other lot with
    space. If nothing is free anywhere, the reservation is cancelled (and would be refunded).
    """
    redis = get_redis()
    user_id = user.id
    reservation = await _owned(session, reservation_id, user_id)
    if reservation.status != "active" or aware(reservation.end_at) <= utcnow():
        raise HTTPException(409, "That reservation is no longer active.")

    freed = await complete_expired(session)
    # Plain values only from here on: a rollback inside the loop expires loaded objects.
    lots = (await session.scalars(select(Lot))).all()
    names = {lot.id: lot.name for lot in lots}
    blocked = reservation.spot
    blocked_id, blocked_code, home_id = blocked.id, blocked.code, blocked.lot_id
    origin = f"{names[home_id]} · Spot {blocked_code}"
    candidates = await _candidates(session, redis, blocked, home_id, lots)

    blocked.occupied = True
    await session.commit()

    moved_to: tuple[int, str, str] | None = None
    for spot_id, lot_id, code in candidates:
        # Lock the candidate in Redis so no one can hold it while the reservation moves there.
        if not await locks.try_lock(redis, spot_id, user_id):
            continue
        try:
            reservation.spot_id = spot_id
            reservation.moved_from = origin
            await session.commit()
            moved_to = (spot_id, lot_id, code)
            break
        except IntegrityError:                  # reserved a moment ago through another replica
            await session.rollback()
            reservation = await _owned(session, reservation_id, user_id)
        finally:
            await locks.unlock(redis, spot_id, user_id)

    if moved_to:
        outcome = "moved"
        summary = f"Moved to {names[moved_to[1]]} · Spot {moved_to[2]}"
    else:
        reservation.status = "cancelled"
        outcome = "refunded"
        summary = "No free spots. Reservation cancelled and refunded."

    report = ViolationReport(user_id=user_id, reservation_id=reservation_id, lot_name=names[home_id],
                             spot_code=blocked_code, offender_plate=body.offender_plate, note=body.note,
                             outcome=summary)
    session.add(report)
    await session.commit()
    await session.refresh(reservation, ["spot"])
    await publish(session, redis, [blocked_id, moved_to[0] if moved_to else None, *freed])
    return ViolationResult(outcome=outcome,
                           reservation=reservation_out(reservation, names[reservation.spot.lot_id]),
                           report=report_out(report))


async def _candidates(session: AsyncSession, redis, blocked: Spot, home_id: str, lots) -> list[tuple[int, str, str]]:
    """Free spots, best first: same lot and kind, same lot standard, then other lots by distance."""
    taken = set((await session.scalars(
        select(Reservation.spot_id).where(Reservation.status == "active", Reservation.end_at > utcnow())
    )).all())
    free = [spot for spot in (await session.scalars(select(Spot).where(Spot.occupied.is_(False)))).all()
            if spot.id not in taken and spot.id != blocked.id]
    if free:
        holds = await redis.mget([locks.hold_key(spot.id) for spot in free])
        free = [spot for spot, holder in zip(free, holds) if not holder]

    def nearness(spot: Spot) -> int:
        return abs(spot.row - blocked.row) * 3 + abs(spot.col - blocked.col)

    home = next(lot for lot in lots if lot.id == home_id)
    kinds = [blocked.type, "standard"] if blocked.type != "standard" else ["standard"]
    ordered: list[Spot] = []
    for kind in kinds:
        ordered += sorted((s for s in free if s.lot_id == home_id and s.type == kind), key=nearness)
    for lot in sorted((lot for lot in lots if lot.id != home_id), key=lambda lot: distance_m(home, lot)):
        ordered += sorted((s for s in free if s.lot_id == lot.id and s.type == "standard"), key=lambda s: (s.row, s.col))
    return [(spot.id, spot.lot_id, spot.code) for spot in ordered[:40]]


@router.get("/violations", response_model=list[ViolationOut])
async def my_reports(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.scalars(
        select(ViolationReport).where(ViolationReport.user_id == user.id)
        .order_by(ViolationReport.created_at.desc()).limit(50)
    )).all()
    return [report_out(report) for report in rows]
