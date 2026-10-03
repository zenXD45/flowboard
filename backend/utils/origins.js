/**
 * Which browser origins may talk to the API.
 *
 * `FRONTEND_URL` holds a comma-separated allowlist. It is compared by exact
 * match rather than by wildcard, because the API accepts an Authorization
 * header and `Access-Control-Allow-Credentials` — `*` would be rejected by
 * browsers anyway, and a prefix or suffix match would quietly let a lookalike
 * domain in.
 *
 * Comparison is normalised first. An origin is scheme + host + port, so a
 * trailing slash or stray capitalisation is never meaningful, and browsers
 * send the scheme and host lowercased anyway. Normalising both sides means a
 * pasted value with a trailing slash works instead of failing as an opaque
 * CORS error.
 */

export function normalizeOrigin(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function parseOriginAllowlist(value) {
  const seen = new Set();
  for (const part of String(value ?? '').split(',')) {
    const normalized = normalizeOrigin(part);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

/**
 * A missing Origin means the request was not sent by a browser page — curl,
 * a health check, a server-to-server call — so there is no origin to police
 * and CORS is not involved.
 */
export function isOriginAllowed(allowlist, origin) {
  if (!origin) return true;
  return allowlist.includes(normalizeOrigin(origin));
}

/** The host:port of an origin, or null when it is not a parseable URL. */
export function hostOf(origin) {
  try {
    return new URL(String(origin)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a request came from a page served by this same server.
 *
 * CORS does not apply to same-origin traffic, but browsers still attach an
 * Origin header to same-origin POSTs. Without this check every ordinary write
 * from the built-in frontend would be logged as a rejected cross-origin
 * attempt, which is exactly the sort of misleading noise that makes a log
 * useless when a real CORS fault does occur.
 */
export function isSelfOrigin(origin, host) {
  const candidate = hostOf(origin);
  return candidate !== null && host !== undefined && candidate === String(host).toLowerCase();
}
