"""The pretend card processor: charges, declines, refunds, and never charging twice."""

from datetime import timedelta

import pytest

from app.db import SessionLocal, utcnow
from app.models import Reservation
from app.payments import refundable_cents
from conftest import CARD, free_spot, spot
from test_api import hold, reserve


def payments(client, headers):
    return client.get("/api/payments", headers=headers).json()


def test_reserving_charges_the_card(client, driver):
    headers, user = driver()
    code = free_spot(client, "F4")
    hold(client, headers, "F4", code)
    made = reserve(client, headers, user, "F4", code, hours=2).json()
    assert made["card"] == "Visa ···· 4242"
    assert made["refundable"] == pytest.approx(10.00)     # still inside the free-cancellation window

    [charge] = payments(client, headers)
    assert charge["kind"] == "charge" and charge["status"] == "succeeded"
    assert charge["amount"] == pytest.approx(10.00) and charge["reservation_id"] == made["id"]


def test_declined_card_keeps_the_hold_and_books_nothing(client, driver):
    headers, user = driver()
    client.put("/api/me/card", headers=headers, json={**CARD, "last4": "0002"})
    code = free_spot(client, "F5")
    hold(client, headers, "F5", code)

    declined = reserve(client, headers, user, "F5", code)
    assert declined.status_code == 402
    assert declined.json()["detail"] == "Your card was declined. Try another card."
    assert spot(client, "F5", code, headers)["mine"] is True          # still held, so they can retry
    assert client.get("/api/reservations", headers=headers).json() == []
    assert payments(client, headers)[0]["status"] == "declined"

    client.put("/api/me/card", headers=headers, json=CARD)            # switch to a good card and retry
    assert reserve(client, headers, user, "F5", code).status_code == 201


def test_same_payment_key_never_charges_twice(client, driver):
    headers, user = driver()
    code = free_spot(client, "F2")
    hold(client, headers, "F2", code)
    body = {"lot_id": "F2", "spot": code, "plate": user["vehicles"][0]["plate"], "hours": 1, "payment_key": "tap-1234-abcd"}

    first = client.post("/api/reservations", headers=headers, json=body)
    again = client.post("/api/reservations", headers=headers, json=body)   # e.g. resent after a replica failed
    assert first.status_code == 201 and again.status_code == 201
    assert again.json()["id"] == first.json()["id"]
    assert len(payments(client, headers)) == 1
    assert len(client.get("/api/reservations", headers=headers).json()) == 1


def test_cancelling_refunds_the_card(client, driver):
    headers, user = driver()
    code = free_spot(client, "F4")
    hold(client, headers, "F4", code)
    made = reserve(client, headers, user, "F4", code, hours=3).json()

    cancelled = client.delete(f"/api/reservations/{made['id']}", headers=headers).json()
    assert cancelled["refunded"] == pytest.approx(made["total"])
    refund, charge = payments(client, headers)
    assert refund["kind"] == "refund" and refund["amount"] == pytest.approx(made["total"])
    assert refund["reservation_id"] == charge["reservation_id"] == made["id"]


def test_late_cancellation_refunds_only_unused_whole_hours():
    now = utcnow()
    booking = Reservation(start_at=now - timedelta(minutes=70), end_at=now + timedelta(minutes=170), total_cents=1200)
    assert refundable_cents(booking, 300, now) == 600                  # 2 of the 4 hours unused
    booking.start_at = now - timedelta(minutes=3)
    assert refundable_cents(booking, 300, now) == 1200                 # within the first 5 minutes
    booking.end_at = now - timedelta(minutes=1)
    assert refundable_cents(booking, 300, now) == 0                    # already over
