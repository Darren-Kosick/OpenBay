from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import ParkingPermit, PaymentCard, User, Vehicle
from ..schemas import CardIn, PermitIn, UserOut, UserPatch, VehicleIn
from ..security import current_user

router = APIRouter(prefix="/api/me", tags=["account"])


async def _fresh(session: AsyncSession, user: User) -> UserOut:
    await session.refresh(user, ["vehicles", "card", "permit"])
    return UserOut.model_validate(user)


@router.get("", response_model=UserOut)
async def me(user: User = Depends(current_user)):
    return UserOut.model_validate(user)


@router.patch("", response_model=UserOut)
async def update_me(body: UserPatch, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if body.name is not None:
        user.name = body.name
    if body.phone is not None:
        user.phone = body.phone.strip()[:40]
    await session.commit()
    return await _fresh(session, user)


@router.post("/vehicles", response_model=UserOut, status_code=201)
async def add_vehicle(body: VehicleIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if any(vehicle.plate == body.plate for vehicle in user.vehicles):
        raise HTTPException(409, "That plate is already on your account.")
    session.add(Vehicle(user_id=user.id, **body.model_dump()))
    await session.commit()
    return await _fresh(session, user)


@router.delete("/vehicles/{vehicle_id}", response_model=UserOut)
async def remove_vehicle(vehicle_id: int, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    vehicle = await session.get(Vehicle, vehicle_id)
    if vehicle is None or vehicle.user_id != user.id:
        raise HTTPException(404, "Vehicle not found.")
    await session.delete(vehicle)
    await session.commit()
    return await _fresh(session, user)


@router.put("/card", response_model=UserOut)
async def save_card(body: CardIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if user.card:
        for key, value in body.model_dump().items():
            setattr(user.card, key, value)
    else:
        session.add(PaymentCard(user_id=user.id, **body.model_dump()))
    await session.commit()
    return await _fresh(session, user)


@router.delete("/card", response_model=UserOut)
async def remove_card(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if user.card:
        await session.delete(user.card)
        await session.commit()
    return await _fresh(session, user)


@router.put("/permit", response_model=UserOut)
async def save_permit(body: PermitIn, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if user.permit:
        user.permit.kind, user.permit.number = body.kind, body.number
    else:
        session.add(ParkingPermit(user_id=user.id, kind=body.kind, number=body.number))
    await session.commit()
    return await _fresh(session, user)


@router.delete("/permit", response_model=UserOut)
async def remove_permit(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if user.permit:
        await session.delete(user.permit)
        await session.commit()
    return await _fresh(session, user)
