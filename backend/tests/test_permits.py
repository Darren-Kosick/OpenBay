"""Permit lots: Commencement and Founders 1 take a parking permit, Founders 3 and Champions South an employee permit."""

from conftest import free_spot
from test_api import hold, reserve


def payments(client, headers):
    return client.get("/api/payments", headers=headers).json()


def test_permit_lots_turn_away_drivers_without_a_permit(client, driver):
    headers, user = driver()
    code = free_spot(client, "COM")
    refused = hold(client, headers, "COM", code)
    assert refused.status_code == 403
    assert "permit holders only" in refused.json()["detail"]
    assert reserve(client, headers, user, "COM", code).status_code == 403


def test_a_permit_books_permit_lots_for_free(client, driver):
    headers, user = driver(with_card=False)                 # no card needed: the permit covers it
    saved = client.put("/api/me/permit", headers=headers, json={"kind": "permit", "number": "p-2026-1234"})
    assert saved.json()["permit"] == {"kind": "permit", "number": "P20261234"}

    code = free_spot(client, "F1")
    assert hold(client, headers, "F1", code).status_code == 200
    made = reserve(client, headers, user, "F1", code, hours=3)
    assert made.status_code == 201, made.text
    assert made.json()["total"] == 0 and made.json()["card"] is None
    assert payments(client, headers) == []

    # A parking permit is not an employee permit.
    staff = free_spot(client, "F3")
    assert hold(client, headers, "F3", staff).status_code == 403


def test_an_employee_permit_opens_staff_and_permit_lots(client, driver):
    headers, user = driver()
    client.put("/api/me/permit", headers=headers, json={"kind": "employee", "number": "E5501"})
    for lot_id in ("CHS", "COM"):
        code = free_spot(client, lot_id)
        assert hold(client, headers, lot_id, code).status_code == 200
        assert reserve(client, headers, user, lot_id, code).status_code == 201

    assert client.delete("/api/me/permit", headers=headers).json()["permit"] is None
    assert hold(client, headers, "CHS", free_spot(client, "CHS")).status_code == 403


def test_permit_needs_a_real_looking_number(client, driver):
    headers, _ = driver()
    bad = client.put("/api/me/permit", headers=headers, json={"kind": "permit", "number": "x"})
    assert bad.status_code == 422
    assert client.put("/api/me/permit", headers=headers, json={"kind": "visitor", "number": "P1234"}).status_code == 422


def test_parked_cars_line_up_with_the_map(client):
    parked = client.get("/api/lots/parked").json()
    bays = client.get("/api/lots/map").json()["bays"]
    assert all(len(parked[lot_id]) == len(bays[lot_id]) for lot_id in bays)
    spots = client.get("/api/lots/COM/spots").json()
    assert parked["COM"].count("1") == sum(s["occupied"] for s in spots)
