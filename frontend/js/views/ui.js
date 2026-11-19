// Markup pieces shared by several screens.

import { esc } from '../util.js';
import { PROVINCES } from '../validate.js';

export const field = (label, name, attrs = '', hint = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`;

export const plateBadge = (plate) => `<span class="plate" aria-label="Licence plate ${esc(plate)}">${esc(plate)}</span>`;

export const errorBox = (message) => (message ? `<p class="error" role="alert">${esc(message)}</p>` : '');

export function vehicleFields(v = {}) {
  return `<div class="grid2">
    ${field('Licence plate', 'plate', `class="plate-input" maxlength="10" autocomplete="off" autocapitalize="characters" required value="${esc(v.plate || '')}"`, 'As shown on the plate.')}
    <label class="field"><span>Province</span><select name="province">
      ${PROVINCES.map((p) => `<option ${p === (v.province || 'ON') ? 'selected' : ''}>${p}</option>`).join('')}
    </select></label>
    ${field('Make', 'make', `required value="${esc(v.make || '')}"`)}
    ${field('Model', 'model', `value="${esc(v.model || '')}"`)}
    ${field('Colour', 'colour', `value="${esc(v.colour || '')}"`)}
  </div>`;
}

export const CARD_NOTE =
  'Demo payments only: nothing is charged. Use the test card 4242 4242 4242 4242 with any future expiry. Only the brand and last four digits are sent to the server.';

export function cardFields() {
  return `<p class="note">${CARD_NOTE}</p>
    ${field('Name on card', 'holder', 'autocomplete="cc-name" required')}
    ${field('Card number', 'number', 'inputmode="numeric" autocomplete="cc-number" maxlength="23" required')}
    <div class="grid2">
      ${field('Expiry (MM/YY)', 'expiry', 'inputmode="numeric" autocomplete="cc-exp" maxlength="7" placeholder="MM/YY" required')}
      ${field('Security code', 'cvc', 'inputmode="numeric" autocomplete="cc-csc" maxlength="4" required')}
    </div>`;
}

const PATHS = {
  find: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  reservations: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  guide: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  parking: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3H3z"/><circle cx="7.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
};

export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
