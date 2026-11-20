"""A pretend card processor, so the demo shows charges, declines and refunds without real money.

It behaves like a payment provider's test mode. The server only ever sees a card's brand and last
four digits, so the last four decide what happens:

    4242 4242 4242 4242   approved
    4000 0000 0000 0002   declined
    4000 0000 0000 9995   declined, insufficient funds
    anything else         approved

A real build would send a provider token instead and call the provider's API here. Everything else
(the payments table, idempotency keys, refunds on cancel) would stay the same.
"""

import asyncio
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import settings
from .db import aware, utcnow
from .models import PaymentCard, Reservation

DECLINES = {
    "0002": "Your card was declined. Try another card.",
    "9995": "Your card has insufficient funds. Try another card.",
}

# Cancelling within this long after booking refunds everything.
FULL_REFUND_MINUTES = 5


@dataclass
class GatewayResult:
    approved: bool
    reference: str
    message: str = ""


def _reference(prefix: str) -> str:
    return prefix + secrets.token_hex(5).upper()


async def charge(card: PaymentCard, amount_cents: int) -> GatewayResult:
    await asyncio.sleep(settings.payment_delay_ms / 1000)    # a real processor takes a moment
    if card.last4 in DECLINES:
        return GatewayResult(False, _reference("CH"), DECLINES[card.last4])
    return GatewayResult(True, _reference("CH"))


async def refund(charge_reference: str, amount_cents: int) -> GatewayResult:
    await asyncio.sleep(settings.payment_delay_ms / 2000)
    return GatewayResult(True, _reference("RF"))


def refundable_cents(reservation: Reservation, hourly_rate_cents: int, now: datetime | None = None) -> int:
    """What cancelling now gives back: everything in the first few minutes, then the unused whole hours."""
    now = now or utcnow()
    start, end = aware(reservation.start_at), aware(reservation.end_at)
    if now >= end:
        return 0
    if now - start <= timedelta(minutes=FULL_REFUND_MINUTES):
        return reservation.total_cents
    unused_hours = int((end - now).total_seconds() // 3600)
    return min(reservation.total_cents, unused_hours * hourly_rate_cents)
