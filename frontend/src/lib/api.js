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

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    // A blocked cross-origin response never reaches fetch, so it surfaces as a
    // bare "Failed to fetch" that names neither the server nor the cause. Say
    // which server, so the message points at the thing that is actually wrong.
    throw new Error(
      API_BASE
        ? `Could not reach ${API_BASE}. Check your connection and try again.`
        : 'The API address is not configured. Set VITE_API_URL and rebuild.'
    );
  }

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
  updateProfile: (body) => request('/api/auth/me', { method: 'PATCH', body }),
  uploadAvatar: (image) => request('/api/auth/avatar', { method: 'POST', body: { image } }),
  changePassword: (body) => request('/api/auth/password', { method: 'POST', body }),
  connections: () => request('/api/auth/connections'),
  linkProvider: (provider) => request(`/api/auth/link/${provider}`, { method: 'POST' }),
  unlinkProvider: (provider) => request(`/api/auth/connections/${provider}`, { method: 'DELETE' }),
  deleteAccount: (body) => request('/api/auth/account', { method: 'DELETE', body }),
  oauthProviders: () => request('/auth/providers'),
  // Trades the single-use handoff code from the OAuth redirect for a normal
  // JWT. This is the only place a session token is minted for a social sign-in.
  exchangeOauthCode: (code) => request('/auth/exchange', { method: 'POST', body: { code } }),
  searchUsers: (q) => request(`/api/users?q=${encodeURIComponent(q)}`),
  boards: () => request('/api/boards'),
  board: (id) => request(`/api/boards/${id}`),
  activity: (id, before) => {
    const params = new URLSearchParams({ limit: '25' });
    if (before) params.set('before', before);
    return request(`/api/boards/${id}/activity?${params.toString()}`);
  }
};

/**
 * An avatar is either an absolute https URL or a path this API serves
 * (`/users/:id/avatar`). Only the relative form needs the origin put back in
 * front of it — prepending blindly would turn a valid https URL into garbage.
 *
 * Both forms are matched rather than assumed. In production `API_BASE` is
 * empty, so a value that did not match would otherwise be handed to `<img src>`
 * verbatim, and `API_BASE + 'javascript:…'` is exactly how a scheme-bearing
 * value slips through a prefix check. Anything that fails both patterns renders
 * the initials fallback instead of a picture.
 */
export function avatarSrc(src) {
  if (typeof src !== 'string' || !src) return '';
  if (/^https:\/\//i.test(src) && !/[\s\\]/.test(src)) return src;
  if (/^\/(?!\/)[^\s\\]*$/.test(src)) return `${API_BASE}${src}`;
  return '';
}

/**
 * A path this app is allowed to navigate to: root-relative, single leading
 * slash, no whitespace and no backslash. Rejecting `//host` matters most — it
 * is a protocol-relative URL, so `API_BASE + '//evil.com'` is a same-tab open
 * redirect the moment the API base is empty. Used for the OAuth link callback
 * the server hands back, which is the only redirect target we accept from a
 * response body.
 */
export function ownPath(path) {
  return typeof path === 'string' && /^\/(?!\/)[^\s\\]*$/.test(path) ? path : '';
}

const OAUTH_PROVIDERS = new Set(['google', 'github']);

/**
 * The start URL for a social sign-in. The id normally arrives from
 * `/auth/providers`, but it is interpolated into a path that the browser
 * navigates to, so it is matched against the known set rather than trusted —
 * a value carrying `..`, a slash or a scheme cannot become a different URL.
 */
export function oauthPath(provider) {
  return OAUTH_PROVIDERS.has(provider) ? `/auth/${provider}` : '';
}
