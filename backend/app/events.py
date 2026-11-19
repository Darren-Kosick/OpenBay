"""Live updates.

Every replica subscribes to the Redis channels lot:* once. When any replica changes a spot it
publishes to lot:{id}; each replica then forwards the message to the apps connected to it,
marking the spot as "mine" for the driver who holds or reserved it.
"""

import asyncio
import json
import logging
from collections import defaultdict

from fastapi import WebSocket
from redis.asyncio import Redis

from .spots import public

log = logging.getLogger("openbay.events")


class Hub:
    def __init__(self) -> None:
        self.connections: dict[str, set[tuple[WebSocket, int | None]]] = defaultdict(set)
        self._task: asyncio.Task | None = None

    def start(self, redis: Redis) -> None:
        self._task = asyncio.create_task(self._listen(redis))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def add(self, lot_id: str, websocket: WebSocket, user_id: int | None) -> None:
        self.connections[lot_id].add((websocket, user_id))

    def remove(self, lot_id: str, websocket: WebSocket, user_id: int | None) -> None:
        self.connections[lot_id].discard((websocket, user_id))

    async def _listen(self, redis: Redis) -> None:
        while True:
            pubsub = redis.pubsub()
            try:
                await pubsub.psubscribe("lot:*")
                async for message in pubsub.listen():
                    if message.get("type") == "pmessage":
                        await self._deliver(message)
            except asyncio.CancelledError:
                await pubsub.aclose()
                raise
            except Exception:                     # Redis restarted or the connection dropped: resubscribe.
                log.exception("Live update listener lost Redis; retrying")
                await asyncio.sleep(1)
            finally:
                try:
                    await pubsub.aclose()
                except Exception:
                    pass

    async def _deliver(self, message: dict) -> None:
        channel = message["channel"].decode() if isinstance(message["channel"], bytes) else message["channel"]
        lot_id = channel.split(":", 1)[1]
        data = json.loads(message["data"])
        for websocket, user_id in list(self.connections.get(lot_id, ())):
            payload = {**data, "spot": public(data["spot"], user_id)}
            try:
                await websocket.send_json(payload)
            except Exception:
                self.remove(lot_id, websocket, user_id)


hub = Hub()
