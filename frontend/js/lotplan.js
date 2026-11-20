// One lot's plan in flat local metres, for the 2D and 3D views.
//
// The server's plan (GET /api/lots/{lot}/map) gives each spot's centre and the direction its row
// runs. This puts everything in metres around the lot, north up like an aerial photo, and adds the
// grass islands and buildings around it from the campus data (GET /api/lots/map).

import { api } from './api.js';
import { campus } from './campusmap.js';

const plans = new Map();

/** Loads (once) and returns { spots, outline, islands, buildings, extent, spotW, spotD }. */
export async function lotPlan(lotId) {
  if (!plans.has(lotId)) {
    plans.set(lotId, Promise.all([api.lotMap(lotId), campus()]).then(([plan, info]) => build(plan, info)));
    plans.get(lotId).catch(() => plans.delete(lotId));
  }
  return plans.get(lotId);
}

function build(plan, info) {
  const ring = plan.outline.coordinates[0];
  const lng0 = ring.reduce((t, p) => t + p[0], 0) / ring.length;
  const lat0 = ring.reduce((t, p) => t + p[1], 0) / ring.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  // North up, like an aerial photo: x east, y north, in metres.
  const local = ([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky];

  const outline = plan.outline.coordinates.map((r) => r.map(local));
  const xs = outline[0].map((p) => p[0]), ys = outline[0].map((p) => p[1]);
  const extent = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const pad = 40;
  const near = (r) => r.some(([x, y]) => x > extent.minX - pad && x < extent.maxX + pad && y > extent.minY - pad && y < extent.maxY + pad);

  return {
    spots: plan.spots.map((spot) => {
      const [x, y] = local([spot.lng, spot.lat]);
      return { id: spot.id, x, y, heading: (spot.angle * Math.PI) / 180 };
    }),
    outline,
    islands: (info.islands || []).map((r) => r.map(local)).filter(near),
    buildings: (info.buildings || []).map((r) => r.map(local)).filter(near),
    extent,
    spotW: plan.spot_width,
    spotD: plan.spot_depth,
  };
}
