import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_session, utcnow
from ..models import Spot
from ..redis_client import get_redis
from ..schemas import SensorEvent
from ..spots import publish

router = APIRouter(prefix="/api/sensors", tags=["sensors"])


@router.post("/events", status_code=204)
async def sensor_event(body: SensorEvent, x_sensor_key: str = Header(default=""),
                       session: AsyncSession = Depends(get_session)):
    """A lot sensor reports that a vehicle arrived at or left a spot."""
    if not hmac.compare_digest(x_sensor_key, settings.sensor_key):
        raise HTTPException(403, "Unknown sensor.")
    spot = await session.scalar(select(Spot).where(Spot.lot_id == body.lot_id, Spot.code == body.spot.upper()))
    if spot is None:
        raise HTTPException(404, "That spot does not exist.")
    if spot.occupied != body.occupied:
        spot.occupied = body.occupied
        spot.updated_at = utcnow()
        await session.commit()
        await publish(session, get_redis(), [spot.id])
