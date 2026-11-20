"""Lays parking spots out the way each lot is really painted.

data/campus.json holds, from OpenStreetMap: each lot's outline, the driving aisles inside the lots
(traced by mappers from aerial imagery), grass islands, and building footprints.

For a lot with mapped aisles, spots are placed along both sides of every aisle, nose-in, at real
size. A spot is kept only if it lies wholly inside the lot, clear of islands, buildings and other
aisles, and doesn't overlap a spot already placed. Longer aisles are filled first, so the main rows
win where aisles meet. A lot with no mapped aisles (Founders 6, Champions North) is filled with
rows along its long side instead.

The database spots (seed.py) and the map, 2D and 3D views (GET /api/lots/{id}/map) all come from
here, so they always agree. Results are computed once per process and cached.
"""

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

SPOT_W = 2.7        # metres across a spot
SPOT_D = 5.4        # metres from the aisle to the back of a spot
AISLE = 6.4         # metres of driving aisle (centre line to spot front is half of this)
EDGE = 0.8          # metres kept clear along a lot's edge (row-fill fallback only)
CELL = 7.0          # spatial-hash cell for overlap checks; > a spot's diagonal, so neighbours are always found

DATA = Path(__file__).parent / "data" / "campus.json"


@dataclass
class PlacedSpot:
    code: str
    row: int
    col: int
    kind: str           # standard | accessible | ev
    lng: float
    lat: float
    angle: float        # direction along the row (across the spot), degrees counter-clockwise from east


@dataclass
class LotLayout:
    lot_id: str
    angle: float        # the lot's main row direction, for turning the map
    rows: int
    cols: int
    spots: list[PlacedSpot] = field(default_factory=list)


@lru_cache(maxsize=1)
def campus() -> dict:
    return json.loads(DATA.read_text())


def outline(lot_id: str) -> dict | None:
    return next((f for f in campus()["lots"]["features"] if f["properties"]["id"] == lot_id), None)


def access(lot_id: str) -> str:
    """daily (anyone), permit (permit or employee permit) or employees (employee permit)."""
    feature = outline(lot_id)
    return feature["properties"].get("access", "daily") if feature else "daily"


def may_use(lot_id: str, permit_kind: str | None) -> bool:
    rule = access(lot_id)
    if rule == "permit":
        return permit_kind in ("permit", "employee")
    if rule == "employees":
        return permit_kind == "employee"
    return True


def refusal(lot_id: str) -> str:
    if access(lot_id) == "employees":
        return "This lot is for employee permit holders only. Add your employee permit in your profile."
    return "This lot is for parking permit holders only. Add your permit in your profile."


def row_letters(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    letters = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def _inside(x: float, y: float, ring) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def _seg_dist(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


class _Frame:
    """Flat metres around one point; fine over a few hundred metres."""

    def __init__(self, lng0: float, lat0: float) -> None:
        self.lng0, self.lat0 = lng0, lat0
        self.kx, self.ky = 111_320 * math.cos(math.radians(lat0)), 110_540

    def m(self, p) -> tuple[float, float]:
        return (p[0] - self.lng0) * self.kx, (p[1] - self.lat0) * self.ky

    def ll(self, x: float, y: float) -> tuple[float, float]:
        return round(self.lng0 + x / self.kx, 7), round(self.lat0 + y / self.ky, 7)


def _corners(cx, cy, ux, uy):
    """The four corners of a spot centred at (cx, cy), with u = unit vector along the row."""
    vx, vy = -uy, ux
    hw, hd = SPOT_W / 2, SPOT_D / 2
    return [(cx + sx * hw * ux + sy * hd * vx, cy + sx * hw * uy + sy * hd * vy)
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def _overlap(a, b) -> bool:
    """Separating-axis test for two convex quadrilaterals."""
    for poly in (a, b):
        for i in range(4):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % 4]
            nx, ny = y1 - y2, x2 - x1
            pa = [nx * x + ny * y for x, y in a]
            pb = [nx * x + ny * y for x, y in b]
            if max(pa) <= min(pb) + 1e-6 or max(pb) <= min(pa) + 1e-6:
                return False
    return True


def _main_angle(ring) -> tuple[float, float]:
    """Degrees of the long side of the smallest rectangle around the ring, and that rectangle's area."""
    best = None
    for deg in range(180):
        a = math.radians(deg)
        c, s = math.cos(a), math.sin(a)
        us = [x * c + y * s for x, y in ring]
        vs = [-x * s + y * c for x, y in ring]
        w, h = max(us) - min(us), max(vs) - min(vs)
        if best is None or w * h < best[0]:
            best = (w * h, deg + (90 if h > w else 0))
    return best[1] % 180, best[0]


def all_layouts() -> dict[str, "LotLayout"]:
    return {f["properties"]["id"]: layout(f["properties"]["id"]) for f in campus()["lots"]["features"]}


@lru_cache(maxsize=64)
def layout(lot_id: str) -> LotLayout | None:
    feature = outline(lot_id)
    if feature is None:
        return None
    data = campus()
    rings_ll = feature["geometry"]["coordinates"]
    outer_ll = rings_ll[0]
    frame = _Frame(sum(p[0] for p in outer_ll) / len(outer_ll), sum(p[1] for p in outer_ll) / len(outer_ll))
    outer = [frame.m(p) for p in outer_ll]
    xs, ys = [p[0] for p in outer], [p[1] for p in outer]
    box = (min(xs) - 10, min(ys) - 10, max(xs) + 10, max(ys) + 10)
    near = lambda ring: any(box[0] < x < box[2] and box[1] < y < box[3] for x, y in ring)  # noqa: E731

    holes = [[frame.m(p) for p in ring] for ring in rings_ll[1:]]
    # A permit or employee lot that wraps around a bookable one (Commencement around Commencement
    # North and South) leaves that part to the bookable lot, so their spots never overlap.
    if feature["properties"].get("access") != "daily":
        for other in data["lots"]["features"]:
            if other["properties"].get("access") == "daily":
                ring_m = [frame.m(p) for p in other["geometry"]["coordinates"][0]]
                if near(ring_m):
                    holes.append(ring_m)
    for ring in data.get("islands", []) + data.get("buildings", []):
        ring_m = [frame.m(p) for p in ring]
        if near(ring_m):
            holes.append(ring_m)

    # Aisle segments that run through this lot (midpoint inside, or within a few metres of its edge).
    segments = []
    for line in data.get("aisles", []):
        pts = [frame.m(p) for p in line]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            mx, my = (ax + bx) / 2, (ay + by) / 2
            if _inside(mx, my, outer) or min(_seg_dist(mx, my, *outer[i], *outer[i + 1]) for i in range(len(outer) - 1)) < 4:
                segments.append((ax, ay, bx, by))

    main_deg, _ = _main_angle(outer)
    main_deg = feature["properties"].get("rows_angle", main_deg)
    placed = _along_aisles(outer, holes, segments) if segments else []
    sketched = str(feature["properties"].get("osm", "")).startswith("approximate")
    if len(placed) < 4 or sketched:
        # No aisles mapped, or an outline sketched from the campus map that the mapped aisles only
        # partly cover: plain rows along the lot, if that fits more.
        rows_fill = _row_fill(outer, holes, main_deg)
        if len(rows_fill) > len(placed):
            placed = rows_fill
    if not placed:
        return LotLayout(lot_id, main_deg, 0, 0, [])

    # Name rows: one row per aisle side, ordered across the lot, then spots in order along each row.
    rows = defaultdict(list)
    for spot in placed:
        rows[spot["row_key"]].append(spot)
    a = math.radians(main_deg)
    across = lambda s: -s["x"] * math.sin(a) + s["y"] * math.cos(a)            # noqa: E731
    along = lambda s: s["x"] * math.cos(a) + s["y"] * math.sin(a)              # noqa: E731
    ordered_rows = sorted(rows.values(), key=lambda row: (round(sum(across(s) for s in row) / len(row)), sum(along(s) for s in row) / len(row)))

    spots = []
    for r, row in enumerate(ordered_rows):
        row.sort(key=lambda s: (s["x"] * s["ux"] + s["y"] * s["uy"]))
        for col, s in enumerate(row):
            kind = "standard"
            if r == 0 and len(row) >= 6:      # a few accessible and EV spots at the ends of the first row
                kind = "accessible" if col < 2 else "ev" if col >= len(row) - 2 else "standard"
            lng, lat = frame.ll(s["x"], s["y"])
            angle = math.degrees(math.atan2(s["uy"], s["ux"])) % 360
            spots.append(PlacedSpot(f"{row_letters(r)}{col + 1}", r, col, kind, lng, lat, round(angle, 2)))

    # The map turns to the direction most spots' rows run.
    weights = defaultdict(int)
    for s in spots:
        weights[round(s.angle % 180)] += 1
    turn = max(weights, key=weights.get)
    return LotLayout(lot_id, float(turn), len(ordered_rows), max(len(r) for r in ordered_rows), spots)


def _free(corners, center, outer, holes, segments, taken) -> bool:
    """A spot fits: inside the lot, off islands and buildings, off every aisle, not on another spot."""
    cx, cy = center
    samples = [center] + [(cx + 0.92 * (x - cx), cy + 0.92 * (y - cy)) for x, y in corners]
    samples += [((corners[i][0] + corners[(i + 1) % 4][0]) / 2 * 0.92 + cx * 0.08,
                 (corners[i][1] + corners[(i + 1) % 4][1]) / 2 * 0.92 + cy * 0.08) for i in range(4)]
    for x, y in samples:
        if not _inside(x, y, outer) or any(_inside(x, y, h) for h in holes):
            return False
        if any(_seg_dist(x, y, *seg) < AISLE / 2 - 0.25 for seg in segments):
            return False
    cell = (int(cx // CELL), int(cy // CELL))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for other in taken.get((cell[0] + dx, cell[1] + dy), ()):
                if _overlap(corners, other):
                    return False
    return True


def _along_aisles(outer, holes, segments) -> list[dict]:
    placed, taken = [], defaultdict(list)
    order = sorted(range(len(segments)), key=lambda i: -math.hypot(segments[i][2] - segments[i][0], segments[i][3] - segments[i][1]))
    for index in order:
        ax, ay, bx, by = segments[index]
        length = math.hypot(bx - ax, by - ay)
        if length < SPOT_W:
            continue
        ux, uy = (bx - ax) / length, (by - ay) / length
        for side in (1, -1):
            nx, ny = -uy * side, ux * side
            offset = AISLE / 2 + SPOT_D / 2
            t = SPOT_W / 2
            while t <= length - SPOT_W / 2 + 0.01:
                cx, cy = ax + ux * t + nx * offset, ay + uy * t + ny * offset
                corners = _corners(cx, cy, ux, uy)
                if _free(corners, (cx, cy), outer, holes, segments, taken):
                    placed.append({"x": cx, "y": cy, "ux": ux, "uy": uy, "row_key": (index, side)})
                    taken[(int(cx // CELL), int(cy // CELL))].append(corners)
                t += SPOT_W
    return placed


def _row_fill(outer, holes, deg) -> list[dict]:
    """No mapped aisles: one row along the edge, then pairs back to back with an aisle between."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    turned = [(x * c + y * s, -x * s + y * c) for x, y in outer]
    holes_t = [[(x * c + y * s, -x * s + y * c) for x, y in h] for h in holes]
    u_min, u_max = min(p[0] for p in turned), max(p[0] for p in turned)
    v_min, v_max = min(p[1] for p in turned), max(p[1] for p in turned)

    def fits(u0, v0):
        pad = 0.15
        pts = [(u0 + pad, v0 + pad), (u0 + SPOT_W - pad, v0 + pad), (u0 + pad, v0 + SPOT_D - pad),
               (u0 + SPOT_W - pad, v0 + SPOT_D - pad), (u0 + SPOT_W / 2, v0 + SPOT_D / 2)]
        return all(_inside(u, v, turned) and not any(_inside(u, v, h) for h in holes_t) for u, v in pts)

    def fill(v_shift, u_shift):
        out, v, index = [], v_min + EDGE + v_shift, 0
        while v + SPOT_D <= v_max - EDGE:
            u = u_min + EDGE + u_shift
            while u + SPOT_W <= u_max - EDGE:
                if fits(u, v):
                    cu, cv = u + SPOT_W / 2, v + SPOT_D / 2
                    out.append({"x": cu * c - cv * s, "y": cu * s + cv * c, "ux": c, "uy": s, "row_key": ("fill", index)})
                u += SPOT_W
            index += 1
            v += SPOT_D + (AISLE if index % 2 == 1 else 0)
        return out

    return max((fill(dv, du) for dv in (0, 1.5, 3, 4.5, 6, 7.5, 9) for du in (0, 1.35)), key=len)
