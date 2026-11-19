// Profile: details, vehicles, payment card, appearance and sign out.

import { esc, getAppearance, setAppearance } from '../util.js';
import { parseCard, parseVehicle } from '../validate.js';
import { cardFields, field, plateBadge, vehicleFields } from './ui.js';

const APPEARANCES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

export default {
  tab: 'profile',

  render(ctx) {
    const { state, api } = ctx;
    const u = state.user;
    const appearance = getAppearance();

    return `<div class="stack">
      <h1>Profile</h1>
      ${ctx.error()}

      <section class="card stack">
        <h2>Your details</h2>
        <form data-form="details" class="stack">
          <div class="grid2">
            ${field('Full name', 'name', `required autocomplete="name" value="${esc(u.name)}"`)}
            ${field('Phone', 'phone', `type="tel" autocomplete="tel" value="${esc(u.phone)}"`)}
          </div>
          ${field('Email', 'email', `value="${esc(u.email)}" disabled`)}
          <div><button class="btn primary" type="submit">Save details</button></div>
        </form>
      </section>

      <section class="card stack">
        <h2>Vehicles</h2>
        ${u.vehicles.length
          ? `<ul class="list">${u.vehicles.map((v) => `<li class="row between">
              <span class="row">${plateBadge(v.plate)}
                <span>${esc([v.colour, v.make, v.model].filter(Boolean).join(' '))} <span class="muted small">· ${esc(v.province)}</span></span></span>
              <button class="btn danger" data-act="remove-vehicle" data-id="${v.id}">Remove</button>
            </li>`).join('')}</ul>`
          : '<p class="muted">No vehicles yet. Add one to make a reservation.</p>'}
        <details class="add" ${u.vehicles.length ? '' : 'open'}>
          <summary class="btn">Add a vehicle</summary>
          <form data-form="vehicle" class="stack" style="margin-top:14px">
            ${vehicleFields()}
            <div><button class="btn primary" type="submit">Save vehicle</button></div>
          </form>
        </details>
      </section>

      <section class="card stack">
        <h2>Payment method</h2>
        ${u.card
          ? `<div class="row between">
               <div><strong>${esc(u.card.brand)} ···· ${esc(u.card.last4)}</strong>
                 <div class="muted small">${esc(u.card.holder)} · expires ${esc(u.card.expiry)}</div></div>
               <button class="btn danger" data-act="remove-card">Remove</button>
             </div>`
          : '<p class="muted">No payment method on file.</p>'}
        <details class="add" ${u.card ? '' : 'open'}>
          <summary class="btn">${u.card ? 'Replace card' : 'Add a card'}</summary>
          <form data-form="card" class="stack" style="margin-top:14px">
            ${cardFields()}
            <div><button class="btn primary" type="submit">Save card</button></div>
          </form>
        </details>
      </section>

      <section class="card stack">
        <h2>Appearance</h2>
        <div class="seg" role="group" aria-label="Appearance">
          ${APPEARANCES.map(([value, label]) =>
            `<button data-act="appearance" data-value="${value}" aria-pressed="${appearance === value}">${label}</button>`).join('')}
        </div>
        <p class="muted small">System follows your device's light or dark setting.</p>
      </section>

      <p class="muted small" style="text-align:center">${api.servedBy ? `Connected to server ${esc(api.servedBy)}` : ''}</p>
      <button class="btn danger block" data-act="logout">Sign out</button>
    </div>`;
  },

  forms: {
    async details(ctx, data) {
      ctx.state.user = await ctx.api.updateMe({ name: data.name, phone: data.phone });
      done(ctx, 'Details saved.');
    },
    async vehicle(ctx, data) {
      ctx.state.user = await ctx.api.addVehicle(parseVehicle(data));
      done(ctx, 'Vehicle added.');
    },
    async card(ctx, data) {
      ctx.state.user = await ctx.api.saveCard(parseCard(data));
      done(ctx, 'Card saved.');
    },
  },

  actions: {
    async 'remove-vehicle'(ctx, el) {
      ctx.state.user = await ctx.api.removeVehicle(el.dataset.id);
      done(ctx, 'Vehicle removed.');
    },
    async 'remove-card'(ctx) {
      ctx.state.user = await ctx.api.removeCard();
      done(ctx, 'Card removed.');
    },
    appearance(ctx, el) {
      setAppearance(el.dataset.value);
      ctx.render();
    },
  },
};

function done(ctx, message) {
  ctx.state.err = '';
  ctx.render();
  ctx.toast(message);
}
