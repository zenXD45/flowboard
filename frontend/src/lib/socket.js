import { io } from 'socket.io-client';
import { API_BASE } from './config.js';
import { getToken } from './api.js';

const ACK_TIMEOUT = 8000;
const CONNECT_TIMEOUT = 8000;

let socket = null;
const statusListeners = new Set();

export const status = {
  connected: false,
  connecting: false,
  error: ''
};

function setStatus(patch) {
  Object.assign(status, patch);
  for (const listener of statusListeners) listener(status);
}

export function onStatus(listener) {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

export function getSocket() {
  if (socket) return socket;
  const token = getToken();
  if (!token) return null;

  socket = io(API_BASE || window.location.origin, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    // Keep the Render free instance awake: it spins down after 15 minutes
    // without inbound traffic, and since Feb 2026 WebSocket frames count as
    // traffic — so the built-in ping keeps a board that is being watched alive.
    pingInterval: 25_000,
    pingTimeout: 20_000
  });

  socket.on('connect', () => setStatus({ connected: true, connecting: false, error: '' }));
  socket.on('disconnect', (reason) => {
    setStatus({ connected: false });
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('connect_error', (err) => {
    setStatus({ connected: false, connecting: false, error: err.message });
  });

  return socket;
}

export function disconnect() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  setStatus({ connected: false, connecting: false });
}

/**
 * The handshake is async, so the very first mutation of a session usually lands
 * before `connected` flips. Queueing the emit behind the connection instead of
 * failing outright is what keeps "create my first board" from randomly
 * reporting the user as offline.
 */
function whenConnected(active) {
  if (active.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Could not reach the server. Check your connection and retry.'));
    }, CONNECT_TIMEOUT);

    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(new Error(err?.message || 'Could not reach the server'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      active.off('connect', onConnect);
      active.off('connect_error', onError);
    };

    active.on('connect', onConnect);
    active.on('connect_error', onError);
  });
}

export async function emit(event, payload) {
  const active = getSocket();
  if (!active) throw new Error('Your session expired. Sign in again.');

  await whenConnected(active);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The server did not respond in time')), ACK_TIMEOUT);
    active.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/**
 * Every mutation resolves through here so that the three failure modes — server
 * rejection, version conflict, and transport loss — always surface as a thrown
 * Error with a `conflict` flag the caller can branch on.
 */
export async function mutate(event, payload) {
  const ack = await emit(event, payload);
  if (ack?.status === 'ok') return ack;
  if (ack?.status === 'conflict') {
    const error = new Error(ack.message || 'Someone else changed this first');
    error.conflict = true;
    error.card = ack.card;
    throw error;
  }
  throw new Error(ack?.message || 'That did not work');
}
