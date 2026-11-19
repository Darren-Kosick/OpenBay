// Find a lot: list sorted by distance, a small map, and "which lot am I in?" from GPS.

import { distance, esc, fmtDistance, money } from '../util.js';

const DEMO_POSITION = { latitude: 43.9450, longitude: -78.8964 };   // inside Library Lot B
const IN_LOT_METRES = 150;

export default {
  tab: 'find',

  async load(ctx) {
    ctx.state.lots = await ctx.api.lots();
  },

  render(ctx) {
    const { state } = ctx;
    const pos = state.pos;
    const lots = (state.lots || [])
      .map((lot) => ({ ...lot, dist: pos ? distance(pos, lot) : null }))
      .sort((a, b) => (pos ? a.dist - b.dist : 0));
    const nearest = pos ? lots[0] : null;
    const inLot = nearest && nearest.dist < IN_LOT_METRES;

    return `<div class="stack">
      <h1>Find a lot</h1>
      <div class="row">
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
          : ''}

      ${lots.map((lot, i) => `<article class="card lot-card">
          <div>
            <h2>${esc(lot.name)}${pos && i === 0 ? '<span class="badge">Nearest</span>' : ''}</h2>
            <div class="muted small num">${lot.dist != null ? fmtDistance(lot.dist) + ' away · ' : ''}${money(lot.hourly_rate)}/h · ${lot.free} of ${lot.total} free</div>
          </div>
          <button class="btn" data-act="open" data-id="${esc(lot.id)}">View lot</button>
          <div class="meter ${lot.free ? '' : 'full'}" role="img" aria-label="${lot.free} of ${lot.total} spots free"><b style="width:${Math.round((lot.free / Math.max(lot.total, 1)) * 100)}%"></b></div>
        </article>`).join('')}

      <section class="card stack">
        <h3>Map</h3>
        ${miniMap(lots, pos)}
        <p class="muted small">${pos
          ? `${state.demoPos ? 'Demo position' : 'Your position'}: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}${pos.accuracy ? ` (±${Math.round(pos.accuracy)} m)` : ''}`
          : 'Share your location to sort lots by distance and detect the lot you are in.'}</p>
      </section>
    </div>`;
  },

  mount(ctx) {
    // Keep the free counts current while this screen is open.
    const timer = setInterval(async () => {
      try {
        ctx.state.lots = await ctx.api.lots();
        if (ctx.state.view === 'find' && !document.querySelector('.overlay')) ctx.render();
      } catch (e) { /* try again next time */ }
    }, 10000);
    return () => clearInterval(timer);
  },

  actions: {
    open: (ctx, el) => ctx.go('lot', { lotId: el.dataset.id }),

    'demo-location'(ctx) {
      Object.assign(ctx.state, { pos: { ...DEMO_POSITION }, demoPos: true, posMsg: '' });
      ctx.render();
    },

    locate(ctx) {
      const { state } = ctx;
      if (!navigator.geolocation) {
        state.posMsg = 'This browser does not support location. Use the demo location instead.';
        ctx.render();
        return;
      }
      Object.assign(state, { locating: true, posMsg: '' });
      ctx.render();
      navigator.geolocation.getCurrentPosition(
        (p) => {
          Object.assign(state, { locating: false, demoPos: false,
            pos: { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy } });
          if (state.view === 'find') ctx.render();
        },
        (e) => {
          state.locating = false;
          state.posMsg = e.code === 1
            ? 'Location permission was denied. Allow it in your browser settings, or use the demo location.'
            : 'Could not get your location. Try again, or use the demo location.';
          if (state.view === 'find') ctx.render();
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    },
  },
};

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
    ${lots.map((l) => `<g>
      <rect x="${x(l.longitude) - 10}" y="${y(l.latitude) - 10}" width="20" height="20" rx="5" fill="${l.free ? 'var(--spot-available)' : 'var(--spot-reserved)'}"/>
      <text x="${x(l.longitude)}" y="${y(l.latitude) + 4.5}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">P</text>
      <text class="lot-label" x="${x(l.longitude)}" y="${y(l.latitude) + 25}" text-anchor="middle" font-size="10">${esc(l.name)}</text>
    </g>`).join('')}
    ${showMe ? `<circle cx="${x(pos.longitude)}" cy="${y(pos.latitude)}" r="12" fill="var(--text)" opacity=".15"/>
      <circle cx="${x(pos.longitude)}" cy="${y(pos.latitude)}" r="5.5" fill="var(--text)" stroke="var(--panel)" stroke-width="2"/>` : ''}
  </svg>`;
}
