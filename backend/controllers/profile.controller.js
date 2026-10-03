import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { User } from '../models/User.js';
import { OAuthAccount } from '../models/OAuthAccount.js';
import { Board } from '../models/Board.js';
import { Card } from '../models/Card.js';
import { Comment } from '../models/Comment.js';
import { Activity } from '../models/Activity.js';
import { PROVIDERS, availableProviders } from '../utils/oauth.js';
import { signLinkToken } from '../utils/token.js';
import { publicSelf } from '../utils/shape.js';
import { EMAIL_RE, USERNAME_RE, AVATAR_COLORS, isValidObjectId } from '../utils/validate.js';

// Tests pay a real bcrypt hash on every signup and password change, so drop the
// cost there and keep the suite under a few seconds.
const BCRYPT_ROUNDS = config.isTest ? 4 : 12;

/**
 * Uploaded avatars arrive as a data URL the browser already resized. Only the
 * three raster formats `img` can be trusted to render are accepted — SVG is
 * deliberately absent because it can carry script, and it would be served back
 * from our own origin.
 */
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_AVATAR_BYTES = 256 * 1024;
const avatarPath = (id) => `/users/${id}/avatar`;

/**
 * Confirm the decoded bytes actually are the format the data URL claims.
 *
 * Without this a payload labelled image/png could hold anything, and we would
 * echo it back with an image content type from our own origin.
 */
function magicMatches(format, base64) {
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  if (format === 'png') return head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (format === 'jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (format === 'webp') {
    return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
}

/**
 * Update the cosmetic half of an account: handle, display name, email, avatar
 * colour, avatar URL and theme.
 *
 * Security note: an email the user types is never marked verified. Only a
 * provider assertion sets `emailVerified`, and that flag is the sole thing
 * allowed to link a social identity to an existing account — so a self-declared
 * address must not be able to claim that trust.
 */
export async function updateMe(req, res) {
  const body = req.body || {};
  const patch = {};

  if (body.username !== undefined) {
    const name = String(body.username).toLowerCase().trim();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Username must be 3-24 characters: a-z, 0-9, _ or -' });
    }
    if (name !== req.user.username) patch.username = name;
  }

  if (body.displayName !== undefined) {
    const displayName = String(body.displayName).trim();
    if (displayName.length > 40) {
      return res.status(400).json({ error: 'Display name must be 40 characters or fewer' });
    }
    patch.displayName = displayName;
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (email === '') {
      patch.email = undefined;
      patch.emailVerified = false;
    } else {
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      if (email !== (req.user.email || '')) {
        patch.email = email;
        patch.emailVerified = false;
      }
    }
  }

  if (body.avatarColor !== undefined) {
    const colour = String(body.avatarColor).trim();
    // '' means "derive a colour from my id" rather than "no colour".
    if (colour !== '' && (!/^\d+$/.test(colour) || Number(colour) >= AVATAR_COLORS)) {
      return res.status(400).json({ error: 'Unknown avatar colour' });
    }
    patch.avatarColor = colour;
  }

  if (body.theme !== undefined) {
    const theme = String(body.theme);
    if (!['system', 'dark', 'light'].includes(theme)) {
      return res.status(400).json({ error: 'Unknown theme' });
    }
    patch.theme = theme;
  }

  if (body.avatar !== undefined) {
    const url = String(body.avatar).trim();
    if (url === '') {
      // Empty removes any image, uploaded or linked, and falls back to the
      // colour-and-initials avatar.
      patch.avatar = '';
      patch.avatarUpload = '';
    } else {
      // https only: the page CSP allows https and data images, so an http URL
      // would be stored and then silently blocked at render time.
      if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 500) {
        return res.status(400).json({ error: 'Avatar URL must be a valid https address' });
      }
      patch.avatar = url;
      patch.avatarUpload = '';
    }
  }

  if (Object.keys(patch).length === 0) return res.json({ user: publicSelf(req.user) });

  try {
    await User.updateOne({ _id: req.userId }, { $set: patch });
  } catch (err) {
    if (err?.code === 11000) {
      const field = err.keyPattern?.email ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    throw err;
  }

  res.json({ user: publicSelf({ ...req.user, ...patch }) });
}

/** Store a browser-resized avatar and point `avatar` at the serving route. */
export async function uploadAvatar(req, res) {
  const { image } = req.body || {};
  if (typeof image !== 'string') return res.status(400).json({ error: 'Expected an image' });

  const match = DATA_URL_RE.exec(image);
  if (!match) return res.status(400).json({ error: 'Avatar must be a PNG, JPEG or WebP image' });
  if (Buffer.byteLength(match[2], 'base64') > MAX_AVATAR_BYTES) {
    return res.status(400).json({ error: 'That image is too large' });
  }
  if (!magicMatches(match[1], match[2])) {
    return res.status(400).json({ error: 'That file is not a valid image' });
  }

  const avatar = avatarPath(req.userId);
  await User.updateOne({ _id: req.userId }, { $set: { avatar, avatarUpload: image } });
  res.json({ user: publicSelf({ ...req.user, avatar, avatarUpload: image }) });
}

/**
 * Serve an uploaded avatar.
 *
 * Intentionally unauthenticated: an <img> tag cannot send an Authorization
 * header, and the id is an opaque ObjectId that only appears in payloads the
 * requester could already read.
 */
export async function getAvatar(req, res) {
  const id = req.params.id;
  if (!isValidObjectId(id)) return res.status(404).end();

  const user = await User.findById(id).select('avatarUpload').lean();
  const match = user?.avatarUpload ? DATA_URL_RE.exec(user.avatarUpload) : null;
  if (!match) return res.status(404).end();

  res.set('Content-Type', match[1] === 'jpeg' ? 'image/jpeg' : `image/${match[1]}`);
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.send(Buffer.from(match[2], 'base64'));
}

/**
 * Set a new password, or set a first one on a social-only account.
 *
 * When the account already has a password the current one is required, so a
 * stolen session alone cannot lock the owner out.
 */
export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (req.user.passwordHash) {
    const ok = typeof currentPassword === 'string' && (await bcrypt.compare(currentPassword, req.user.passwordHash));
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await User.updateOne({ _id: req.userId }, { $set: { passwordHash } });
  res.json({ user: publicSelf({ ...req.user, passwordHash }) });
}

/** Which providers exist, which are configured, and which are linked to me. */
export async function listConnections(req, res) {
  const linked = await OAuthAccount.find({ userId: req.userId }).select('provider').lean();
  const connected = new Set(linked.map((row) => row.provider));
  const usable = new Set(availableProviders());
  res.json({
    connections: Object.entries(PROVIDERS).map(([id, provider]) => ({
      id,
      label: provider.label,
      // A provider with no server credentials cannot be linked, so the row is
      // shown as unavailable rather than offered and then failing.
      available: usable.has(id),
      connected: connected.has(id)
    }))
  });
}

/**
 * Begin linking a provider to the signed-in account.
 *
 * Returns a URL to navigate to, carrying a short-lived link token. The callback
 * sees the token and binds the provider identity to *this* account instead of
 * resolving a user by email — otherwise "Connect" would quietly sign the person
 * into whichever account that address happens to own.
 */
export async function startLink(req, res) {
  const provider = String(req.params.provider || '');
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    return res.status(404).json({ error: 'Unknown provider' });
  }
  if (!availableProviders().includes(provider)) {
    return res.status(503).json({ error: `${PROVIDERS[provider].label} is not configured` });
  }
  if (!config.publicUrl) {
    return res.status(503).json({ error: 'PUBLIC_URL is not set on the server' });
  }
  const token = signLinkToken(req.userId);
  res.json({ url: `/auth/${provider}?link=${encodeURIComponent(token)}` });
}

/** Unlink one identity, but never the account's only way back in. */
export async function unlinkConnection(req, res) {
  const provider = String(req.params.provider || '');
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    return res.status(404).json({ error: 'Unknown provider' });
  }

  if (!req.user.passwordHash) {
    const remaining = await OAuthAccount.countDocuments({ userId: req.userId });
    if (remaining <= 1) {
      return res.status(409).json({ error: 'Set a password before removing your only sign-in method' });
    }
  }

  const result = await OAuthAccount.deleteOne({ userId: req.userId, provider });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'That account is not linked' });
  res.json({ ok: true });
}

/**
 * Permanently delete the account and everything it owns.
 *
 * Boards the user owns are destroyed along with their cards, comments and
 * activity — the UI states this and names the count before asking. On boards
 * they were only a member of, the membership is pulled and any cards assigned
 * to them are unassigned rather than deleted, because that content belongs to
 * the board rather than to the person leaving.
 */
export async function deleteAccount(req, res) {
  const { confirm, password } = req.body || {};
  if (confirm !== req.user.username) {
    return res.status(400).json({ error: 'Type your username to confirm' });
  }
  if (req.user.passwordHash) {
    const ok = typeof password === 'string' && (await bcrypt.compare(password, req.user.passwordHash));
    if (!ok) return res.status(400).json({ error: 'Incorrect password' });
  }

  const owned = await Board.find({ ownerId: req.userId }).select('_id').lean();
  const ownedIds = owned.map((board) => board._id);
  if (ownedIds.length > 0) {
    await Promise.all([
      Card.deleteMany({ boardId: { $in: ownedIds } }),
      Comment.deleteMany({ boardId: { $in: ownedIds } }),
      Activity.deleteMany({ boardId: { $in: ownedIds } })
    ]);
    await Board.deleteMany({ _id: { $in: ownedIds } });
  }

  const memberOf = await Board.find({ 'members.userId': req.userId }).select('_id').lean();
  const memberOfIds = memberOf.map((board) => board._id);
  if (memberOfIds.length > 0) {
    await Card.updateMany(
      { boardId: { $in: memberOfIds }, assigneeId: req.userId },
      { $set: { assigneeId: null } }
    );
    await Board.updateMany({ 'members.userId': req.userId }, { $pull: { members: { userId: req.userId } } });
  }

  await Comment.deleteMany({ authorId: req.userId });
  await Activity.deleteMany({ actorId: req.userId });
  await OAuthAccount.deleteMany({ userId: req.userId });
  await User.deleteOne({ _id: req.userId });

  res.json({ ok: true });
}
