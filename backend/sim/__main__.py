"""Stands in for the real world during a demo.

    Sensors      - cars arrive at and leave spots (POST /api/sensors/events)
    Other drivers - a few bot accounts hold, reserve and cancel spots through the normal API

Everything goes through the load balancer, so its requests are spread across the replicas.

    python -m sim                 (API_URL defaults to http://localhost:8080)
"""

import asyncio
import os
import random

import httpx

API_URL = os.getenv("API_URL", "http://localhost:8080")
SENSOR_KEY = os.getenv("SENSOR_KEY", "dev-sensor-key")
INTERVAL = float(os.getenv("SIM_INTERVAL", "2"))
BOTS = int(os.getenv("SIM_BOTS", "6"))
BOT_PASSWORD = os.getenv("SIM_BOT_PASSWORD", "bot-password-123")
TARGET_RESERVED = float(os.getenv("SIM_TARGET_RESERVED", "0.2"))   # share of each lot kept reserved by bots

PLATES = ["BXRT201", "CKLM554", "DAPZ818", "AJTW330", "CNVE712", "BMQS946", "DLRA105", "CFHX467"]


async def wait_for_api(client: httpx.AsyncClient) -> None:
    while True:
        try:
            if (await client.get("/api/health")).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        print("Waiting for the API…", flush=True)
        await asyncio.sleep(2)


async def bot_token(client: httpx.AsyncClient, index: int) -> str:
    email = f"bot{index}@openbay.test"
    response = await client.post("/api/auth/login", json={"email": email, "password": BOT_PASSWORD})
    if response.status_code != 200:
        response = await client.post("/api/auth/register", json={
            "name": f"Demo Driver {index}", "email": email, "password": BOT_PASSWORD,
            "vehicle": {"plate": PLATES[index % len(PLATES)], "province": "ON", "make": "Toyota", "model": "Corolla"},
            "card": {"brand": "Visa", "last4": "4242", "expiry": "12/30", "holder": f"Demo Driver {index}"},
        })
        response.raise_for_status()
    return response.json()["token"]


async def sensor_flip(client: httpx.AsyncClient, lot_id: str, spots: list[dict]) -> None:
    # Cars come and go in spots that nobody has reserved or is holding.
    candidates = [spot for spot in spots if spot["status"] in ("available", "occupied")]
    if not candidates:
        return
    spot = random.choice(candidates)
    await client.post("/api/sensors/events", headers={"X-Sensor-Key": SENSOR_KEY},
                      json={"lot_id": lot_id, "spot": spot["id"], "occupied": not spot["occupied"]})


async def bot_reserve(client: httpx.AsyncClient, token: str, plate: str, lot_id: str, spots: list[dict]) -> None:
    free = [spot for spot in spots if spot["status"] == "available" and spot["type"] == "standard"]
    if not free:
        return
    spot = random.choice(free)
    auth = {"Authorization": f"Bearer {token}"}
    held = await client.post(f"/api/lots/{lot_id}/spots/{spot['id']}/hold", headers=auth)
    if held.status_code != 200:
        return
    await asyncio.sleep(random.uniform(0.5, 3))          # a person reading the screen before confirming
    await client.post("/api/reservations", headers=auth,
                      json={"lot_id": lot_id, "spot": spot["id"], "plate": plate, "hours": random.randint(1, 3)})


async def bot_cancel(client: httpx.AsyncClient, token: str) -> None:
    auth = {"Authorization": f"Bearer {token}"}
    mine = [r for r in (await client.get("/api/reservations", headers=auth)).json() if r["active"]]
    if mine:
        await client.delete(f"/api/reservations/{random.choice(mine)['id']}", headers=auth)


async def main() -> None:
    async with httpx.AsyncClient(base_url=API_URL, timeout=15) as client:
        await wait_for_api(client)
        bots = [(await bot_token(client, i), PLATES[i % len(PLATES)]) for i in range(BOTS)]
        print(f"Simulator running against {API_URL} with {BOTS} demo drivers", flush=True)
        while True:
            try:
                lots = (await client.get("/api/lots")).json()
                lot = random.choice(lots)
                spots = (await client.get(f"/api/lots/{lot['id']}/spots")).json()
                reserved = sum(spot["status"] in ("reserved", "held") for spot in spots) / max(len(spots), 1)
                token, plate = random.choice(bots)
                roll = random.random()
                if roll < 0.6:
                    await sensor_flip(client, lot["id"], spots)
                elif reserved < TARGET_RESERVED:
                    asyncio.create_task(bot_reserve(client, token, plate, lot["id"], spots))
                elif roll > 0.9:
                    await bot_cancel(client, token)
            except (httpx.HTTPError, ValueError) as error:
                print(f"Simulator: {error}", flush=True)
            await asyncio.sleep(INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())
