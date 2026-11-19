// App shell: routing between screens, shared state, and event handling.
//
// Each screen in js/views/ exports an object with:
//   render(ctx)  -> HTML for <main>
//   load(ctx)    -> optional, fetches data before rendering
//   mount(ctx)   -> optional, runs after rendering; may return a cleanup function
//   actions      -> click / change handlers, matched by data-act="name"
//   forms        -> submit handlers, matched by data-form="name"

import { api } from './api.js';
import { esc, toast } from './util.js';
import { icon } from './views/ui.js';
import { login, signup } from './views/auth.js';
import find from './views/find.js';
import lot from './views/lot.js';
import reservations from './views/reservations.js';
import guide from './views/guide.js';
import profile from './views/profile.js';

const views = { login, signup, find, lot, reservations, guide, profile };
const TABS = [['find', 'Find'], ['reservations', 'Reservations'], ['guide', 'Guide'], ['profile', 'Profile']];

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const state = { view: null, user: null, err: '' };
let cleanup = null;
let navigation = 0;

const ctx = {
  state,
  api,
  toast,
  go,
  render,
  error: () => (state.err ? `<p class="error" role="alert">${esc(state.err)}</p>` : ''),
  fail(error) {
    state.err = error?.message || 'Something went wrong. Try again.';
    render();
  },
  openModal(html) {
    modalRoot.innerHTML = `<div class="overlay" data-act="overlay"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
    modalRoot.querySelector('.sheet input, .sheet button')?.focus({ preventScroll: true });
  },
  closeModal() {
    modalRoot.innerHTML = '';
  },
};

async function go(view, extra = {}) {
  const id = ++navigation;
  if (views[view]?.public !== true && !state.user) view = 'login';
  ctx.closeModal();
  Object.assign(state, { err: '' }, extra, { view });
  try {
    await views[view].load?.(ctx);
  } catch (error) {
    if (error.sessionEnded) return;            // onUnauthorized already sent us to sign-in
    state.err = error.message;
  }
  if (id !== navigation) return;               // the driver moved on while this screen was loading
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (cleanup) {
    try { cleanup(); } catch (e) { /* ignore */ }
    cleanup = null;
  }
  const view = views[state.view];
  const tabs = state.user
    ? `<nav class="tabs" aria-label="Main">${TABS.map(([id, label]) =>
        `<button class="tab" data-act="nav" data-view="${id}" ${view.tab === id ? 'aria-current="page"' : ''}>${icon(id)}${label}</button>`).join('')}</nav>`
    : '';
  app.innerHTML = `
    <header class="bar"><div class="brand"><i>O</i>OpenBay</div></header>
    <main id="main">${view.render(ctx)}</main>
    ${tabs}`;
  cleanup = view.mount?.(ctx) || null;
}

async function run(handler, ...args) {
  try {
    await handler(ctx, ...args);
  } catch (error) {
    if (!error.sessionEnded) ctx.fail(error);
  }
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'overlay') { if (event.target === el) ctx.closeModal(); return; }
  if (act === 'close-modal') { ctx.closeModal(); return; }
  if (act === 'nav') { go(el.dataset.view); return; }
  if (act === 'logout') { api.signOut(); state.user = null; go('login'); return; }

  const handler = views[state.view]?.actions?.[act];
  if (handler) {
    event.preventDefault();
    run(handler, el, event);
  }
});

document.addEventListener('change', (event) => {
  const el = event.target.closest('[data-change]');
  const handler = el && views[state.view]?.actions?.[el.dataset.change];
  if (handler) run(handler, el, event);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const handler = views[state.view]?.forms?.[form.dataset.form];
  if (!handler) return;

  // Stop double taps from sending the same request twice.
  const button = form.querySelector('button[type="submit"], button:not([type])');
  const wasDisabled = button?.disabled;
  if (button) button.disabled = true;
  try {
    await handler(ctx, Object.fromEntries(new FormData(form)), form);
  } catch (error) {
    // Show the problem inside the form, so what the driver typed stays where it is.
    if (!error.sessionEnded && form.isConnected) showFormError(form, error.message || 'Something went wrong. Try again.');
  } finally {
    if (button?.isConnected && !wasDisabled) button.disabled = false;
  }
});

function showFormError(form, message) {
  let box = form.querySelector(':scope > .error[data-form-error]');
  if (!box) {
    box = document.createElement('p');
    box.className = 'error';
    box.setAttribute('role', 'alert');
    box.dataset.formError = '';
    form.prepend(box);
  }
  box.textContent = message;
  box.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalRoot.firstChild) ctx.closeModal();
});

api.onUnauthorized(() => {
  state.user = null;
  go('login', { err: 'Your session has ended. Sign in again.' });
});

async function boot() {
  let err = '';
  if (api.signedIn) {
    try {
      state.user = await api.me();
    } catch (error) {
      if (error.sessionEnded) return;          // onUnauthorized shows the sign-in screen
      err = error.message;
    }
  }
  await go(state.user ? 'find' : 'login', err ? { err } : {});
}

boot();
