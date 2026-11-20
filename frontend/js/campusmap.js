// The 3D campus map: real streets and buildings (OpenStreetMap, via OpenFreeMap vector tiles),
// drawn with MapLibre GL. Two uses:
//
//   createCampusMap(el, { lots, pos, dark, onLot })        every lot, coloured by free spots (Find)
//   createLotMap(el, lot, spots, { dark, onPick, onLot })  one lot's spots in place on the campus (Lot)
//
// Both throw if MapLibre or WebGL can't load; the callers fall back to the simpler views.

import { api } from './api.js';

const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist';
const TILES = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

const PALETTES = {
  light: {
    bg: '#f3f1ec', park: '#d5e8cc', wood: '#c8e0bd', water: '#a8cdf0', campus: '#ece9e2',
    road: '#ffffff', roadMajor: '#fdf1c7', casing: '#d8d4cb', path: '#e2ded5',
    building: '#e2ded7', buildingTop: '#ece9e4', label: '#5f636b', halo: '#f3f1ec', landmark: '#3c4049',
    lotFree: '#3b82f6', lotFull: '#e5484d', lotOther: '#9aa0a8',
    available: '#3b82f6', reserved: '#e5484d', occupied: '#c4c6ca', mine: '#1f9d55', selected: '#1d4ed8',
    bay: '#c9d6ee', bayOther: '#d5d7dc', accessible: '#60a5fa', ev: '#8b5cf6', car: '#cfd2d8', cabin: '#8c929c', mineCabin: '#167a42', roof: '#f4f2ee', lane: '#ffffff',
  },
  dark: {
    bg: '#272a37', park: '#2b4337', wood: '#2a4035', water: '#1d3557', campus: '#2c2f3d',
    road: '#454b5e', roadMajor: '#5a5f73', casing: '#20222c', path: '#3a3e4e',
    building: '#4a4762', buildingTop: '#57536f', label: '#b9bdca', halo: '#272a37', landmark: '#e6e8ee',
    lotFree: '#4c8dff', lotFull: '#ff5a5f', lotOther: '#6b7080',
    available: '#4c8dff', reserved: '#ff5a5f', occupied: '#4a4e57', mine: '#30c26e', selected: '#8fb4ff',
    bay: '#33456b', bayOther: '#454a5a', accessible: '#60a5fa', ev: '#a78bfa', car: '#7a7f8c', cabin: '#3e424d', mineCabin: '#1e7a48', roof: '#6a6585', lane: '#3a3e4e',
  },
};

/* ---------- loading MapLibre once ---------- */

let loading = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  loading ??= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${MAPLIBRE}/maplibre-gl.css`;
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = `${MAPLIBRE}/maplibre-gl.js`;
    script.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error('MapLibre did not load')));
    script.onerror = () => { loading = null; reject(new Error('MapLibre did not load')); };
    document.head.appendChild(script);
  });
  return loading;
}

function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch (e) {
    return false;
  }
}

/* ---------- geometry ---------- */

// Outlines and landmarks come from the server (GET /api/lots/map), fetched once.
let campusData = null;
export const campus = async () => (campusData ??= await api.campusMap());

function boundsOf(rings) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
  }
  return [[w, s], [e, n]];
}

/** A rounded rectangle, `w` across and `l` long, centred at (cu, cv) in a turned metric frame. */
function rounded(cu, cv, w, l, r, toLL) {
  const pts = [];
  const corners = [[w / 2 - r, l / 2 - r, 0], [-w / 2 + r, l / 2 - r, 90], [-w / 2 + r, -l / 2 + r, 180], [w / 2 - r, -l / 2 + r, 270]];
  for (const [x, y, start] of corners) {
    for (let k = 0; k <= 4; k++) {
      const t = ((start + k * 22.5) * Math.PI) / 180;
      pts.push(toLL(cu + x + r * Math.cos(t), cv + y + r * Math.sin(t)));
    }
  }
  pts.push(pts[0]);
  return [pts];
}

const KX = (lat) => 111320 * Math.cos((lat * Math.PI) / 180), KY = 110540;

/** A spot's corners and its car parts, from its centre and the direction its row runs. */
function spotShape(lng, lat, angleDeg, W, D) {
  const kx = KX(lat), a = (angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // Turned frame centred on the spot: u along the row, v across it (the way the car points).
  const toLL = (u, v) => [lng + (u * c - v * s) / kx, lat + (u * s + v * c) / KY];
  return {
    bay: rounded(0, 0, W - 0.3, D - 0.3, 0.25, toLL),
    body: rounded(0, 0, 1.8, 4.4, 0.6, toLL),
    cabin: rounded(0, -0.15, 1.5, 2.3, 0.5, toLL),
  };
}

/**
 * Turns the server's spots into shapes on the ground: the painted bay, and a parked car
 * (a rounded body, and a narrower cabin on top) for when the spot's sensor says it's taken.
 */
function shapes(plan) {
  const spots = [], cars = [], rings = [];
  plan.spots.forEach((spot, i) => {
    const shape = spotShape(spot.lng, spot.lat, spot.angle, plan.spot_width, plan.spot_depth);
    rings.push(shape.bay[0]);
    spots.push({ type: 'Feature', id: i, properties: { code: spot.id }, geometry: { type: 'Polygon', coordinates: shape.bay } });
    cars.push({ type: 'Feature', properties: { code: spot.id, part: 'body' }, geometry: { type: 'Polygon', coordinates: shape.body } });
    cars.push({ type: 'Feature', properties: { code: spot.id, part: 'cabin' }, geometry: { type: 'Polygon', coordinates: shape.cabin } });
  });
  return { spots, cars, bounds: rings.length ? boundsOf(rings) : null };
}

/**
 * Painted bays for every lot, as the campus looks from above, with a car in each spot whose sensor
 * says it's taken (GET /api/lots/parked, a 0/1 string per lot in the same order as the bays).
 */
function bayFeatures(data, exceptId, parked = {}) {
  const access = Object.fromEntries((data.lots?.features || []).map((f) => [f.properties.id, f.properties.access]));
  const bays = [], cars = [];
  for (const [lotId, list] of Object.entries(data.bays || {})) {
    if (lotId === exceptId) continue;
    const taken = parked[lotId] || '';
    list.forEach(([lng, lat, angle], i) => {
      const shape = spotShape(lng, lat, angle, data.spot_width, data.spot_depth);
      bays.push({ type: 'Feature', properties: { lot: lotId, other: access[lotId] !== 'daily' }, geometry: { type: 'Polygon', coordinates: shape.bay } });
      if (taken[i] === '1') {
        cars.push({ type: 'Feature', properties: { part: 'body' }, geometry: { type: 'Polygon', coordinates: shape.body } });
        cars.push({ type: 'Feature', properties: { part: 'cabin' }, geometry: { type: 'Polygon', coordinates: shape.cabin } });
      }
    });
  }
  return { bays: { type: 'FeatureCollection', features: bays }, cars: { type: 'FeatureCollection', features: cars } };
}

const noParked = () => api.parked().catch(() => ({}));

/* ---------- the map style ---------- */

function lotFeatures(outlines, lots, focusId) {
  const byId = Object.fromEntries((lots || []).map((l) => [l.id, l]));
  return {
    type: 'FeatureCollection',
    features: outlines.features.map((f) => {
      const lot = byId[f.properties.id];
      const state = !lot ? 'other' : lot.free > 0 ? 'free' : 'full';
      return { ...f, properties: { ...f.properties, state, focus: f.properties.id === focusId } };
    }),
  };
}

function style(dark, data) {
  const p = dark ? PALETTES.dark : PALETTES.light;
  const road = (cls) => ['match', ['get', 'class'], cls, true, false];
  const width = (base) => ['interpolate', ['exponential', 1.6], ['zoom'], 14, base * 0.5, 17, base * 2.2, 19, base * 7];
  // Road width by class, growing with zoom. `extra` widens it for the casing drawn underneath.
  const roadScale = ['match', ['get', 'class'], 'service', 0.6, 'minor', 1, ['primary', 'secondary', 'trunk'], 1.8, 1.3];
  const roadWidth = (extra = 0) => ['interpolate', ['exponential', 1.6], ['zoom'],
    14, ['+', ['*', roadScale, 0.5], extra * 0.5], 17, ['+', ['*', roadScale, 2.2], extra], 19, ['+', ['*', roadScale, 7], extra * 2]];
  const bh = ['max', ['coalesce', ['get', 'render_height'], 6], 6];
  return {
    version: 8,
    glyphs: GLYPHS,
    // Soft, high light from the viewer's side: gentler wall shading than the default.
    light: { anchor: 'viewport', color: '#ffffff', intensity: dark ? 0.22 : 0.28, position: [1.3, 200, 35] },
    sources: {
      osm: { type: 'vector', url: TILES, attribution: ATTRIBUTION },
      lots: { type: 'geojson', data: data.lots },
      bays: { type: 'geojson', data: data.bays.bays },
      'bay-cars': { type: 'geojson', data: data.bays.cars },
      landmarks: { type: 'geojson', data: data.landmarks },
      spots: { type: 'geojson', data: data.spots },
      cars: { type: 'geojson', data: data.cars },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.bg } },
      { id: 'campus', type: 'fill', source: 'osm', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['university', 'college', 'school']]], paint: { 'fill-color': p.campus } },
      { id: 'park', type: 'fill', source: 'osm', 'source-layer': 'park', paint: { 'fill-color': p.park } },
      { id: 'grass', type: 'fill', source: 'osm', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'wood', 'scrub', 'wetland']]],
        paint: { 'fill-color': ['match', ['get', 'class'], 'wood', p.wood, p.park], 'fill-opacity': 0.8 } },
      { id: 'pitch', type: 'fill', source: 'osm', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['pitch', 'stadium', 'playground']]], paint: { 'fill-color': p.park } },
      { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': p.water } },

      { id: 'path', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: road('path'), paint: { 'line-color': p.path, 'line-width': width(0.6), 'line-dasharray': [2, 1.5] } },
      { id: 'road-casing', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary', 'secondary', 'primary', 'trunk']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p.casing, 'line-width': roadWidth(2) } },
      { id: 'road', type: 'line', source: 'osm', 'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary', 'secondary', 'primary', 'trunk']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'class'], ['primary', 'secondary', 'trunk'], p.roadMajor, p.road],
                 'line-width': roadWidth() } },

      // Parking lots: the real outlines, blue with free spots, red when full, grey when not bookable.
      { id: 'lot-fill', type: 'fill', source: 'lots',
        paint: { 'fill-color': ['match', ['get', 'state'], 'free', p.lotFree, 'full', p.lotFull, p.lotOther],
                 'fill-opacity': ['case', ['get', 'focus'], 0.12, ['==', ['get', 'state'], 'other'], 0.14, 0.28] } },
      { id: 'lot-line', type: 'line', source: 'lots', filter: ['!=', ['get', 'state'], 'other'],
        paint: { 'line-color': ['match', ['get', 'state'], 'free', p.lotFree, p.lotFull],
                 'line-width': ['case', ['get', 'focus'], 2.5, 1.5] } },
      { id: 'lot-line-other', type: 'line', source: 'lots', filter: ['==', ['get', 'state'], 'other'],
        paint: { 'line-color': p.lotOther, 'line-width': 1.2, 'line-dasharray': [2, 2] } },

      // Every lot's painted bays, for the look of the campus from above.
      { id: 'bays', type: 'fill', source: 'bays', minzoom: 14.8,
        paint: { 'fill-color': ['case', ['get', 'other'], p.bayOther, p.bay],
                 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14.8, 0, 15.6, 1] } },

      // One lot's own spots (lot screen only).
      { id: 'spot-fill', type: 'fill', source: 'spots',
        paint: { 'fill-color': ['match', ['get', 'state'], 'mine', p.mine, 'selected', p.selected, 'available', p.available,
                                'occupied', p.occupied, p.reserved],
                 'fill-opacity': ['match', ['get', 'state'], 'occupied', 0.55, 0.85] } },
      { id: 'spot-kind', type: 'line', source: 'spots', filter: ['!=', ['get', 'kind'], 'standard'],
        paint: { 'line-color': ['match', ['get', 'kind'], 'ev', p.ev, p.accessible], 'line-width': 2 } },
      { id: 'spot-mine-glow', type: 'line', source: 'spots', filter: ['==', ['get', 'state'], 'mine'],
        paint: { 'line-color': p.mine, 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.8 } },
      { id: 'spot-selected', type: 'line', source: 'spots', filter: ['==', ['get', 'sel'], true],
        paint: { 'line-color': dark ? '#ffffff' : '#0b2a7a', 'line-width': 2.5 } },
      { id: 'spot-code', type: 'symbol', source: 'spots', minzoom: 19,
        layout: { 'text-field': ['get', 'code'], 'text-font': FONT_BOLD, 'text-size': 10, 'text-allow-overlap': true },
        paint: { 'text-color': '#ffffff' } },

      // Buildings in 3D: walls, then a lighter roof cap so the top edge reads as a soft bevel.
      // Heights grow in as you zoom, rather than popping up.
      { id: 'building', type: 'fill-extrusion', source: 'osm', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'render_height'], 0, p.building, 30, p.buildingTop],
                 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.2, ['-', bh, 0.8]],
                 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true } },
      { id: 'building-roof', type: 'fill-extrusion', source: 'osm', 'source-layer': 'building', minzoom: 14,
        paint: { 'fill-extrusion-color': p.roof,
                 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.2, bh],
                 'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15.2, ['-', bh, 0.8]],
                 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': false } },

      // Parked cars in every lot except the one on screen (which has its own live layer below).
      { id: 'bay-car-body', type: 'fill-extrusion', source: 'bay-cars', minzoom: 15, filter: ['==', ['get', 'part'], 'body'],
        paint: { 'fill-extrusion-color': p.car, 'fill-extrusion-height': 0.95, 'fill-extrusion-base': 0.22, 'fill-extrusion-opacity': 0.97 } },
      { id: 'bay-car-cabin', type: 'fill-extrusion', source: 'bay-cars', minzoom: 15, filter: ['==', ['get', 'part'], 'cabin'],
        paint: { 'fill-extrusion-color': p.cabin, 'fill-extrusion-height': 1.5, 'fill-extrusion-base': 0.95, 'fill-extrusion-opacity': 0.97 } },

      // Parked cars: a rounded body with a smaller, darker cabin on top.
      { id: 'car-body', type: 'fill-extrusion', source: 'cars', filter: ['all', ['get', 'parked'], ['==', ['get', 'part'], 'body']],
        paint: { 'fill-extrusion-color': ['case', ['get', 'mine'], p.mine, p.car], 'fill-extrusion-height': 0.95,
                 'fill-extrusion-base': 0.22, 'fill-extrusion-opacity': 0.97 } },
      { id: 'car-cabin', type: 'fill-extrusion', source: 'cars', filter: ['all', ['get', 'parked'], ['==', ['get', 'part'], 'cabin']],
        paint: { 'fill-extrusion-color': ['case', ['get', 'mine'], p.mineCabin, p.cabin], 'fill-extrusion-height': 1.5,
                 'fill-extrusion-base': 0.95, 'fill-extrusion-opacity': 0.97 } },

      { id: 'road-label', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 15,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'tertiary', 'secondary', 'primary', 'trunk']]],
        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11,
                  'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
        paint: { 'text-color': p.label, 'text-halo-color': p.halo, 'text-halo-width': 1.5 } },
      { id: 'landmark', type: 'symbol', source: 'landmarks', minzoom: 14.8,
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 11.5, 'text-max-width': 8,
                  'text-variable-anchor': ['center', 'top', 'bottom'], 'text-radial-offset': 0.6 },
        paint: { 'text-color': p.landmark, 'text-halo-color': p.halo, 'text-halo-width': 1.6 } },
    ],
  };
}

/* ---------- lot pins ---------- */

function pin(lot, onLot) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'lot-pin';
  el.addEventListener('click', (event) => { event.stopPropagation(); onLot?.(lot.id); });
  update(el, lot);
  return el;
}

function update(el, lot) {
  el.classList.toggle('full', lot.free === 0);
  el.classList.toggle('permit', Boolean(lot.access && lot.access !== 'daily'));
  el.innerHTML = `<b>${lot.id}</b><span>${lot.free}</span>`;
  el.title = `${lot.name}: ${lot.free} of ${lot.total} free${lot.access === 'employees' ? ' · employee permit' : lot.access === 'permit' ? ' · parking permit' : ''}`;
  el.setAttribute('aria-label', el.title);
}

async function baseMap(el, camera, dark, data) {
  if (!webglAvailable()) throw new Error('WebGL is not available');
  const maplibregl = await loadMapLibre();
  el.innerHTML = '';
  const map = new maplibregl.Map({
    container: el, style: style(dark, data), attributionControl: false,
    ...camera, maxPitch: 70, dragRotate: true, pitchWithRotate: true,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true }), 'top-right');
  // Start with the map credits folded into their (i) button, so they don't cover the map.
  map.once('load', () => el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  return { map, maplibregl };
}

/* ---------- Find: every lot on the campus ---------- */

const CAMPUS = { center: [-78.8962, 43.9463], zoom: 15.4, pitch: 50, bearing: -22 };

export async function createCampusMap(el, { lots, pos, dark, onLot }) {
  const [info, parked] = await Promise.all([campus(), noParked()]);
  const { lots: outlines, landmarks } = info;
  const data = { lots: lotFeatures(outlines, lots), landmarks, bays: bayFeatures(info, null, parked), spots: empty(), cars: empty() };
  const { map, maplibregl } = await baseMap(el, CAMPUS, dark, data);
  // Fit every lot (Founders 6 in the north to Babcock Field in the south), tilted like the campus map.
  const fit = map.cameraForBounds(boundsOf(outlines.features.map((f) => f.geometry.coordinates[0])),
    { padding: 28, bearing: CAMPUS.bearing });
  if (fit) map.jumpTo({ ...fit, zoom: Math.max(fit.zoom + 0.35, 15.1), pitch: CAMPUS.pitch, bearing: CAMPUS.bearing });
  const pins = new Map();
  let me = null;

  const placePins = (list) => {
    for (const lot of list) {
      if (pins.has(lot.id)) update(pins.get(lot.id).getElement(), lot);
      else pins.set(lot.id, new maplibregl.Marker({ element: pin(lot, onLot) }).setLngLat([lot.longitude, lot.latitude]).addTo(map));
    }
  };
  const placeMe = (p) => {
    me?.remove();
    me = null;
    if (!p) return;
    const dot = document.createElement('div');
    dot.className = 'me-dot';
    me = new maplibregl.Marker({ element: dot }).setLngLat([p.longitude, p.latitude]).addTo(map);
  };
  placePins(lots);
  placeMe(pos);
  map.on('load', () => map.getSource('lots')?.setData(data.lots));

  return {
    setLots(list) {
      data.lots = lotFeatures(outlines, list);
      map.getSource('lots')?.setData(data.lots);
      placePins(list);
      noParked().then((next) => {
        data.bays = bayFeatures(info, null, next);
        map.getSource('bay-cars')?.setData(data.bays.cars);
      });
    },
    setPosition: placeMe,
    setTheme(isDark) { map.setStyle(style(isDark, data), { diff: true }); },
    dispose() { map.remove(); },
  };
}

/* ---------- Lot: this lot's spots in place ---------- */

const empty = () => ({ type: 'FeatureCollection', features: [] });

export async function createLotMap(el, lot, spots, { dark, onPick, onLot, lots = [] }) {
  const [info, plan, parked] = await Promise.all([campus(), api.lotMap(lot.id), noParked()]);
  const { lots: outlines, landmarks } = info;
  const grid = shapes(plan);
  const data = { lots: lotFeatures(outlines, lots.length ? lots : [lot], lot.id), landmarks,
    bays: bayFeatures(info, lot.id, parked), spots: empty(), cars: empty() };
  // North up, like an aerial photo (and like the 2D and 3D views).
  const bearing = 0;
  const { map, maplibregl } = await baseMap(el, { center: [lot.longitude, lot.latitude], zoom: 17.6, pitch: 58, bearing }, dark, data);

  // Frame the whole lot's spots, tilted.
  const frameSpots = () => {
    if (!grid.bounds) return;
    const camera = map.cameraForBounds(grid.bounds, { padding: 30, bearing });
    if (camera) map.jumpTo({ ...camera, zoom: Math.min(camera.zoom + 0.2, 19.2), pitch: 58, bearing });
  };
  frameSpots();

  // Other lots get pins, so you can see where you are and hop to a neighbour.
  for (const other of lots) {
    if (other.id === lot.id) continue;
    new maplibregl.Marker({ element: pin(other, onLot) }).setLngLat([other.longitude, other.latitude]).addTo(map);
  }

  map.on('click', 'spot-fill', (event) => {
    const code = event.features?.[0]?.properties?.code;
    if (code) onPick?.(code);
  });
  map.on('mouseenter', 'spot-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'spot-fill', () => { map.getCanvas().style.cursor = ''; });

  const sync = (list, selectedId) => {
    const byCode = Object.fromEntries(list.map((s) => [s.id, s]));
    // Yours always shows green (held or reserved). Selecting a spot that isn't yours turns it dark blue.
    const state = (s) => (!s ? 'occupied' : s.mine ? 'mine' : s.id === selectedId ? 'selected' : s.status);
    data.spots = { type: 'FeatureCollection', features: grid.spots.map((f) => {
      const s = byCode[f.properties.code];
      return { ...f, properties: { code: f.properties.code, state: state(s), kind: s?.type || 'standard', sel: s?.id === selectedId } };
    }) };
    data.cars = { type: 'FeatureCollection', features: grid.cars.map((f) => {
      const s = byCode[f.properties.code];
      return { ...f, properties: { ...f.properties, parked: Boolean(s?.occupied), mine: Boolean(s?.mine && s.occupied) } };
    }) };
    push();
  };
  // Updates that arrive before the style has loaded are kept in `data` and sent once it has.
  const push = () => {
    map.getSource('spots')?.setData(data.spots);
    map.getSource('cars')?.setData(data.cars);
    map.getSource('lots')?.setData(data.lots);
  };
  map.on('load', push);
  sync(spots, null);

  return {
    sync,
    setTheme(isDark) { map.setStyle(style(isDark, data), { diff: true }); },
    recenter: frameSpots,
    dispose() { map.remove(); },
  };
}
