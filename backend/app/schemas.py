"""Request and response shapes. Validation messages are written to be shown to the driver as-is."""

import re
from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator

PROVINCES = {"ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU", "Other"}


def normalize_plate(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (raw or "").upper())


class VehicleIn(BaseModel):
    plate: str
    province: str = "ON"
    make: str
    model: str = ""
    colour: str = ""

    @field_validator("plate")
    @classmethod
    def check_plate(cls, value: str) -> str:
        plate = normalize_plate(value)
        if not 2 <= len(plate) <= 8:
            raise ValueError("Enter a licence plate of 2 to 8 letters and numbers.")
        return plate

    @field_validator("province")
    @classmethod
    def check_province(cls, value: str) -> str:
        if value not in PROVINCES:
            raise ValueError("Choose a province.")
        return value

    @field_validator("make")
    @classmethod
    def check_make(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter the vehicle make.")
        return value[:40]

    @field_validator("model", "colour")
    @classmethod
    def trim(cls, value: str) -> str:
        return value.strip()[:40]


class VehicleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    plate: str
    province: str
    make: str
    model: str
    colour: str


class CardIn(BaseModel):
    """The app checks the full number on the device and sends only these display details."""

    brand: str
    last4: str
    expiry: str
    holder: str

    @field_validator("brand")
    @classmethod
    def check_brand(cls, value: str) -> str:
        if value not in {"Visa", "Mastercard", "Amex", "Card"}:
            raise ValueError("Unsupported card.")
        return value

    @field_validator("last4")
    @classmethod
    def check_last4(cls, value: str) -> str:
        if not re.fullmatch(r"\d{4}", value):
            raise ValueError("That card number is not valid.")
        return value

    @field_validator("expiry")
    @classmethod
    def check_expiry(cls, value: str) -> str:
        match = re.fullmatch(r"(\d{2})/(\d{2})", value.strip())
        if not match or not 1 <= int(match[1]) <= 12:
            raise ValueError("Enter the expiry as MM/YY.")
        now = datetime.now(timezone.utc)
        if (2000 + int(match[2])) * 12 + int(match[1]) < now.year * 12 + now.month:
            raise ValueError("That card has expired.")
        return f"{match[1]}/{match[2]}"

    @field_validator("holder")
    @classmethod
    def check_holder(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter the name on the card.")
        return value[:120]


class CardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    brand: str
    last4: str
    expiry: str
    holder: str


class PermitIn(BaseModel):
    """Demo: any permit number is accepted. A real build would check it against Parking Services."""

    kind: str
    number: str

    @field_validator("kind")
    @classmethod
    def check_kind(cls, value: str) -> str:
        if value not in {"permit", "employee"}:
            raise ValueError("Choose a permit type.")
        return value

    @field_validator("number")
    @classmethod
    def check_number(cls, value: str) -> str:
        number = re.sub(r"[^A-Z0-9]", "", (value or "").upper())
        if not 4 <= len(number) <= 16:
            raise ValueError("Enter the permit number printed on your permit (4 to 16 letters and numbers).")
        return number


class PermitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    kind: str
    number: str


class RegisterIn(BaseModel):
    name: str
    email: str
    phone: str = ""
    password: str
    vehicle: VehicleIn | None = None
    card: CardIn | None = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter your name.")
        return value[:120]

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid email address.")
        return value

    @field_validator("phone")
    @classmethod
    def check_phone(cls, value: str) -> str:
        return value.strip()[:40]

    @field_validator("password")
    @classmethod
    def check_password(cls, value: str) -> str:
        if len(value) < 8:
            raise ValueError("Use a password of at least 8 characters.")
        if len(value.encode()) > 72:
            raise ValueError("Use a password of at most 72 characters.")
        return value


class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str
    phone: str
    vehicles: list[VehicleOut]
    card: CardOut | None
    permit: PermitOut | None = None


class AuthOut(BaseModel):
    token: str
    user: UserOut


class UserPatch(BaseModel):
    name: str | None = None
    phone: str | None = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Enter your name.")
        return value.strip()[:120] if value else value


class LotOut(BaseModel):
    id: str
    name: str
    latitude: float
    longitude: float
    rows: int
    cols: int
    hourly_rate: float
    access: str = "daily"           # daily | permit | employees
    total: int
    free: int


class ReserveIn(BaseModel):
    lot_id: str
    spot: str
    plate: str
    hours: int = Field(ge=1, le=8)
    # A fresh random value for each "Confirm and pay" tap; resending it never charges twice.
    payment_key: str | None = Field(default=None, min_length=8, max_length=64)

    @field_validator("plate")
    @classmethod
    def clean_plate(cls, value: str) -> str:
        return normalize_plate(value)


class ReservationOut(BaseModel):
    id: str
    lot_id: str
    lot_name: str
    spot: str
    plate: str
    start: datetime
    end: datetime
    total: float
    status: str
    active: bool
    moved_from: str | None
    card: str | None = None             # what it was charged to, e.g. "Visa ···· 4242"
    refunded: float = 0
    refundable: float = 0               # what cancelling right now would give back


class PaymentOut(BaseModel):
    id: str
    kind: str                           # charge | refund
    status: str                         # succeeded | declined
    amount: float
    card: str
    description: str
    message: str
    reservation_id: str | None
    created_at: datetime


class ViolationIn(BaseModel):
    offender_plate: str = ""
    note: str = ""

    @field_validator("offender_plate")
    @classmethod
    def clean_plate(cls, value: str) -> str:
        return normalize_plate(value)[:8]

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str) -> str:
        return value.strip()[:500]


class ViolationOut(BaseModel):
    id: int
    created_at: datetime
    lot_name: str
    spot: str
    offender_plate: str
    note: str
    outcome: str


class ViolationResult(BaseModel):
    outcome: str                    # "moved" | "refunded"
    reservation: ReservationOut
    report: ViolationOut


class SensorEvent(BaseModel):
    lot_id: str
    spot: str
    occupied: bool
