import { API_BASE } from './config.js';

const TOKEN_KEY = 'flowboard:token';

export function getToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function tokenPresent() {
  return Boolean(getToken());
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (res.status === 401 && token && path !== '/auth/me') {
    window.dispatchEvent(new CustomEvent('flowboard:unauthorized'));
  }

  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export const api = {
  health: () => request('/health'),
  signup: (body) => request('/api/auth/signup', { method: 'POST', body }),
  login: (body) => request('/api/auth/login', { method: 'POST', body }),
  me: () => request('/api/auth/me'),
  searchUsers: (q) => request(`/api/users?q=${encodeURIComponent(q)}`),
  boards: () => request('/api/boards'),
  board: (id) => request(`/api/boards/${id}`),
  activity: (id, before) => {
    const params = new URLSearchParams({ limit: '25' });
    if (before) params.set('before', before);
    return request(`/api/boards/${id}/activity?${params.toString()}`);
  }
};
