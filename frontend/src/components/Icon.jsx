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
  chevron: 'M6 9l6 6 6-6',
  pencil: 'M4 20h4l10-10-4-4L4 16z',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71'
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
