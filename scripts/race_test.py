"""Concurrency check for the report: many drivers try to grab the same spot at the same moment.

Registers N drivers, then fires all their hold requests for one spot at once through the load
balancer (so they land on different replicas). Exactly one should win; the rest get 409.
Then every driver who lost tries to reserve without a hold, which must also fail.

    python scripts/race_test.py                       # against http://localhost:8080
    python scripts/race_test.py http://host:8080 100  # another server, 100 drivers
"""

import asyncio
import collections
import sys
import time
import uuid

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
DRIVERS = int(sys.argv[2]) if len(sys.argv) > 2 else 50


async def register(client: httpx.AsyncClient, run: str, i: int) -> dict:
    response = await client.post("/api/auth/register", json={
        "name": f"Racer {i}", "email": f"racer{i}-{run}@openbay.test", "password": "password123",
        "vehicle": {"plate": f"RC{i:04d}", "make": "Test"},
        "card": {"brand": "Visa", "last4": "4242", "expiry": "12/30", "holder": f"Racer {i}"},
    })
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['token']}", "plate": f"RC{i:04d}"}


async def main() -> None:
    run = uuid.uuid4().hex[:6]
    limits = httpx.Limits(max_connections=DRIVERS + 10)
    async with httpx.AsyncClient(base_url=BASE, timeout=30, limits=limits) as client:
        drivers = await asyncio.gather(*(register(client, run, i) for i in range(DRIVERS)))

        spots = (await client.get("/api/lots/L3/spots")).json()
        target = next(s["id"] for s in spots if s["status"] == "available" and s["type"] == "standard")
        print(f"{DRIVERS} drivers racing for spot L3/{target} through {BASE}")

        async def grab(driver: dict):
            headers = {"Authorization": driver["Authorization"]}
            response = await client.post(f"/api/lots/L3/spots/{target}/hold", headers=headers)
            return driver, response.status_code, response.headers.get("X-Served-By", "?")

        start = time.perf_counter()
        results = await asyncio.gather(*(grab(d) for d in drivers))
        elapsed = time.perf_counter() - start

        winners = [d for d, status, _ in results if status == 200]
        by_status = collections.Counter(status for _, status, _ in results)
        by_replica = collections.Counter(replica for _, _, replica in results)
        print(f"  hold results: {dict(by_status)} in {elapsed * 1000:.0f} ms")
        print(f"  requests per replica: {dict(by_replica)}")

        losers = [d for d, status, _ in results if status != 200]
        sneaky = await asyncio.gather(*(client.post(
            "/api/reservations", headers={"Authorization": d["Authorization"]},
            json={"lot_id": "L3", "spot": target, "plate": d["plate"], "hours": 1}) for d in losers))
        sneaky_ok = sum(r.status_code == 201 for r in sneaky)
        print(f"  reservations by drivers without the hold: {sneaky_ok}")

        winner = winners[0] if winners else None
        if winner:
            made = await client.post("/api/reservations", headers={"Authorization": winner["Authorization"]},
                                     json={"lot_id": "L3", "spot": target, "plate": winner["plate"], "hours": 1})
            print(f"  winner's reservation: HTTP {made.status_code}")
            if made.status_code == 201:      # tidy up so the demo lot is not left with test reservations
                await client.delete(f"/api/reservations/{made.json()['id']}",
                                    headers={"Authorization": winner["Authorization"]})

        ok = len(winners) == 1 and sneaky_ok == 0
        print("PASS: exactly one driver got the spot" if ok else "FAIL: the spot was not exclusive")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
