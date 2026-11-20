// Find a lot: a 3D campus map, the list sorted by distance, and "which lot am I in?" from GPS.

import { createCampusMap } from '../campusmap.js';
import { distance, esc, fmtDistance, isDark, lotBadge, onThemeChange, priceLabel } from '../util.js';

const DEMO_POSITION = { latitude: 43.9468, longitude: -78.8962 };   // inside Founders 2
const IN_LOT_METRES = 150;

export default {
  tab: 'find',

  async load(ctx) {
    ctx.state.lots = await ctx.api.lots();
  },

  render(ctx) {
    return `<div class="stack">
      <h1>Find a lot</h1>
      <div id="find-top" class="stack">${top(ctx)}</div>
      <div class="campus" id="campus" aria-label="3D map of the campus parking lots"><div class="loading">Loading campus map…</div></div>
      <p class="muted small" id="find-pos">${position(ctx.state)}</p>
      <div id="lot-list" class="stack">${list(ctx)}</div>
    </div>`;
  },

  mount(ctx) {
    const { state } = ctx;
    let map = null, gone = false;
    const el = document.getElementById('campus');
    const onLot = (id) => ctx.go('lot', { lotId: id });

    createCampusMap(el, { lots: state.lots || [], pos: state.pos, dark: isDark(), onLot })
      .then((m) => { if (gone) m.dispose(); else map = m; })
      .catch(() => { if (!gone) el.innerHTML = miniMap(sorted(state), state.pos); });
    const stopTheme = onThemeChange((dark) => map?.setTheme(dark));

    // Update the screen in place, so the map keeps its camera while counts and position change.
    state.refreshFind = () => {
      if (state.view !== 'find' || !document.getElementById('lot-list')) return;
      document.getElementById('find-top').innerHTML = top(ctx);
      document.getElementById('find-pos').textContent = position(state);
      document.getElementById('lot-list').innerHTML = list(ctx);
      if (map) { map.setLots(state.lots || []); map.setPosition(state.pos); }
      else if (el.querySelector('svg.map')) el.innerHTML = miniMap(sorted(state), state.pos);
    };

    // Keep the free counts current while this screen is open.
    const timer = setInterval(async () => {
      try {
        state.lots = await ctx.api.lots();
        state.refreshFind();
      } catch (e) { /* try again next time */ }
    }, 10000);
    return () => {
      gone = true;
      clearInterval(timer);
      stopTheme();
      map?.dispose();
      state.refreshFind = null;
    };
  },

  actions: {
    open: (ctx, el) => ctx.go('lot', { lotId: el.dataset.id }),

    'demo-location'(ctx) {
      Object.assign(ctx.state, { pos: { ...DEMO_POSITION }, demoPos: true, posMsg: '' });
      redraw(ctx);
    },

    locate(ctx) {
      const { state } = ctx;
      if (!navigator.geolocation) {
        state.posMsg = 'This browser does not support location. Use the demo location instead.';
        redraw(ctx);
        return;
      }
      Object.assign(state, { locating: true, posMsg: '' });
      redraw(ctx);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          Object.assign(state, { locating: false, demoPos: false,
            pos: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy } });
          redraw(ctx);
        },
        (e) => {
          state.locating = false;
          state.posMsg = e.code === 1
            ? 'Location permission was denied. Allow it in your browser settings, or use the demo location.'
            : 'Could not get your location. Try again, or use the demo location.';
          redraw(ctx);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    },
  },
};

function redraw(ctx) {
  if (ctx.state.refreshFind) ctx.state.refreshFind();
  else if (ctx.state.view === 'find') ctx.render();
}

function sorted(state) {
  const pos = state.pos;
  return (state.lots || [])
    .map((lot) => ({ ...lot, dist: pos ? distance(pos, lot) : null }))
    .sort((a, b) => (pos ? a.dist - b.dist : 0));
}

function top(ctx) {
  const { state } = ctx;
  const pos = state.pos;
  const nearest = pos ? sorted(state)[0] : null;
  const inLot = nearest && nearest.dist < IN_LOT_METRES;
  return `<div class="row">
      <button class="btn primary" data-act="locate" ${state.locating ? 'disabled' : ''}>
        ${state.locating ? 'Locating…' : pos && !state.demoPos ? 'Update my location' : 'Use my location'}
      </button>
      <button class="btn" data-act="demo-location">Use demo location</button>
    </div>
    ${ctx.error()}
    ${state.posMsg ? `<p class="error" role="alert">${esc(state.posMsg)}</p>` : ''}
    ${inLot
      ? `<div class="card here row between">
           <div><strong>Looks like you're at ${esc(nearest.name)}.</strong>
             <div class="muted small">${nearest.free} of ${nearest.total} spots free right now</div></div>
           <button class="btn primary" data-act="open" data-id="${esc(nearest.id)}">See open spots</button>
         </div>`
      : nearest && nearest.dist > 5000
        ? `<p class="note">You're ${fmtDistance(nearest.dist)} from the nearest lot. Lots are sorted by distance from you.</p>`
        : ''}`;
}

function position(state) {
  const pos = state.pos;
  return pos
    ? `${state.demoPos ? 'Demo position' : 'Your position'}: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}${pos.accuracy ? ` (±${Math.round(pos.accuracy)} m)` : ''}`
    : 'Tap a lot on the map, or share your location to sort lots by distance.';
}

function list(ctx) {
  const pos = ctx.state.pos;
  return sorted(ctx.state).map((lot, i) => `<article class="card lot-card">
      <div>
        <h2>${esc(lot.name)} <span class="muted small">${esc(lot.id)}</span>${pos && i === 0 ? '<span class="badge">Nearest</span>' : ''}${lotBadge(lot) ? `<span class="badge permit">${lotBadge(lot)}</span>` : ''}</h2>
        <div class="muted small num">${lot.dist != null ? fmtDistance(lot.dist) + ' away · ' : ''}${priceLabel(lot)} · ${lot.free} of ${lot.total} free</div>
      </div>
      <button class="btn" data-act="open" data-id="${esc(lot.id)}">View lot</button>
      <div class="meter ${lot.free ? '' : 'full'}" role="img" aria-label="${lot.free} of ${lot.total} spots free"><b style="width:${Math.round((lot.free / Math.max(lot.total, 1)) * 100)}%"></b></div>
    </article>`).join('');
}

/** The flat fallback when the 3D map can't load. */
function miniMap(lots, pos) {
  if (!lots.length) return '';
  const showMe = pos && lots.some((l) => l.dist < 3000);
  const all = showMe ? [...lots, pos] : lots;
  const lat0 = Math.min(...all.map((p) => p.latitude)), lat1 = Math.max(...all.map((p) => p.latitude));
  const lng0 = Math.min(...all.map((p) => p.longitude)), lng1 = Math.max(...all.map((p) => p.longitude));
  const W = 320, H = 220, P = 36;
  const x = (lng) => P + ((lng - lng0) / (lng1 - lng0 || 1)) * (W - 2 * P);
  const y = (lat) => H - P - ((lat - lat0) / (lat1 - lat0 || 1)) * (H - 2 * P);
  return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the lots${showMe ? ' and your position' : ''}">
    ${lots.map((l) => `<g data-act="open" data-id="${esc(l.id)}" style="cursor:pointer"><title>${esc(l.name)}: ${l.free} of ${l.total} free</title>
      <rect x="${x(l.longitude) - 13}" y="${y(l.latitude) - 9}" width="26" height="18" rx="5" fill="${l.free ? 'var(--spot-available)' : 'var(--spot-reserved)'}"/>
      <text x="${x(l.longitude)}" y="${y(l.latitude) + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#fff">${esc(l.id)}</text>
    </g>`).join('')}
    ${showMe ? `<circle cx="${x(pos.longitude)}" cy="${y(pos.latitude)}" r="12" fill="var(--text)" opacity=".15"/>
      <circle cx="${x(pos.longitude)}" cy="${y(pos.latitude)}" r="5.5" fill="var(--text)" stroke="var(--panel)" stroke-width="2"/>` : ''}
  </svg>`;
}
