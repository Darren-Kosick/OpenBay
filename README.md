# OpenBay: distributed smart parking reservations

SOFE4790U Distributed Systems, Fall 2026.

Drivers find a lot (by GPS), see every spot live in 3D, hold a spot for two minutes, and
reserve it. If someone else is parked in their spot, they report it and are moved to the
closest free spot automatically.

## Run it

You need Docker Desktop.

```bash
docker compose up --build
```

Open <http://localhost:8080> and tap **Use demo account**, or create an account. The card form
accepts the test card `4242 4242 4242 4242` with any future expiry. Nothing is charged.

To stop: `Ctrl+C`, then `docker compose down`. Add `-v` to also delete the database.

### Without Docker (one process, for quick UI work)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
DATABASE_URL=sqlite+aiosqlite:///./openbay.db REDIS_URL=fake:// FRONTEND_DIR=../frontend uvicorn app.main:app --reload
```

Open <http://localhost:8000>. This runs one replica with SQLite and an in-memory Redis, so it shows
the app but not the distributed parts.

### On a phone

Open `http://<your laptop's IP>:8080` on a phone on the same Wi-Fi. Browsers only allow GPS on
HTTPS or `localhost`, so on a phone use **Use demo location**, or put the site behind an HTTPS
tunnel (for example `cloudflared tunnel --url http://localhost:8080`).

## Architecture

```
                 ┌──────────────┐
  browser  ────► │  nginx (web) │  serves the app, load-balances /api and /ws
  simulator ───► └──────┬───────┘
                 ┌──────┴───────┐
                 ▼              ▼
             ┌───────┐      ┌───────┐   identical, stateless FastAPI replicas
             │ api-1 │      │ api-2 │
             └───┬───┘      └───┬───┘
        ┌────────┴──────┬───────┴────────┐
        ▼               ▼                ▼
  ┌────────────┐  ┌───────────────────────────────┐
  │ PostgreSQL │  │ Redis                         │
  │ records    │  │ spot holds (locks with a TTL) │
  └────────────┘  │ pub/sub for live updates      │
                  └───────────────────────────────┘
```

| Service | What it does |
| --- | --- |
| `web` | nginx. Serves `frontend/` and spreads API and WebSocket traffic across the replicas (`least_conn`). If a replica stops answering, requests go to the other one. |
| `api-1`, `api-2` | The FastAPI backend (`backend/app`). They keep nothing in memory that matters, so any replica can serve any request. Each response carries `X-Served-By` so you can see which one answered. |
| `db` | PostgreSQL 16: users, vehicles, cards, lots, spots, reservations, violation reports. |
| `redis` | Redis 7: two-minute spot holds, and the channel that carries live spot changes between replicas. |
| `simulator` | Stands in for the real world: parking sensors report cars arriving and leaving, and six bot drivers hold, reserve and cancel spots through the normal API. |

### Distributed systems ideas it uses (for the report)

- **Stateless replicas behind a load balancer.** Sessions are signed JWTs, so no replica needs to
  remember a login. Stop one (`docker compose stop api-2`) and the app keeps working.
- **Distributed lock with a lease.** Holding a spot is a Redis key with a 120 second TTL
  (`backend/app/locks.py`). Taking and releasing it runs as a Lua script, which Redis executes
  atomically, so two drivers on different replicas can never both hold one spot. If a driver
  walks away, the lease simply expires.
- **Defence in depth against double booking.** Under the Redis lock, PostgreSQL has a partial
  unique index allowing only one *active* reservation per spot (`models.py`). Even if the lock
  failed, the database would reject the second booking.
- **Publish/subscribe fan-out.** Every replica subscribes to `lot:*` in Redis. When any replica
  changes a spot it publishes once, and every replica pushes the change over WebSockets to the
  apps connected to it (`events.py`). The lot screen shows which replica the last update came from.
- **Coordinated startup.** All replicas start together; a Redis lock lets exactly one create the
  tables and seed the lots (`main.py`).
- **Idempotent background work.** Each replica periodically marks finished reservations as
  completed. Running it on both is safe because the update only matches rows once.
- **Reconnection.** If the WebSocket drops (say a replica restarts), the app reconnects with
  backoff and nginx sends it to a healthy replica.

### What happens when you reserve

1. **Hold:** `POST /api/lots/L2/spots/B6/hold`. The replica checks Postgres (not occupied, not
   reserved), then runs the Redis Lua script. Only one caller gets the lock; the rest get 409.
   The change is published, and every open app turns the spot red.
2. **Confirm:** `POST /api/reservations`. The replica checks that this driver still holds the
   lock, inserts the reservation (the unique index guards it again), releases the lock and
   publishes the change.
3. **Violation:** `POST /api/reservations/{id}/violations`. The blocked spot is marked occupied.
   Candidates are ranked: same lot and same kind of spot, nearest first; then same lot standard
   spots; then the nearest other lot. Each candidate is locked in Redis before the reservation
   moves, so a concurrent driver can't take it mid-move. If nothing is free, the reservation is
   cancelled and refunded.

## Testing

```bash
cd backend && pip install -r requirements-dev.txt && pytest
```

15 tests cover accounts, validation, holds, reservations, cancelling, the database's
double-booking guard, violation reassignment (including to another lot), sensor events and live
updates. They use SQLite and an in-memory Redis, so they need no services.

**Race test.** With the stack running:

```bash
python scripts/race_test.py http://localhost:8080 200
```

200 drivers try to hold one spot at the same instant. Results from a run with two replicas:

```
200 drivers racing for spot L3/A3 through http://localhost:8080
  hold results: {200: 1, 409: 199} in 974 ms
  requests per replica: {'api-1': 100, 'api-2': 100}
  reservations by drivers without the hold: 0
PASS: exactly one driver got the spot
```

**Failover demo.** Open a lot in the browser, then run `docker compose stop api-2`. Spots keep
updating and new requests are answered by `api-1`. `docker compose start api-2` brings it back.

## API

Interactive docs with a "Try it out" button: <http://localhost:8080/api/docs>.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/auth/register` | Create an account (optionally with a vehicle and card). Returns a token. |
| POST | `/api/auth/login` | Sign in. Returns a token. |
| GET, PATCH | `/api/me` | Read or update name and phone. |
| POST, DELETE | `/api/me/vehicles[/{id}]` | Add or remove a vehicle. |
| PUT, DELETE | `/api/me/card` | Save or remove the payment card's display details. |
| GET | `/api/lots` | Lots with free counts. |
| GET | `/api/lots/{lot}/spots` | Every spot with its live status. |
| POST, DELETE | `/api/lots/{lot}/spots/{spot}/hold` | Take or release a two-minute hold. |
| GET, POST | `/api/reservations` | List mine, or turn a hold into a reservation. |
| DELETE | `/api/reservations/{id}` | Cancel. |
| POST | `/api/reservations/{id}/violations` | Report a vehicle in my spot and get moved. |
| GET | `/api/violations` | My reports. |
| POST | `/api/sensors/events` | Sensor reports a car arriving or leaving (needs `X-Sensor-Key`). |
| WS | `/ws/lots/{lot}?token=…` | Live spot changes for one lot. |
| GET | `/api/health` | Which replica answered, and whether Redis is reachable. |

## Project layout

```
docker-compose.yml        the whole system
nginx/nginx.conf          load balancer and static files
backend/
  app/main.py             app setup, startup lock, sweeper
  app/models.py           database tables
  app/locks.py            Redis spot holds (Lua scripts)
  app/spots.py            spot status, publishing changes
  app/events.py           WebSocket fan-out from Redis pub/sub
  app/routers/            one file per area of the API
  sim/                    sensor and bot-driver simulator
  tests/                  pytest suite
frontend/
  index.html              page shell
  css/styles.css          all styling, light and dark themes
  js/main.js              routing and event handling
  js/api.js               every call to the server, WebSocket reconnects
  js/lot3d.js             the three.js lot
  js/views/               one file per screen
scripts/race_test.py      concurrency test
```

## Not production-ready

- **Payments are display-only.** Only the card brand, last four digits and expiry reach the
  server. A real build would use a payment provider's hosted form and store its token.
- **Schema changes.** Tables are created at startup. Use Alembic migrations before changing
  models on a database with real data.
- **Auth hardening.** No login rate limiting, refresh tokens or email verification. Set a long
  random `JWT_SECRET` (see `.env.example`) before deploying anywhere.
- **Single Redis and Postgres.** The API tier is replicated; the data tier is not. Redis Sentinel
  and a Postgres replica would remove those single points of failure.
- **Demo data.** The four lots and their coordinates near Ontario Tech are placeholders.
- **The iOS app** (`OpenBay-iOS`) still uses its own on-device mock. Its `AppStore` methods are
  named after these routes, so pointing it at this API means replacing those method bodies with
  `URLSession` calls.
