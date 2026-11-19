"""Database tables (PostgreSQL in production)."""

from datetime import datetime

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(40), default="")
    password_hash: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    vehicles: Mapped[list["Vehicle"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin", order_by="Vehicle.id")
    card: Mapped["PaymentCard | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", lazy="selectin", uselist=False)


class Vehicle(Base):
    __tablename__ = "vehicles"
    __table_args__ = (UniqueConstraint("user_id", "plate"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    plate: Mapped[str] = mapped_column(String(8))
    province: Mapped[str] = mapped_column(String(8), default="ON")
    make: Mapped[str] = mapped_column(String(40))
    model: Mapped[str] = mapped_column(String(40), default="")
    colour: Mapped[str] = mapped_column(String(30), default="")

    user: Mapped[User] = relationship(back_populates="vehicles")


class PaymentCard(Base):
    """Only display details. A real build would keep a payment-provider token here, never the card number."""

    __tablename__ = "payment_cards"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    brand: Mapped[str] = mapped_column(String(20))
    last4: Mapped[str] = mapped_column(String(4))
    expiry: Mapped[str] = mapped_column(String(5))
    holder: Mapped[str] = mapped_column(String(120))

    user: Mapped[User] = relationship(back_populates="card")


class Lot(Base):
    __tablename__ = "lots"

    id: Mapped[str] = mapped_column(String(10), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    rows: Mapped[int] = mapped_column(Integer)
    cols: Mapped[int] = mapped_column(Integer)
    hourly_rate_cents: Mapped[int] = mapped_column(Integer)


class Spot(Base):
    __tablename__ = "spots"
    __table_args__ = (UniqueConstraint("lot_id", "code"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    lot_id: Mapped[str] = mapped_column(ForeignKey("lots.id"), index=True)
    code: Mapped[str] = mapped_column(String(6))        # "B6": row letter + number
    row: Mapped[int] = mapped_column(Integer)
    col: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(12), default="standard")   # standard | accessible | ev
    occupied: Mapped[bool] = mapped_column(Boolean, default=False)      # reported by the lot's sensors
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Reservation(Base):
    __tablename__ = "reservations"
    __table_args__ = (
        # The database's own guarantee against double booking: at most one active reservation per spot.
        # The Redis hold stops most conflicts earlier; this catches anything that slips past it.
        Index("one_active_reservation_per_spot", "spot_id", unique=True,
              postgresql_where=text("status = 'active'"), sqlite_where=text("status = 'active'")),
    )

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    spot_id: Mapped[int] = mapped_column(ForeignKey("spots.id"))
    plate: Mapped[str] = mapped_column(String(8))
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    end_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    total_cents: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(12), default="active")   # active | cancelled | completed
    moved_from: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    spot: Mapped[Spot] = relationship(lazy="joined")


class ViolationReport(Base):
    __tablename__ = "violation_reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    reservation_id: Mapped[str] = mapped_column(ForeignKey("reservations.id"))
    lot_name: Mapped[str] = mapped_column(String(80))
    spot_code: Mapped[str] = mapped_column(String(6))
    offender_plate: Mapped[str] = mapped_column(String(8), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    outcome: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
