"""Creates the tables and the parking lots the first time the system starts.

The lots are the daily-parking lots at Ontario Tech University's north Oshawa campus
(2000 Simcoe Street North). Sources:

  - Names, and which lots sell daily parking: the North Campus Parking Map and parking page at
    ontariotechu.ca/campus-services/parking (checked November 2026).
  - Positions: the centre of each lot's outline in OpenStreetMap (OSM ids below). Founders 6 and
    Commencement South have no outline in OSM, so their positions were read off the campus map.
  - Rate: daily parking is $5 an hour on weekdays. The real $20 daily maximum and the evening and
    weekend flat rates are not modelled.

Spots fill each lot's real outline at real size (see layout.py), so every space in the lot can be
booked. They are laid out by rule, not surveyed, so counts are close to, not exactly, the real ones.

Permit lots: Founders 1 and the gated Commencement lot take a parking permit; Founders 3 and
Champions South take an employee permit (which also works in the permit lots). Drivers add their
permit in their profile, and booking in these lots is free because the permit already covers it.
"""

import random

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Base, engine
from .layout import layout
from .models import Lot, Reservation, Spot

RATE_CENTS = 500

DEMO_LOTS = [
    # id, name, latitude, longitude, rate (cents/h), starting occupancy, random seed
    ("F2", "Founders 2", 43.94689, -78.89620, RATE_CENTS, 0.70, 11),          # OSM relation 16307767
    ("F4", "Founders 4", 43.94983, -78.89780, RATE_CENTS, 0.55, 12),          # OSM relation 16362734
    ("F5", "Founders 5", 43.95204, -78.89892, RATE_CENTS, 0.45, 13),          # OSM way 466175717
    ("F6", "Founders 6", 43.95298, -78.89930, RATE_CENTS, 0.35, 14),          # campus map, north of Founders 5
    ("CN", "Commencement North", 43.94243, -78.89538, RATE_CENTS, 0.60, 15),  # OSM way 1206454045
    ("CS", "Commencement South", 43.94140, -78.89395, RATE_CENTS, 0.50, 16),  # campus map, east side of Commencement
    ("BF", "Babcock Field", 43.94051, -78.89361, RATE_CENTS, 0.30, 17),       # OSM way 1206456061
    ("V1", "Visitor Lot 1", 43.94415, -78.89297, RATE_CENTS, 0.50, 18),       # OSM way 227402758
    ("V2", "Visitor Lot 2", 43.94539, -78.89350, RATE_CENTS, 0.50, 19),       # OSM way 878979954
    ("SV", "Simcoe Village", 43.94396, -78.89088, RATE_CENTS, 0.55, 20),      # OSM way 557077744
    ("CHN", "Champions North", 43.94462, -78.89890, RATE_CENTS, 0.60, 21),    # OSM way 271653294
    # Permit lots: parking is included with a campus permit, so booking here is free.
    ("COM", "Commencement", 43.94163, -78.89522, 0, 0.80, 22),               # OSM way 28197291, permit holders
    ("F1", "Founders 1", 43.94525, -78.89520, 0, 0.80, 23),                  # OSM way 227402743, permit holders
    ("F3", "Founders 3", 43.94811, -78.89928, 0, 0.75, 24),                  # OSM relation 3625950, employees
    ("CHS", "Champions South", 43.94354, -78.89844, 0, 0.75, 25),            # OSM way 271653480, employees
]


async def create_schema() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def seed_lots(session: AsyncSession) -> None:
    """Creates the lots and their spots, and brings an older database up to date.

    Runs on every start. New lots and spots are added; an existing lot gets its current name, place,
    rate and size, and its spots their current row, column and kind. Spots that are no longer in the
    layout are removed if nobody ever reserved them. Booked ones are kept for their history but marked
    occupied, so they are never offered again.
    """
    lots = {lot.id: lot for lot in (await session.scalars(select(Lot))).all()}
    for lot_id, name, lat, lng, rate, occupancy, seed in DEMO_LOTS:
        plan = layout(lot_id)
        if plan is None:
            continue
        lot = lots.get(lot_id)
        if lot is None:
            lot = Lot(id=lot_id)
            session.add(lot)
        lot.name, lot.latitude, lot.longitude, lot.hourly_rate_cents = name, lat, lng, rate
        lot.rows, lot.cols = plan.rows, plan.cols

        existing = {spot.code: spot for spot in (await session.scalars(select(Spot).where(Spot.lot_id == lot_id))).all()}
        rng = random.Random(seed)
        for placed in plan.spots:
            occupied = rng.random() < occupancy
            spot = existing.pop(placed.code, None)
            if spot is None:
                session.add(Spot(lot_id=lot_id, code=placed.code, row=placed.row, col=placed.col,
                                 type=placed.kind, occupied=occupied))
            else:
                spot.row, spot.col, spot.type = placed.row, placed.col, placed.kind

        if existing:
            booked = set((await session.scalars(
                select(Reservation.spot_id).where(Reservation.spot_id.in_([spot.id for spot in existing.values()]))
            )).all())
            for spot in existing.values():
                if spot.id not in booked:
                    await session.delete(spot)
                else:
                    spot.occupied = True      # kept for its history, but no longer offered to drivers
    await session.commit()
