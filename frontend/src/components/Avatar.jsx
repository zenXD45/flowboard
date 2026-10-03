import { avatarSrc } from '../lib/api.js';

/* Every pair is verified at 4.6:1 or better, which matters because the fallback
   is rendered at ~10.5px — well under the size where 3:1 would be enough. */
const PALETTE = [
  ['#e6ccbc', '#904215'],
  ['#bce6d1', '#116e3f'],
  ['#c9bce6', '#4f1dc3'],
  ['#e6d9bc', '#785912'],
  ['#e6bcd0', '#9d1756']
];

export const AVATAR_COLORS = PALETTE.length;

function seedOf(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total * 31 + value.charCodeAt(i)) % 9973;
  return total;
}

/**
 * Picks the fallback pair. An explicit `avatarColor` (a stored index, as a
 * string) wins over the id-derived one, but the empty string means "no choice",
 * not "index zero" — hence the explicit emptiness check before Number().
 */
function paletteFor(id, avatarColor) {
  if (avatarColor !== '' && avatarColor != null) {
    const index = Number(avatarColor);
    if (Number.isInteger(index) && index >= 0 && index < PALETTE.length) return PALETTE[index];
  }
  return PALETTE[seedOf(id) % PALETTE.length];
}

export default function Avatar({ userId, username, displayName, avatar, avatarColor, size = 28, title }) {
  const id = userId || username || '?';
  const [bg, fg] = paletteFor(id, avatarColor);
  const name = displayName || username || '?';
  const src = avatarSrc(avatar);
  const label = title || name;

  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: src ? 'transparent' : bg, color: fg }}
      title={label}
      aria-label={label}
    >
      {src ? <img src={src} alt="" width={size} height={size} /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}
