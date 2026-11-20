// One lot: the 3D (or 2D) map, live spot updates, holding a spot and confirming a reservation.

import { $, clock, esc, isDark, lotBadge, mayUse, money, onThemeChange, priceLabel, timeRange } from '../util.js';
import { lotPlan } from '../lotplan.js';
import { createPlan2D } from '../plan2d.js';
import { parseCard } from '../validate.js';
import { cardFields, errorBox, plateBadge } from './ui.js';

const TYPE_LABEL = { standard: 'Standard', accessible: 'Accessible', ev: 'EV charging' };
const HOURS = [1, 2, 3, 4, 6, 8];

let scene = null;            // the 3D view, while it is on screen
let stageKind = null;        // 'map-loading' | 'map' | '3d-loading' | '3d' | '2d'
let stageToken = 0;          // ignores a 3D view that finishes loading after the screen changed

// One random key per attempt to pay. Resending the same attempt (after a dropped connection) reuses it,
// so the server answers with the first result instead of charging again.
const newKey = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

const withDeadline = (s) => ({ ...s, deadline: s.held_ms != null ? Date.now() + s.held_ms : null });
const myHold = (state) => state.spots.find((s) => s.status === 'held' && s.mine);
const freeUp = (s) => Object.assign(s, { status: s.occupied ? 'occupied' : 'available', mine: false, deadline: null, held_ms: null });

function upsert(state, spot) {
  const i = state.spots.findIndex((s) => s.id === spot.id);
  if (i >= 0) state.spots[i] = withDeadline(spot);
}

export default {
  tab: 'find',

  async load(ctx) {
    const { state, api } = ctx;
    if (!state.lots?.length) state.lots = await api.lots();
    state.lot = state.lots.find((l) => l.id === state.lotId);
    if (!state.lot) throw new Error('That lot no longer exists.');
    state.spots = (await api.spots(state.lot.id)).map(withDeadline);
    Object.assign(state, { sel: null, notice: '', live: { on: false, via: '' } });
    state.mode ??= 'map';
    state.hours ??= 2;
  },

  render(ctx) {
    const { state } = ctx;
    if (!state.lot) {
      return `<div class="stack">${ctx.error()}<button class="btn" data-act="nav" data-view="find">Back to lots</button></div>`;
    }
    return `<div class="stack">
      <div>
        <button class="btn link" data-act="nav" data-view="find">← All lots</button>
        <h1 style="margin-top:8px">${esc(state.lot.name)}</h1>
        <p class="muted small num"><span id="counts"></span> · ${esc(priceLabel(state.lot))}${lotBadge(state.lot) ? ` <span class="badge permit">${lotBadge(state.lot)}</span>` : ''}</p>
      </div>
      <div class="row between">
        <span id="live" class="live">Connecting…</span>
        <div class="seg" role="group" aria-label="Map view">
          <button data-act="mode" data-mode="map" aria-pressed="${state.mode === 'map'}">Map</button>
          <button data-act="mode" data-mode="3d" aria-pressed="${state.mode === '3d'}">3D</button>
          <button data-act="mode" data-mode="2d" aria-pressed="${state.mode === '2d'}">2D</button>
        </div>
      </div>
      <div class="stage" id="stage"></div>
      <div class="legend">
        <span><i style="background:var(--spot-available)"></i>Available</span>
        <span><i style="background:var(--spot-reserved)"></i>Reserved</span>
        <span><i style="background:var(--spot-occupied)"></i>Occupied</span>
        <span><i style="background:var(--spot-mine)"></i>Yours</span>
        <span><i style="background:var(--spot-selected)"></i>Selected</span>
        <span><i class="dot" style="background:var(--spot-accessible)"></i>Accessible</span>
        <span><i class="dot" style="background:var(--spot-ev)"></i>EV</span>
      </div>
      <p class="muted small" id="hint"></p>
      <p class="note" id="notice" hidden></p>
      <section class="card" id="panel" aria-live="polite"></section>
    </div>`;
  },

  mount(ctx) {
    const { state, api } = ctx;
    if (!state.lot) return undefined;

    mountStage(ctx);
    const closeLive = api.live(
      state.lot.id,
      (message) => {
        if (message.type !== 'spot') return;
        upsert(state, message.spot);
        state.live.via = message.origin;
        refresh(ctx, false);
      },
      (on, instance) => {
        state.live.on = on;
        if (instance) state.live.connected = instance;
        liveLabel(state);
      },
    );
    const timer = setInterval(() => tick(ctx), 500);
    const stopTheme = onThemeChange((dark) => scene?.setTheme(dark));

    return () => {
      closeLive();
      clearInterval(timer);
      stopTheme();
      unmountStage();
      const held = myHold(state);
      if (held) api.release(state.lot.id, held.id).catch(() => {});
    };
  },

  actions: {
    pick: (ctx, el) => pick(ctx, el.dataset.id),

    mode(ctx, el) {
      if (ctx.state.mode === el.dataset.mode) return;
      ctx.state.mode = el.dataset.mode;
      document.querySelectorAll('[data-act="mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === ctx.state.mode)));
      mountStage(ctx);
    },

    async hold(ctx) {
      const { state, api } = ctx;
      try {
        upsert(state, await api.hold(state.lot.id, state.sel));
        Object.assign(state, { err: '', notice: '' });
      } catch (error) {
        state.err = error.message;
        if (error.status === 409) state.spots = (await api.spots(state.lot.id)).map(withDeadline);
      }
      refresh(ctx);
    },

    async release(ctx) {
      const { state, api } = ctx;
      const held = myHold(state);
      if (held) {
        freeUp(held);
        await api.release(state.lot.id, held.id).catch(() => {});
      }
      Object.assign(state, { sel: null, err: '' });
      refresh(ctx);
    },

    hours(ctx, el) {
      ctx.state.hours = Number(el.value);
      if (!ctx.state.lot.hourly_rate) return;              // permit lots: nothing to pay
      const amount = money(ctx.state.lot.hourly_rate * ctx.state.hours);
      const total = $('#total');
      if (total) total.textContent = amount;
      const pay = $('#pay');
      if (pay && !pay.disabled) pay.textContent = `Pay ${amount} and reserve`;
    },

    plate(ctx, el) {
      ctx.state.plate = el.value;
    },

    'swap-card'(ctx) {
      ctx.openModal(`<form data-form="card" class="stack" novalidate>
        <h2>Use another card</h2>
        <p class="muted small">Your spot stays held while you do this. The card replaces the one in your profile.</p>
        ${cardFields()}
        <div class="grid2">
          <button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="submit" class="btn primary">Save card</button>
        </div>
      </form>`);
    },
  },

  forms: {
    async reserve(ctx, data, form) {
      const { state, api } = ctx;
      state.payKey ??= newKey();
      const pay = form.querySelector('#pay');
      if (pay) pay.textContent = state.lot.hourly_rate ? 'Processing payment…' : 'Reserving…';
      try {
        const reservation = await api.reserve({
          lot_id: state.lot.id, spot: state.sel, plate: data.plate, hours: Number(data.hours), payment_key: state.payKey,
        });
        const spot = state.spots.find((s) => s.id === state.sel);
        if (spot) Object.assign(spot, { status: 'reserved', mine: true, deadline: null, held_ms: null });
        Object.assign(state, { err: '', declined: false, payKey: null });
        refresh(ctx);
        ctx.openModal(confirmation(reservation));
      } catch (error) {
        if (error.status !== 0) state.payKey = null;     // the server answered, so the next tap is a new attempt
        state.err = error.message;
        state.declined = error.status === 402;
        if (error.status === 409) state.spots = (await api.spots(state.lot.id)).map(withDeadline);
        refresh(ctx);
      }
    },

    async card(ctx, data) {
      ctx.state.user = await ctx.api.saveCard(parseCard(data));
      Object.assign(ctx.state, { err: '', declined: false });
      ctx.closeModal();
      refresh(ctx);
      ctx.toast('Card saved. Try paying again.');
    },
  },
};

/* ---------- the map area ---------- */

function unmountStage() {
  stageToken += 1;
  scene?.dispose();
  scene = null;
  stageKind = null;
}

function mountStage(ctx) {
  const { state } = ctx;
  unmountStage();
  const stage = $('#stage');
  const token = stageToken;

  if (state.mode === 'map') {
    stageKind = 'map-loading';
    stage.innerHTML = '<div class="loading">Loading campus map…</div>';
    import('../campusmap.js')
      .then(({ createLotMap }) => createLotMap(stage, state.lot, state.spots, {
        dark: isDark(), lots: state.lots || [],
        onPick: (id) => pick(ctx, id),
        onLot: (id) => ctx.go('lot', { lotId: id }),
      }))
      .then((map) => {
        if (token !== stageToken) { map.dispose(); return; }
        scene = map;
        stageKind = 'map';
        refresh(ctx, false);
      })
      .catch(() => {
        if (token !== stageToken) return;
        state.mode = '3d';
        state.notice = 'The campus map could not load, so the lot is shown in 3D.';
        document.querySelectorAll('[data-act="mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === '3d')));
        mountStage(ctx);
      });
  } else if (state.mode === '3d') {
    stageKind = '3d-loading';
    stage.innerHTML = '<div class="loading">Loading 3D view…</div>';
    Promise.all([import('../lot3d.js'), lotPlan(state.lot.id)])
      .then(([{ createLot3D }, plan]) => {
        if (token !== stageToken) return;
        scene = createLot3D(stage, plan, state.spots, { dark: isDark(), onPick: (id) => pick(ctx, id) });
        stageKind = '3d';
        refresh(ctx, false);
      })
      .catch(() => {
        if (token !== stageToken) return;
        state.mode = '2d';
        state.notice = 'The 3D view could not load on this device, so the lot is shown in 2D.';
        document.querySelectorAll('[data-act="mode"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === '2d')));
        mountStage(ctx);
      });
  } else {
    stageKind = '2d-loading';
    stage.innerHTML = '<div class="loading">Loading plan…</div>';
    lotPlan(state.lot.id)
      .then((plan) => {
        if (token !== stageToken) return;
        scene = createPlan2D(stage, plan, state.spots, { onPick: (id) => pick(ctx, id) });
        stageKind = '2d';
        refresh(ctx, false);
      })
      .catch(() => {
        if (token !== stageToken) return;
        stageKind = 'grid';                       // last resort: a simple grid of buttons
        refresh(ctx);
      });
  }
  refresh(ctx);
}

function grid(state) {
  const { lot, spots, sel } = state;
  let html = '<div class="flat">';
  for (let r = 0; r < lot.rows; r++) {
    if (r % 2 === 1) html += '<div class="aisle">AISLE</div>';
    // Rows follow the lot's real shape, so they can be short or have gaps: place each spot in its own column.
    html += `<div class="r" style="grid-template-columns:repeat(${lot.cols},minmax(34px,1fr))">`;
    html += spots.filter((s) => s.row === r).map((s) => {
      const label = s.mine ? 'yours' : s.status;
      return `<button class="sp ${s.mine ? 'mine' : s.status} ${s.id === sel ? 'sel' : ''}" data-act="pick" data-id="${esc(s.id)}"
        style="grid-column:${s.col + 1}" aria-label="Spot ${esc(s.id)}, ${TYPE_LABEL[s.type]}, ${label}">${esc(s.id)}</button>`;
    }).join('');
    html += '</div>';
  }
  return html + '</div>';
}

/* ---------- keeping the screen current ---------- */

function refresh(ctx, rebuildPanel = true) {
  const { state } = ctx;
  if (state.view !== 'lot' || !$('#panel')) return;

  const free = state.spots.filter((s) => s.status === 'available').length;
  $('#counts').textContent = `${free} of ${state.spots.length} spots free`;
  $('#hint').textContent = state.mode === 'map'
    ? 'Every spot in the lot, in place on campus. Drag to pan, right-drag or two fingers to tilt and turn, tap a spot to select it.'
    : state.mode === '3d'
      ? 'Drag to rotate, pinch or scroll to zoom, tap a spot to select it.'
      : 'Drag to pan, pinch or scroll to zoom, tap a spot to select it.';
  const notice = $('#notice');
  notice.hidden = !state.notice;
  notice.textContent = state.notice || '';

  if (stageKind === '3d' || stageKind === 'map' || stageKind === '2d') scene.sync(state.spots, state.sel);
  else if (stageKind === 'grid') $('#stage').innerHTML = grid(state);

  // Don't rebuild the confirm form under the driver while they are filling it in.
  const selected = state.spots.find((s) => s.id === state.sel);
  const filling = selected && selected.status === 'held' && selected.mine;
  if (rebuildPanel || !filling) {
    $('#panel').innerHTML = panel(ctx);
    tick(ctx);
  }
  liveLabel(state);
}

function liveLabel(state) {
  const el = $('#live');
  if (!el) return;
  el.classList.toggle('on', state.live.on);
  el.textContent = !state.live.on
    ? 'Reconnecting…'
    : state.live.via
      ? `Live · last update from ${state.live.via}`
      : `Live · connected to ${state.live.connected || 'server'}`;
}

function tick(ctx) {
  const { state } = ctx;
  const now = Date.now();
  let changed = false;
  for (const s of state.spots) {
    if (s.status === 'held' && s.deadline && s.deadline <= now) {
      if (s.mine) state.notice = 'Your hold expired. Tap the spot to hold it again.';
      freeUp(s);
      changed = true;
    }
  }
  if (changed) refresh(ctx);

  const held = myHold(state);
  const timer = $('#timer');
  if (held && timer) {
    const seconds = Math.max(0, Math.ceil((held.deadline - now) / 1000));
    timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
}

function pick(ctx, id) {
  const { state, api } = ctx;
  const held = myHold(state);
  if (held && held.id !== id) {                       // choosing another spot gives up the current hold
    freeUp(held);
    api.release(state.lot.id, held.id).catch(() => {});
  }
  Object.assign(state, { sel: id, err: '', notice: '', declined: false });
  refresh(ctx);
}

/* ---------- the panel under the map ---------- */

function panel(ctx) {
  const { state } = ctx;
  const s = state.spots.find((x) => x.id === state.sel);
  if (!s) {
    return `<div class="stack"><h2>Pick a spot</h2>
      <p class="muted">Blue spots are open. Selecting one lets you hold it for two minutes while you confirm.</p></div>`;
  }
  const head = `<div class="row between"><h2>Spot ${esc(s.id)}</h2><span class="muted small">${TYPE_LABEL[s.type]}</span></div>`;

  if (s.status === 'available' && !mayUse(state.user, state.lot)) {
    return `<div class="stack">${head}
      <dl class="kv"><dt>Status</dt><dd>Available</dd><dt>Who can park</dt><dd>${state.lot.access === 'employees' ? 'Employee permit holders' : 'Parking permit holders'}</dd></dl>
      <p class="note">${state.lot.access === 'employees'
        ? 'This is a staff lot. Add your employee permit in your profile to book here for free.'
        : 'This lot is for campus parking permit holders. Add your permit in your profile to book here for free.'}</p>
      <button class="btn primary block" data-act="nav" data-view="profile">Add a permit</button></div>`;
  }

  if (s.status === 'available') {
    return `<div class="stack">${head}
      <dl class="kv"><dt>Rate</dt><dd class="num">${esc(priceLabel(state.lot))}</dd><dt>Status</dt><dd>Available</dd></dl>
      ${s.type === 'accessible' ? '<p class="note">Accessible permit required.</p>' : ''}
      ${s.type === 'ev' ? '<p class="note">For vehicles that are charging.</p>' : ''}
      ${errorBox(state.err)}
      <button class="btn primary block" data-act="hold">Hold this spot</button></div>`;
  }

  if (s.status === 'held' && s.mine) {
    const user = state.user;
    const vehicles = user.vehicles || [];
    const free = !state.lot.hourly_rate;                 // permit lots: the permit covers it
    const ready = vehicles.length > 0 && (user.card || free);
    const plate = vehicles.some((v) => v.plate === state.plate) ? state.plate : vehicles[0]?.plate;
    return `<div class="stack">${head}
      <div><div class="muted small">Held for you</div><div class="count num" id="timer">2:00</div></div>
      ${errorBox(state.err)}
      ${vehicles.length ? '' : '<p class="note">Add a vehicle in your profile to reserve.</p>'}
      ${user.card || free ? '' : '<p class="note">Add a payment method in your profile to reserve.</p>'}
      <form data-form="reserve" class="stack">
        <label class="field"><span>Vehicle</span>
          <select name="plate" data-change="plate" ${vehicles.length ? '' : 'disabled'}>
            ${vehicles.map((v) => `<option value="${esc(v.plate)}" ${v.plate === plate ? 'selected' : ''}>${esc(v.plate)} · ${esc(v.make)} ${esc(v.model)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Duration</span>
          <select name="hours" data-change="hours">
            ${HOURS.map((h) => `<option value="${h}" ${h === state.hours ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}
          </select></label>
        <dl class="kv">
          ${free
            ? `<dt>Total</dt><dd><strong>Included with your permit</strong></dd>`
            : `<dt>Total</dt><dd class="num"><strong id="total">${money(state.lot.hourly_rate * state.hours)}</strong></dd>
               ${user.card ? `<dt>Pay with</dt><dd>${esc(user.card.brand)} ···· ${esc(user.card.last4)}</dd>` : ''}`}
        </dl>
        <button class="btn primary block" id="pay" type="submit" ${ready ? '' : 'disabled'}>${free ? 'Reserve' : `Pay ${money(state.lot.hourly_rate * state.hours)} and reserve`}</button>
        ${user.card && !free ? '<p class="muted small" style="text-align:center">Free cancellation for 5 minutes, then unused hours are refunded.</p>' : ''}
      </form>
      ${state.declined ? '<button class="btn block" data-act="swap-card">Use another card</button>' : ''}
      ${ready ? '' : '<button class="btn block" data-act="nav" data-view="profile">Go to profile</button>'}
      <button class="btn ghost block" data-act="release">Release spot</button></div>`;
  }

  if (s.status === 'reserved' && s.mine) {
    return `<div class="stack">${head}<p>This is your reservation.</p>
      <button class="btn block" data-act="nav" data-view="reservations">View reservations</button></div>`;
  }

  return `<div class="stack">${head}
    <p class="muted">${s.status === 'occupied'
      ? 'A vehicle is parked here.'
      : 'Someone else has this spot reserved or on hold.'} Pick a blue spot instead.</p></div>`;
}

function confirmation(r) {
  return `<div class="stack">
    <div class="hero"><div class="icon ok" aria-hidden="true">✓</div>
      <h2>Reservation confirmed</h2>
      <p class="muted" style="margin-top:4px">Spot ${esc(r.spot)} · ${esc(r.lot_name)}</p></div>
    <div style="text-align:center">${plateBadge(r.plate)}</div>
    <dl class="kv card" style="padding:14px">
      <dt>When</dt><dd>${esc(timeRange(r.start, r.end))}</dd>
      <dt>Leave by</dt><dd>${esc(clock(r.end))}</dd>
      <dt>Charged</dt><dd class="num">${r.total ? `${money(r.total)}${r.card ? ` to ${esc(r.card)}` : ''}` : 'Nothing: included with your permit'}</dd>
      <dt>Reference</dt><dd>${esc(r.id)}</dd>
    </dl>
    <p class="muted small">Park only in your reserved spot. If another vehicle is in it, report it from the Reservations tab and you'll be moved to a free spot.</p>
    <div class="grid2">
      <button class="btn" data-act="nav" data-view="reservations">View reservations</button>
      <button class="btn primary" data-act="close-modal">Done</button>
    </div>
  </div>`;
}
