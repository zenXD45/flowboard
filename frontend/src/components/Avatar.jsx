/* Every pair is verified at 4.6:1 or better, which matters because the fallback
   is rendered at ~10.5px — well under the size where 3:1 would be enough. */
const PALETTE = [
  ['#e6ccbc', '#904215'],
  ['#bce6d1', '#116e3f'],
  ['#c9bce6', '#4f1dc3'],
  ['#e6d9bc', '#785912'],
  ['#e6bcd0', '#9d1756']
];

function seedOf(value) {
  let total = 0;
  for (let i = 0; i < value.length; i += 1) total = (total * 31 + value.charCodeAt(i)) % 9973;
  return total;
}

export default function Avatar({ userId, username, avatar, size = 28, title }) {
  const id = userId || username || '?';
  const [bg, fg] = PALETTE[seedOf(id) % PALETTE.length];
  const initials = (username || '?').slice(0, 2).toUpperCase();

  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: avatar ? 'transparent' : bg, color: fg }}
      title={title || username || 'Unknown'}
      aria-label={username || 'Unknown member'}
    >
      {avatar ? <img src={avatar} alt="" width={size} height={size} /> : initials}
    </span>
  );
}
