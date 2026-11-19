// Small helpers shared by every screen.

export const $ = (selector, root = document) => root.querySelector(selector);

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (amount) => '$' + Number(amount).toFixed(2);

export const when = (date) =>
  new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const clock = (date) => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const timeRange = (start, end) => `${when(start)} to ${clock(end)}`;

/** Metres between two { latitude, longitude } points. */
export function distance(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const fmtDistance = (m) =>
  m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

export function toast(message) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------- storage that never throws (private mode, blocked storage) ---------- */

const memory = {};
export const store = {
  get(key) {
    try { const v = localStorage.getItem(key); if (v !== null) return v; } catch (e) { /* ignore */ }
    return memory[key] ?? null;
  },
  set(key, value) {
    memory[key] = value;
    try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  },
};

/* ---------- appearance: system / light / dark ---------- */

const APPEARANCE = 'openbay.appearance';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

export const getAppearance = () => store.get(APPEARANCE) || 'system';
export const isDark = () => document.documentElement.dataset.theme === 'dark';

function applyTheme() {
  const pref = getAppearance();
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  const before = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0f1012' : '#f2f3f5';
  if (before !== dark) listeners.forEach((fn) => fn(dark));
}

export function setAppearance(value) {
  store.set(APPEARANCE, value);
  applyTheme();
}

/** Calls fn(dark) whenever the resolved theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media.addEventListener?.('change', () => { if (getAppearance() === 'system') applyTheme(); });
applyTheme();
