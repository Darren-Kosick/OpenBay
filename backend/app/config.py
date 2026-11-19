"""Settings, read from environment variables so every replica can be configured from Docker Compose."""

import os
import socket


class Settings:
    def __init__(self) -> None:
        # Postgres in Docker; a local SQLite file when you run one replica by hand.
        self.database_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./openbay.db")
        # "fake://" uses an in-process fake Redis (tests and quick local runs only).
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        self.jwt_secret = os.getenv("JWT_SECRET", "dev-only-secret-change-me-in-production")
        self.jwt_hours = int(os.getenv("JWT_HOURS", "24"))
        # How long a driver keeps a spot while confirming. This is the TTL on the Redis lock.
        self.hold_seconds = int(os.getenv("HOLD_SECONDS", "120"))
        # Shared secret the parking sensors (here, the simulator) send with each event.
        self.sensor_key = os.getenv("SENSOR_KEY", "dev-sensor-key")
        # Shown in the X-Served-By header and on live events, so you can see which replica answered.
        self.instance = os.getenv("INSTANCE_NAME", socket.gethostname())
        # Optional: serve the web front end from this folder (handy when running without nginx).
        self.frontend_dir = os.getenv("FRONTEND_DIR", "")
        # How often each replica marks finished reservations as completed.
        self.sweep_seconds = int(os.getenv("SWEEP_SECONDS", "30"))


settings = Settings()
