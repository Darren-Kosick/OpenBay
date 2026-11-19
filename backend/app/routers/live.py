from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..events import hub
from ..security import user_id_from_token

router = APIRouter(tags=["live"])


@router.websocket("/ws/lots/{lot_id}")
async def lot_updates(websocket: WebSocket, lot_id: str):
    """Pushes every spot change in a lot, from any replica, to this app."""
    user_id = user_id_from_token(websocket.query_params.get("token"))
    await websocket.accept()
    await websocket.send_json({"type": "hello", "instance": settings.instance})
    hub.add(lot_id, websocket, user_id)
    try:
        while True:
            await websocket.receive_text()           # the app sends "ping" now and then to keep proxies happy
    except WebSocketDisconnect:
        pass
    finally:
        hub.remove(lot_id, websocket, user_id)
