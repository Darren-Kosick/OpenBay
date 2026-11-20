from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import aware, get_session
from ..models import Payment, User
from ..schemas import PaymentOut
from ..security import current_user

router = APIRouter(prefix="/api", tags=["payments"])


@router.get("/payments", response_model=list[PaymentOut])
async def my_payments(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    """The driver's charges, declines and refunds, newest first."""
    rows = (await session.scalars(
        select(Payment).where(Payment.user_id == user.id).order_by(Payment.created_at.desc()).limit(50)
    )).all()
    return [PaymentOut(id=p.id, kind=p.kind, status=p.status, amount=p.amount_cents / 100, card=p.card,
                       description=p.description, message=p.message, reservation_id=p.reservation_id,
                       created_at=aware(p.created_at)) for p in rows]
