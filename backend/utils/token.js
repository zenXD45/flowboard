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
