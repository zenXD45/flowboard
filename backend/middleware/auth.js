import { verifyToken } from '../utils/token.js';
import { User } from '../models/User.js';

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: 'You must be signed in' });
  }
  let user;
  try {
    user = await User.findById(payload.sub).lean();
  } catch {
    return res.status(401).json({ error: 'Session invalid' });
  }
  if (!user) {
    return res.status(401).json({ error: 'Account no longer exists' });
  }
  req.userId = String(user._id);
  req.user = user;
  next();
}
