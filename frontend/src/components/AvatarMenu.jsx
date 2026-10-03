import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { disconnect } from '../lib/socket.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

/**
 * The account control that sits in every topbar.
 *
 * It navigates by writing the hash rather than taking an `onSettings` prop,
 * because it is mounted in two places (the dashboard and the board topbar) that
 * otherwise share no routing context. The board page unmounts when the route
 * changes, which is also what tears its socket down.
 */
export default function AvatarMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const name = user?.displayName || user?.username || 'Account';

  return (
    <div className="avmenu" ref={rootRef}>
      <button
        type="button"
        className="avmenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar
          userId={user?.id}
          username={user?.username}
          displayName={user?.displayName}
          avatar={user?.avatar}
          avatarColor={user?.avatarColor}
          size={28}
        />
        <span className="avmenu__name">{name}</span>
        <Icon name="chevron" size={14} />
      </button>

      {open && (
        <div className="avmenu__menu" role="menu">
          <div className="avmenu__head">
            <Avatar
              userId={user?.id}
              username={user?.username}
              displayName={user?.displayName}
              avatar={user?.avatar}
              avatarColor={user?.avatarColor}
              size={40}
            />
            <span className="avmenu__ident">
              <strong>{name}</strong>
              <span className="muted">@{user?.username}</span>
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="avmenu__item"
            onClick={() => {
              setOpen(false);
              window.location.hash = '#/settings';
            }}
          >
            <Icon name="settings" size={15} /> Account settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="avmenu__item"
            onClick={() => {
              setOpen(false);
              disconnect();
              logout();
            }}
          >
            <Icon name="logout" size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
