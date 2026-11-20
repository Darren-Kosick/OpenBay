import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import layout, locks, payments
from ..db import aware, get_session, utcnow
from ..models import Lot, Payment, Reservation, Spot, User, ViolationReport
from ..redis_client import get_redis
from ..schemas import ReservationOut, ReserveIn, ViolationIn, ViolationOut, ViolationResult
from ..security import current_user
from ..spots import complete_expired, distance_m, publish

router = APIRouter(prefix="/api", tags=["reservations"])


def card_label(card) -> str:
    return f"{card.brand} ···· {card.last4}"


def reservation_out(reservation: Reservation, lot: Lot, paid: list[Payment] = ()) -> ReservationOut:
    end = aware(reservation.end_at)
    active = reservation.status == "active" and end > utcnow()
    charge = next((p for p in paid if p.kind == "charge"), None)
    refunded = sum(p.amount_cents for p in paid if p.kind == "refund")
    return ReservationOut(
        id=reservation.id, lot_id=reservation.spot.lot_id, lot_name=lot.name, spot=reservation.spot.code,
        plate=reservation.plate, start=aware(reservation.start_at), end=end,
        total=reservation.total_cents / 100, status=reservation.status,
        active=active, moved_from=reservation.moved_from,
        card=charge.card if charge else None, refunded=refunded / 100,
        refundable=payments.refundable_cents(reservation, lot.hourly_rate_cents) / 100 if active else 0)


def report_out(report: ViolationReport) -> ViolationOut:
    return ViolationOut(id=report.id, created_at=aware(report.created_at), lot_name=report.lot_name,
                        spot=report.spot_code, offender_plate=report.offender_plate, note=report.note,
                        outcome=report.outcome)


async def _lots(session: AsyncSession) -> dict[str, Lot]:
    return {lot.id: lot for lot in (await session.scalars(select(Lot))).all()}


async def _payments(session: AsyncSession, reservation_ids: list[str]) -> dict[str, list[Payment]]:
    found: dict[str, list[Payment]] = {}
    if reservation_ids:
        rows = await session.scalars(select(Payment).where(
            Payment.reservation_id.in_(reservation_ids), Payment.status == "succeeded"))
        for payment in rows:
            found.setdefault(payment.reservation_id, []).append(payment)
    return found


async def _out(session: AsyncSession, reservation: Reservation) -> ReservationOut:
    await session.refresh(reservation, ["spot"])
    lots = await _lots(session)
    paid = (await _payments(session, [reservation.id])).get(reservation.id, [])
    return reservation_out(reservation, lots[reservation.spot.lot_id], paid)


async def _refund(session: AsyncSession, reservation: Reservation, user_id: int, amount_cents: int, why: str) -> None:
    """Sends a refund to the card that paid for this reservation and records it (the caller commits)."""
    charge = await session.scalar(select(Payment).where(
        Payment.reservation_id == reservation.id, Payment.kind == "charge", Payment.status == "succeeded"))
    if charge is None or amount_cents <= 0:
        return
    result = await payments.refund(charge.id, amount_cents)
    session.add(Payment(id=result.reference, user_id=user_id, reservation_id=reservation.id, kind="refund",
                        status="succeeded", amount_cents=amount_cents, card=charge.card,
                        description=f"Refund · {why}"))


async def _owned(session: AsyncSession, reservation_id: str, user_id: int) -> Reservation:
    reservation = await session.get(Reservation, reservation_id)
    if reservation is None or reservation.user_id != user_id:
        raise HTTPException(404, "Reservation not found.")
    return reservation


@router.get("/reservations", response_model=list[ReservationOut])
async def my_reservations(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    lots = await _lots(session)
    rows = (await session.scalars(
        select(Reservation).where(Reservation.user_id == user.id).order_by(Reservation.created_at.desc()).limit(50)
    )).all()
    paid = await _payments(session, [reservation.id for reservation in rows])
    return [reservation_out(r, lots[r.spot.lot_id], paid.get(r.id, [])) for r in rows]


@router.post("/reservations", response_model=ReservationOut, status_code=201)
async def reserve(body: ReserveIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """Charges the driver's card and turns their hold into a reservation."""
    redis = get_redis()
    user_id = user.id
    permit_kind = user.permit.kind if user.permit else None
    if not any(vehicle.plate == body.plate for vehicle in user.vehicles):
        raise HTTPException(400, "Choose one of the vehicles on your account.")
    if not layout.may_use(body.lot_id, permit_kind):
        raise HTTPException(403, layout.refusal(body.lot_id))

    if body.payment_key:                     # this exact attempt already went through: answer it again
        earlier = await _paid_with(session, body.payment_key, user_id)
        if earlier:
            return await _out(session, earlier)

    lot = await session.get(Lot, body.lot_id)
    spot = await session.scalar(select(Spot).where(Spot.lot_id == body.lot_id, Spot.code == body.spot.upper()))
    if lot is None or spot is None:
        raise HTTPException(404, "That spot does not exist.")
    if await locks.holder_of(redis, spot.id) != user_id:
        raise HTTPException(409, "Your hold expired. Select the spot again.")

    total = lot.hourly_rate_cents * body.hours
    if total and user.card is None:
        raise HTTPException(400, "Add a payment method in your profile first.")
    description = f"{lot.name} · Spot {spot.code} · {body.hours} h"
    if total == 0:
        # Permit lots: the permit already covers parking, so there is nothing to charge.
        return await _book_free(session, redis, user_id, body, spot, lot)
    card = card_label(user.card)
    result = await payments.charge(user.card, total)
    if not result.approved:
        session.add(Payment(id=result.reference, user_id=user_id, kind="charge", status="declined",
                            amount_cents=total, card=card, description=description, message=result.message))
        await session.commit()
        raise HTTPException(402, result.message)        # the hold stays, so the driver can change card and retry

    freed = await complete_expired(session)
    now = utcnow()
    reservation = Reservation(
        id="R" + secrets.token_hex(4).upper(), user_id=user_id, spot_id=spot.id, plate=body.plate,
        start_at=now, end_at=now + timedelta(hours=body.hours), total_cents=total, status="active")
    try:
        # One transaction: the booking and its payment are saved together, or neither is.
        # The reservation is written first because the payment row points at it.
        session.add(reservation)
        await session.flush()
        session.add(Payment(id=result.reference, user_id=user_id, reservation_id=reservation.id, kind="charge",
                            status="succeeded", amount_cents=total, card=card, description=description,
                            idempotency_key=body.payment_key))
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # The card was charged but the booking lost a race. Give the money straight back.
        back = await payments.refund(result.reference, total)
        session.add_all([
            Payment(id=result.reference, user_id=user_id, kind="charge", status="succeeded",
                    amount_cents=total, card=card, description=description),
            Payment(id=back.reference, user_id=user_id, kind="refund", status="succeeded",
                    amount_cents=total, card=card, description="Refund · booking did not go through"),
        ])
        await session.commit()
        if body.payment_key and (earlier := await _paid_with(session, body.payment_key, user_id)):
            return await _out(session, earlier)       # a duplicate of an attempt that did go through
        raise HTTPException(409, "That spot was just reserved by someone else. You have not been charged.")

    await locks.release(redis, spot.id, user_id)
    await publish(session, redis, [spot.id, *freed])
    return await _out(session, reservation)


async def _book_free(session: AsyncSession, redis, user_id: int, body: ReserveIn, spot: Spot, lot: Lot) -> ReservationOut:
    freed = await complete_expired(session)
    now = utcnow()
    reservation = Reservation(
        id="R" + secrets.token_hex(4).upper(), user_id=user_id, spot_id=spot.id, plate=body.plate,
        start_at=now, end_at=now + timedelta(hours=body.hours), total_cents=0, status="active")
    session.add(reservation)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "That spot was just reserved by someone else. Pick another.")
    await locks.release(redis, spot.id, user_id)
    await publish(session, redis, [spot.id, *freed])
    return await _out(session, reservation)


async def _paid_with(session: AsyncSession, key: str, user_id: int) -> Reservation | None:
    payment = await session.scalar(select(Payment).where(Payment.idempotency_key == key, Payment.user_id == user_id))
    return await session.get(Reservation, payment.reservation_id) if payment and payment.reservation_id else None


@router.delete("/reservations/{reservation_id}", response_model=ReservationOut)
async def cancel(reservation_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    reservation = await _owned(session, reservation_id, user.id)
    if reservation.status != "active":
        raise HTTPException(409, "That reservation is no longer active.")
    lot = await session.get(Lot, reservation.spot.lot_id)
    amount = payments.refundable_cents(reservation, lot.hourly_rate_cents)
    reservation.status = "cancelled"
    await _refund(session, reservation, user.id, amount, f"cancelled {lot.name} · Spot {reservation.spot.code}")
    await session.commit()
    await publish(session, get_redis(), [reservation.spot_id])
    return await _out(session, reservation)


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
    permit_kind = user.permit.kind if user.permit else None
    candidates = await _candidates(session, redis, blocked, home_id,
                                   [lot for lot in lots if lot.id == home_id or layout.may_use(lot.id, permit_kind)])

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
        await _refund(session, reservation, user_id, reservation.total_cents, f"no free spot after report at {origin}")
        outcome = "refunded"
        summary = "No free spots. Reservation cancelled and refunded."

    report = ViolationReport(user_id=user_id, reservation_id=reservation_id, lot_name=names[home_id],
                             spot_code=blocked_code, offender_plate=body.offender_plate, note=body.note,
                             outcome=summary)
    session.add(report)
    await session.commit()
    await publish(session, redis, [blocked_id, moved_to[0] if moved_to else None, *freed])
    return ViolationResult(outcome=outcome, reservation=await _out(session, reservation), report=report_out(report))


async def _candidates(session: AsyncSession, redis, blocked: Spot, home_id: str, lots) -> list[tuple[int, str, str]]:
    """Free spots, best first: same lot and kind, same lot standard, then other lots by distance."""
    taken = set((await session.scalars(
        select(Reservation.spot_id).where(Reservation.status == "active", Reservation.end_at > utcnow())
    )).all())
    allowed = {lot.id for lot in lots}            # only lots this driver may use
    free = [spot for spot in (await session.scalars(select(Spot).where(Spot.occupied.is_(False)))).all()
            if spot.id not in taken and spot.id != blocked.id and spot.lot_id in allowed]
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
