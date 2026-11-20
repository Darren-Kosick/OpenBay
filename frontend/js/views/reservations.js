// Reservations: active and past, cancelling, and reporting a vehicle in your spot.

import { esc, money, timeRange, when } from '../util.js';
import { errorBox, field, plateBadge } from './ui.js';

const find = (state, id) => (state.res || []).find((r) => r.id === id);

export default {
  tab: 'reservations',

  async load(ctx) {
    [ctx.state.res, ctx.state.reports] = await Promise.all([ctx.api.reservations(), ctx.api.violations()]);
  },

  render(ctx) {
    const res = ctx.state.res || [];
    const reports = ctx.state.reports || [];
    const active = res.filter((r) => r.active);
    const past = res.filter((r) => !r.active);

    const item = (r) => `<li class="stack">
      <div class="row between">
        <strong>${esc(r.lot_name)} · Spot ${esc(r.spot)}</strong>
        ${plateBadge(r.plate)}
      </div>
      <p class="muted small num">${esc(timeRange(r.start, r.end))} · ${status(r)}</p>
      <p class="small num">${r.total ? `Paid ${money(r.total)}${r.card ? ` · ${esc(r.card)}` : ''}` : 'Included with your permit'}${r.refunded > 0 ? ` · <span class="refund">${money(r.refunded)} refunded</span>` : ''}</p>
      ${r.moved_from ? `<p class="moved">Moved from ${esc(r.moved_from)} after a violation report</p>` : ''}
      ${r.active ? `<div class="row">
          <button class="btn" data-act="report" data-id="${esc(r.id)}">Someone is in my spot</button>
          <button class="btn danger" data-act="ask-cancel" data-id="${esc(r.id)}">Cancel</button>
        </div>` : ''}
    </li>`;

    return `<div class="stack">
      <h1>Reservations</h1>
      ${ctx.error()}
      <section class="card stack">
        <h2>Active</h2>
        ${active.length
          ? `<ul class="list">${active.map(item).join('')}</ul>`
          : '<p class="muted">No active reservations.</p><div><button class="btn primary" data-act="nav" data-view="find">Find a lot</button></div>'}
      </section>
      ${past.length ? `<section class="card stack"><h2>History</h2><ul class="list">${past.map(item).join('')}</ul></section>` : ''}
      ${reports.length ? `<section class="card stack"><h2>Violation reports</h2><ul class="list">
          ${reports.map((v) => `<li>
            <strong>${esc(v.lot_name)} · Spot ${esc(v.spot)}</strong>
            <p class="muted small">${esc(when(v.created_at))}${v.offender_plate ? ` · reported plate ${esc(v.offender_plate)}` : ''}</p>
            <p class="small">${esc(v.outcome)}</p>
          </li>`).join('')}
        </ul></section>` : ''}
    </div>`;
  },

  actions: {
    report(ctx, el) {
      const r = find(ctx.state, el.dataset.id);
      if (!r) return;
      ctx.openModal(`<form data-form="violation" class="stack" novalidate>
        <input type="hidden" name="id" value="${esc(r.id)}">
        <h2>Report a violation</h2>
        <p class="muted">Use this when another vehicle is parked in <strong>${esc(r.lot_name)} · Spot ${esc(r.spot)}</strong>, which you reserved.</p>
        ${field('Their licence plate (optional)', 'offender_plate', 'class="plate-input" maxlength="10" autocomplete="off" autocapitalize="characters"')}
        <label class="field"><span>Anything else we should know (optional)</span><textarea name="note" maxlength="500" rows="3"></textarea></label>
        <p class="note">We'll move your reservation to the closest free spot at no extra charge. If this lot is full, you'll get a spot in the nearest lot with space. Don't confront the driver or block them in.</p>
        <div class="form-error"></div>
        <div class="grid2">
          <button type="button" class="btn" data-act="close-modal">Cancel</button>
          <button type="submit" class="btn primary">Report and move me</button>
        </div>
      </form>`);
    },

    'ask-cancel'(ctx, el) {
      const r = find(ctx.state, el.dataset.id);
      if (!r) return;
      ctx.openModal(`<div class="stack">
        <h2>Cancel this reservation?</h2>
        <p class="muted">${esc(r.lot_name)} · Spot ${esc(r.spot)} will be released for other drivers.</p>
        ${r.total ? `<dl class="kv card" style="padding:14px">
          <dt>Paid</dt><dd class="num">${money(r.total)}</dd>
          <dt>Refund</dt><dd class="num"><strong>${money(r.refundable)}</strong>${r.card && r.refundable > 0 ? ` to ${esc(r.card)}` : ''}</dd>
        </dl>
        <p class="muted small">${r.refundable >= r.total
          ? 'You booked in the last 5 minutes, so you get everything back.'
          : r.refundable > 0 ? 'Refunds cover the whole hours you have not used yet.' : 'Less than an hour is left, so there is nothing to refund.'}</p>` : ''}
        <div class="grid2">
          <button class="btn" data-act="close-modal">Keep it</button>
          <button class="btn primary" data-act="cancel" data-id="${esc(r.id)}">Cancel reservation</button>
        </div>
      </div>`);
    },

    async cancel(ctx, el) {
      const r = await ctx.api.cancel(el.dataset.id);
      await ctx.go('reservations');
      ctx.toast(r.refunded > 0 ? `Reservation cancelled. ${money(r.refunded)} refunded.` : 'Reservation cancelled.');
    },

    done: (ctx) => ctx.go('reservations'),
  },

  forms: {
    async violation(ctx, data, form) {
      try {
        const result = await ctx.api.reportViolation(data.id, { offender_plate: data.offender_plate, note: data.note });
        ctx.openModal(outcome(result));
      } catch (error) {
        if (error.sessionEnded) throw error;
        form.querySelector('.form-error').innerHTML = errorBox(error.message);
      }
    },
  },
};

function status(r) {
  if (r.status === 'cancelled') return 'Cancelled';
  return r.active ? 'Active' : 'Completed';
}

function outcome({ outcome: kind, reservation: r }) {
  if (kind === 'moved') {
    return `<div class="stack">
      <div class="hero"><div class="icon info" aria-hidden="true">⇄</div><h2>You've been moved</h2></div>
      <p style="text-align:center">Your new spot is</p>
      <h2 style="text-align:center">Spot ${esc(r.spot)} · ${esc(r.lot_name)}</h2>
      <p class="muted small" style="text-align:center">Your end time and price stay the same. The report has been sent to the lot operator.</p>
      <button class="btn primary block" data-act="done">Done</button>
    </div>`;
  }
  return `<div class="stack">
    <div class="hero"><div class="icon warn" aria-hidden="true">!</div><h2>No free spots right now</h2></div>
    <p class="muted" style="text-align:center">Every lot is full, so your reservation was cancelled and ${money(r.refunded)} was refunded${r.card ? ` to ${esc(r.card)}` : ''}. The report has been sent to the lot operator.</p>
    <button class="btn primary block" data-act="done">Done</button>
  </div>`;
}
