"""Tests run against a temporary SQLite file and an in-process fake Redis, so they need no services.

    cd backend && pip install -r requirements-dev.txt && pytest
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

_db = Path(tempfile.mkdtemp()) / "test.db"
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_db}"
os.environ["REDIS_URL"] = "fake://"
os.environ["SENSOR_KEY"] = "test-sensor-key"
os.environ["INSTANCE_NAME"] = "test-1"
os.environ["SWEEP_SECONDS"] = "3600"
os.environ["PAYMENT_DELAY_MS"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

CARD = {"brand": "Visa", "last4": "4242", "expiry": "12/30", "holder": "Test Driver"}


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client


_count = 0


@pytest.fixture
def driver(client):
    """Registers a fresh driver with a vehicle and a card; returns (auth headers, user)."""
    def make(with_card: bool = True, plate: str | None = None):
        global _count
        _count += 1
        body = {
            "name": f"Driver {_count}", "email": f"driver{_count}@example.com", "password": "password123",
            "vehicle": {"plate": plate or f"TEST{_count:03d}", "province": "ON", "make": "Honda", "model": "Civic"},
        }
        if with_card:
            body["card"] = CARD
        response = client.post("/api/auth/register", json=body)
        assert response.status_code == 201, response.text
        data = response.json()
        return {"Authorization": f"Bearer {data['token']}"}, data["user"]
    return make


def free_spot(client, lot_id: str, kind: str = "standard", exclude: tuple = ()) -> str:
    spots = client.get(f"/api/lots/{lot_id}/spots").json()
    return next(s["id"] for s in spots if s["status"] == "available" and s["type"] == kind and s["id"] not in exclude)


def spot(client, lot_id: str, code: str, headers=None) -> dict:
    spots = client.get(f"/api/lots/{lot_id}/spots", headers=headers or {}).json()
    return next(s for s in spots if s["id"] == code)
