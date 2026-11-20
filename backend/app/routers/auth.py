from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..models import PaymentCard, User, Vehicle
from ..schemas import AuthOut, LoginIn, RegisterIn, UserOut
from ..security import create_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=AuthOut, status_code=201)
async def register(body: RegisterIn, session: AsyncSession = Depends(get_session)):
    if await session.scalar(select(User.id).where(User.email == body.email)):
        raise HTTPException(409, "An account with that email already exists.")
    user = User(name=body.name, email=body.email, phone=body.phone, password_hash=hash_password(body.password))
    if body.vehicle:
        user.vehicles.append(Vehicle(**body.vehicle.model_dump()))
    if body.card:
        user.card = PaymentCard(**body.card.model_dump())
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:                       # same email registered on another replica a moment ago
        raise HTTPException(409, "An account with that email already exists.")
    await session.refresh(user, ["vehicles", "card", "permit"])
    return AuthOut(token=create_token(user.id), user=UserOut.model_validate(user))


@router.post("/login", response_model=AuthOut)
async def login(body: LoginIn, session: AsyncSession = Depends(get_session)):
    user = await session.scalar(select(User).where(User.email == body.email.strip().lower()))
    if not verify_password(body.password, user.password_hash if user else None):
        raise HTTPException(401, "Email or password is incorrect.")
    return AuthOut(token=create_token(user.id), user=UserOut.model_validate(user))
