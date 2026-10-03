import jwt from 'jsonwebtoken';
import config from '../config/index.js';

const algorithm = 'HS256';

export function signToken(userId) {
  return jwt.sign({ sub: String(userId), iat: Math.floor(Date.now() / 1000) }, config.jwtSecret, {
    algorithm,
    expiresIn: `${config.jwtTtlDays}d`
  });
}

export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: [algorithm] });
    return typeof payload?.sub === 'string' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * A token that authorises *linking* a provider to an existing account.
 *
 * This cannot be the session JWT: the OAuth start is a top-level browser
 * navigation, so it cannot carry an Authorization header, and putting a 7-day
 * session token in a URL would leak it into history and Referer headers. A
 * dedicated token that expires in minutes and is scoped to `purpose` limits
 * what a leaked URL could do — it can only attach an identity, never sign in.
 */
export function signLinkToken(userId) {
  return jwt.sign({ sub: String(userId), purpose: 'oauth-link' }, config.jwtSecret, {
    algorithm,
    expiresIn: '10m'
  });
}

export function verifyLinkToken(token) {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: [algorithm] });
    if (payload?.purpose !== 'oauth-link') return null;
    return typeof payload?.sub === 'string' ? payload : null;
  } catch {
    return null;
  }
}
