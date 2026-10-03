const PATHS = {
  board: 'M3 4h5v12H3zM10 4h5v7h-5zM17 4h4v9h-4z',
  plus: 'M12 5v14M5 12h14',
  card: 'M4 6h16v12H4z',
  user: 'M12 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM5 20a7 7 0 0114 0',
  users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM2 19a6 6 0 0112 0M17 11a3 3 0 100-6M16 19a6 6 0 016-6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 13l4 4L19 7',
  history: 'M12 8v4l3 2M3.5 12a8.5 8.5 0 1015-5.5M3.5 7v5h5',
  back: 'M15 6l-6 6 6 6',
  pencil: 'M4 20h4l10-10-4-4L4 16z'
};

export default function Icon({ name, size = 16, className = '' }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
