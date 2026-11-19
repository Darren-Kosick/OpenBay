import asyncio

import pytest
from sqlalchemy.exc import IntegrityError

from app import locks
from app.db import SessionLocal, utcnow
from app.models import Reservation, Spot
from app.redis_client import get_redis
from conftest import free_spot, spot

SENSOR = {"X-Sensor-Key": "test-sensor-key"}


def hold(client, headers, lot, code):
    return client.post(f"/api/lots/{lot}/spots/{code}/hold", headers=headers)


def reserve(client, headers, user, lot, code, hours=2):
    plate = user["vehicles"][0]["plate"]
    return client.post("/api/reservations", headers=headers,
                       json={"lot_id": lot, "spot": code, "plate": plate, "hours": hours})


# Accounts

def test_register_login_and_profile(client, driver):
    headers, user = driver()
    assert user["vehicles"][0]["make"] == "Honda"
    assert user["card"]["last4"] == "4242"

    again = client.post("/api/auth/register", json={"name": "X", "email": user["email"], "password": "password123"})
    assert again.status_code == 409

    assert client.post("/api/auth/login", json={"email": user["email"], "password": "wrong-password"}).status_code == 401
    login = client.post("/api/auth/login", json={"email": user["email"].upper(), "password": "password123"})
    assert login.status_code == 200

    assert client.get("/api/me").status_code == 401
    patched = client.patch("/api/me", headers=headers, json={"name": "New Name"})
    assert patched.json()["name"] == "New Name"


def test_validation_messages_are_readable(client):
    response = client.post("/api/auth/register", json={
        "name": "A", "email": "a@b.co", "password": "password123",
        "vehicle": {"plate": "!", "make": "Honda"}})
    assert response.status_code == 422
    assert response.json()["detail"] == "Enter a licence plate of 2 to 8 letters and numbers."

    short = client.post("/api/auth/register", json={"name": "A", "email": "a@b.co", "password": "short"})
    assert short.json()["detail"] == "Use a password of at least 8 characters."


def test_vehicles_and_card(client, driver):
    headers, user = driver()
    added = client.post("/api/me/vehicles", headers=headers, json={"plate": "ab 12 cd", "make": "Mazda"})
    assert added.status_code == 201
    assert [v["plate"] for v in added.json()["vehicles"]][-1] == "AB12CD"
    duplicate = client.post("/api/me/vehicles", headers=headers, json={"plate": "AB12CD", "make": "Mazda"})
    assert duplicate.status_code == 409

    removed = client.delete(f"/api/me/vehicles/{added.json()['vehicles'][-1]['id']}", headers=headers)
    assert len(removed.json()["vehicles"]) == 1

    assert client.delete("/api/me/card", headers=headers).json()["card"] is None
    expired = client.put("/api/me/card", headers=headers, json={**user["card"], "expiry": "01/20"})
    assert expired.json()["detail"] == "That card has expired."


# Lots, holds and reservations

def test_lots_are_seeded(client):
    lots = client.get("/api/lots").json()
    assert [lot["id"] for lot in lots] == ["L1", "L2", "L3", "L4"]
    assert all(0 < lot["free"] <= lot["total"] for lot in lots)


def test_only_one_driver_can_hold_a_spot(client, driver):
    (a, user_a), (b, _) = driver(), driver()
    code = free_spot(client, "L1")

    first = hold(client, a, "L1", code)
    assert first.status_code == 200
    assert first.json()["mine"] and first.json()["status"] == "held" and first.json()["held_ms"] > 0

    assert hold(client, b, "L1", code).status_code == 409
    assert spot(client, "L1", code, b)["mine"] is False
    assert spot(client, "L1", code, a)["mine"] is True


def test_reserve_turns_the_hold_into_a_reservation(client, driver):
    (a, user_a), (b, _) = driver(), driver()
    code = free_spot(client, "L1")

    assert reserve(client, a, user_a, "L1", code).status_code == 409      # no hold yet
    hold(client, a, "L1", code)
    made = reserve(client, a, user_a, "L1", code, hours=3)
    assert made.status_code == 201, made.text
    assert made.json()["total"] == pytest.approx(7.50) and made.json()["active"]

    assert spot(client, "L1", code, a)["status"] == "reserved"
    assert hold(client, b, "L1", code).status_code == 409
    mine = client.get("/api/reservations", headers=a).json()
    assert mine[0]["spot"] == code


def test_reserve_needs_card_and_own_vehicle(client, driver):
    headers, user = driver(with_card=False)
    code = free_spot(client, "L4")
    hold(client, headers, "L4", code)
    assert reserve(client, headers, user, "L4", code).json()["detail"].startswith("Add a payment method")

    other_headers, other = driver()
    hold(client, other_headers, "L4", code)
    wrong_plate = client.post("/api/reservations", headers=other_headers,
                              json={"lot_id": "L4", "spot": code, "plate": "NOTMINE", "hours": 1})
    assert wrong_plate.status_code in (400, 409)


def test_expired_hold_cannot_be_reserved(client, driver):
    headers, user = driver()
    code = free_spot(client, "L2")
    hold(client, headers, "L2", code)
    redis = get_redis()

    async def expire():
        async with SessionLocal() as session:
            from sqlalchemy import select
            spot_id = await session.scalar(select(Spot.id).where(Spot.lot_id == "L2", Spot.code == code))
        await redis.delete(locks.hold_key(spot_id))       # what Redis does when the TTL runs out

    client.portal.call(expire)
    assert reserve(client, headers, user, "L2", code).json()["detail"] == "Your hold expired. Select the spot again."
    assert spot(client, "L2", code)["status"] == "available"


def test_holding_a_second_spot_releases_the_first(client, driver):
    headers, _ = driver()
    first = free_spot(client, "L3")
    second = free_spot(client, "L3", exclude=(first,))
    hold(client, headers, "L3", first)
    hold(client, headers, "L3", second)
    assert spot(client, "L3", first)["status"] == "available"
    assert spot(client, "L3", second)["status"] == "held"

    assert client.delete(f"/api/lots/L3/spots/{second}/hold", headers=headers).status_code == 204
    assert spot(client, "L3", second)["status"] == "available"


def test_cancel_frees_the_spot(client, driver):
    headers, user = driver()
    code = free_spot(client, "L3")
    hold(client, headers, "L3", code)
    reservation = reserve(client, headers, user, "L3", code).json()
    cancelled = client.delete(f"/api/reservations/{reservation['id']}", headers=headers)
    assert cancelled.json()["status"] == "cancelled"
    assert spot(client, "L3", code)["status"] == "available"


def test_database_refuses_double_booking(client, driver):
    """The backstop under the Redis lock: a second active reservation on one spot cannot be saved."""
    headers, user = driver()
    code = free_spot(client, "L3")
    hold(client, headers, "L3", code)
    original = reserve(client, headers, user, "L3", code).json()

    async def sneak_in():
        async with SessionLocal() as session:
            first = await session.get(Reservation, original["id"])
            now = utcnow()
            session.add(Reservation(id="RDUP0001", user_id=first.user_id, spot_id=first.spot_id, plate="X",
                                    start_at=now, end_at=now, total_cents=0, status="active"))
            await session.commit()

    with pytest.raises(IntegrityError):
        client.portal.call(sneak_in)


# Violations

def test_violation_moves_the_driver_to_a_nearby_spot(client, driver):
    headers, user = driver()
    code = free_spot(client, "L3")
    hold(client, headers, "L3", code)
    reservation = reserve(client, headers, user, "L3", code).json()

    result = client.post(f"/api/reservations/{reservation['id']}/violations", headers=headers,
                         json={"offender_plate": "bad 123", "note": "Blue van"})
    assert result.status_code == 201, result.text
    body = result.json()
    assert body["outcome"] == "moved"
    moved = body["reservation"]
    assert moved["lot_id"] == "L3" and moved["spot"] != code and moved["moved_from"].endswith(code)
    assert moved["end"] == reservation["end"] and moved["total"] == reservation["total"]
    assert body["report"]["offender_plate"] == "BAD123"

    assert spot(client, "L3", code)["status"] == "occupied"
    assert spot(client, "L3", moved["spot"], headers)["mine"] is True
    assert client.get("/api/violations", headers=headers).json()[0]["spot"] == code


def test_violation_in_a_full_lot_moves_to_the_nearest_other_lot(client, driver):
    headers, user = driver()
    code = free_spot(client, "L4")
    hold(client, headers, "L4", code)
    reservation = reserve(client, headers, user, "L4", code).json()

    for other in client.get("/api/lots/L4/spots").json():          # every other spot in L4 fills up
        if other["status"] == "available":
            client.post("/api/sensors/events", headers=SENSOR, json={"lot_id": "L4", "spot": other["id"], "occupied": True})

    body = client.post(f"/api/reservations/{reservation['id']}/violations", headers=headers, json={}).json()
    assert body["outcome"] == "moved"
    assert body["reservation"]["lot_id"] != "L4"


# Sensors and live updates

def test_sensor_events_need_the_key(client):
    code = free_spot(client, "L1")
    event = {"lot_id": "L1", "spot": code, "occupied": True}
    assert client.post("/api/sensors/events", json=event).status_code == 403
    assert client.post("/api/sensors/events", headers=SENSOR, json=event).status_code == 204
    assert spot(client, "L1", code)["status"] == "occupied"
    client.post("/api/sensors/events", headers=SENSOR, json={**event, "occupied": False})
    assert spot(client, "L1", code)["status"] == "available"


def test_live_updates_reach_other_drivers(client, driver):
    (a, _), (b, _) = driver(), driver()
    token_b = b["Authorization"].split()[1]
    code = free_spot(client, "L2")

    with client.websocket_connect(f"/ws/lots/L2?token={token_b}") as socket:
        assert socket.receive_json()["type"] == "hello"
        hold(client, a, "L2", code)
        message = socket.receive_json()
        assert message["type"] == "spot" and message["origin"] == "test-1"
        assert message["spot"]["id"] == code
        assert message["spot"]["status"] == "held"
        assert message["spot"]["mine"] is False
        assert "owner" not in message["spot"]
