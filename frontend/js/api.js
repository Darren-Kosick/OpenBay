// Every call to the OpenBay server goes through here.
// The app is served from the same origin as the API (nginx routes /api and /ws to the replicas).

import { store } from './util.js';

const TOKEN = 'openbay.token';

export class ApiError extends Error {
  constructor(message, status, sessionEnded = false) {
    super(message);
    this.status = status;
    this.sessionEnded = sessionEnded;   // the token expired; the app has already gone back to sign-in
  }
}

let token = store.get(TOKEN);
let onUnauthorized = () => {};

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError("Can't reach the OpenBay server. Check your connection and try again.", 0);
  }
  api.servedBy = response.headers.get('X-Served-By') || api.servedBy;

  if (response.status === 204) return null;
  let data = null;
  try { data = await response.json(); } catch (e) { /* empty or not JSON */ }

  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : `Something went wrong (${response.status}). Try again.`;
    if (response.status === 401 && token && !path.startsWith('/api/auth/')) {
      setToken(null);
      onUnauthorized();
      throw new ApiError(detail, 401, true);
    }
    throw new ApiError(detail, response.status);
  }
  return data;
}

function setToken(value) {
  token = value;
  store.set(TOKEN, value);
}

export const api = {
  servedBy: '',
  get signedIn() { return Boolean(token); },
  onUnauthorized(fn) { onUnauthorized = fn; },
  signOut() { setToken(null); },

  // Accounts
  async register(body) { const r = await request('POST', '/api/auth/register', body); setToken(r.token); return r.user; },
  async login(email, password) { const r = await request('POST', '/api/auth/login', { email, password }); setToken(r.token); return r.user; },
  me: () => request('GET', '/api/me'),
  updateMe: (body) => request('PATCH', '/api/me', body),
  addVehicle: (vehicle) => request('POST', '/api/me/vehicles', vehicle),
  removeVehicle: (id) => request('DELETE', `/api/me/vehicles/${id}`),
  saveCard: (card) => request('PUT', '/api/me/card', card),
  removeCard: () => request('DELETE', '/api/me/card'),

  // Lots and spots
  lots: () => request('GET', '/api/lots'),
  spots: (lotId) => request('GET', `/api/lots/${encodeURIComponent(lotId)}/spots`),
  hold: (lotId, code) => request('POST', `/api/lots/${encodeURIComponent(lotId)}/spots/${encodeURIComponent(code)}/hold`),
  release: (lotId, code) => request('DELETE', `/api/lots/${encodeURIComponent(lotId)}/spots/${encodeURIComponent(code)}/hold`),

  // Reservations and violations
  reservations: () => request('GET', '/api/reservations'),
  reserve: (body) => request('POST', '/api/reservations', body),
  cancel: (id) => request('DELETE', `/api/reservations/${encodeURIComponent(id)}`),
  reportViolation: (id, body) => request('POST', `/api/reservations/${encodeURIComponent(id)}/violations`, body),
  violations: () => request('GET', '/api/violations'),

  /**
   * Live spot updates for one lot. Reconnects on its own if the connection drops
   * (for example when a replica restarts; nginx sends the next connection to another one).
   * Returns a function that closes the connection.
   */
  live(lotId, onMessage, onStatus = () => {}) {
    let socket, ping, retry, closed = false, wait = 1000;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/lots/${encodeURIComponent(lotId)}?token=${encodeURIComponent(token || '')}`;

    const connect = () => {
      socket = new WebSocket(url);
      socket.onopen = () => {
        wait = 1000;
        ping = setInterval(() => socket.readyState === 1 && socket.send('ping'), 25000);
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'hello') onStatus(true, message.instance);
          onMessage(message);
        } catch (e) { /* ignore malformed messages */ }
      };
      socket.onclose = () => {
        clearInterval(ping);
        onStatus(false);
        if (!closed) retry = setTimeout(connect, (wait = Math.min(wait * 2, 15000)));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      socket?.close();
    };
  },
};
