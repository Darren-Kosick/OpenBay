"""Creates the tables and the demo lots the first time the system starts.

The lots are placeholders near the Ontario Tech north campus. Replace them with real ones.
"""

import random

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Base, engine
from .models import Lot, Spot

DEMO_LOTS = [
    # id, name, latitude, longitude, rows, cols, rate (cents/h), starting occupancy, seed
    ("L1", "North Lot A", 43.9468, -78.8978, 4, 12, 250, 0.55, 11),
    ("L2", "Library Lot B", 43.9449, -78.8962, 4, 10, 300, 0.65, 22),
    ("L3", "Arena Lot C", 43.9441, -78.8991, 6, 14, 200, 0.40, 33),
    ("L4", "South Lot D", 43.9432, -78.8949, 2, 16, 175, 0.30, 44),
]


async def create_schema() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def seed_lots(session: AsyncSession) -> None:
    existing = set((await session.scalars(select(Lot.id))).all())
    for lot_id, name, lat, lng, rows, cols, rate, occupancy, seed in DEMO_LOTS:
        if lot_id in existing:
            continue
        session.add(Lot(id=lot_id, name=name, latitude=lat, longitude=lng, rows=rows, cols=cols, hourly_rate_cents=rate))
        rng = random.Random(seed)
        for row in range(rows):
            for col in range(cols):
                kind = "standard"
                if row == 0 and col < 2:
                    kind = "accessible"
                elif row == 0 and col >= cols - 2:
                    kind = "ev"
                session.add(Spot(lot_id=lot_id, code=f"{chr(65 + row)}{col + 1}", row=row, col=col,
                                 type=kind, occupied=rng.random() < occupancy))
    await session.commit()
