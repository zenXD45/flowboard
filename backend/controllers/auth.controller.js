import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { User } from '../models/User.js';
import { signToken } from '../utils/token.js';

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 12 rounds is the production cost. Tests pay the same price per hash on every
// signup, so drop it there and keep the suite under a few seconds.
const BCRYPT_ROUNDS = config.isTest ? 4 : 12;

function shape(user) {
  return { id: String(user._id), username: user.username, email: user.email || '', avatar: user.avatar || '' };
}

export async function signup(req, res) {
  const { username, password, email } = req.body || {};
  const name = String(username || '').toLowerCase().trim();

  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: 'Username must be 3-24 characters: a-z, 0-9, _ or -' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (email !== undefined && email !== null && email !== '') {
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const payload = { username: name, passwordHash };
  if (email) payload.email = String(email).trim().toLowerCase();

  let user;
  try {
    user = await User.create(payload);
  } catch (err) {
    if (err?.code === 11000) {
      const field = err.keyPattern?.email ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    throw err;
  }

  res.status(201).json({ token: signToken(user._id), user: shape(user) });
}

export async function login(req, res) {
  const { username, password } = req.body || {};
  const name = String(username || '').toLowerCase().trim();
  if (!name || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = await User.findOne({ username: name });
  if (!user) {
    // Burn comparable time so response latency does not reveal account existence.
    await bcrypt.compare(password, `$2b$${BCRYPT_ROUNDS}$abcdefghijklmnopqrstuv0123456789012345678901234567890`);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }

  // An account created by social sign-in has no password. Comparing against an
  // empty hash would either throw or silently pass, so the same generic message
  // is returned and no hash comparison is attempted.
  if (!user.passwordHash) {
    await bcrypt.compare(password, `$2b$${BCRYPT_ROUNDS}$abcdefghijklmnopqrstuv0123456789012345678901234567890`);
    return res.status(401).json({ error: 'Incorrect username or password' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }

  res.json({ token: signToken(user._id), user: shape(user) });
}

export async function me(req, res) {
  res.json({ user: shape(req.user) });
}

export async function searchUsers(req, res) {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const users = await User.find({
    _id: { $ne: req.userId },
    username: { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' }
  })
    .select('username avatar')
    .limit(10)
    .lean();

  res.json({
    users: users.map((u) => ({ id: String(u._id), username: u.username, avatar: u.avatar || '' }))
  });
}

export async function directoryOf(req, res) {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => mongoose.isValidObjectId(s))
    .slice(0, 50);
  const users = await User.find({ _id: { $in: ids } }).select('username avatar').lean();
  res.json({
    users: users.map((u) => ({ id: String(u._id), username: u.username, avatar: u.avatar || '' }))
  });
}
