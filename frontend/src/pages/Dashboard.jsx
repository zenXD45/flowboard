import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { disconnect, emit, getSocket } from '../lib/socket.js';
import { useAuth } from '../context/AuthContext.jsx';
import Avatar from '../components/Avatar.jsx';
import Icon from '../components/Icon.jsx';
import Toasts from '../components/Toasts.jsx';

const BLANK = ['', 'In progress', 'Done'];

let toastSeq = 0;

export default function Dashboard({ onOpen }) {
  const { user, logout } = useAuth();
  const [boards, setBoards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, tone = 'info') => {
    toastSeq += 1;
    const id = toastSeq;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.boards();
      setBoards(data.boards);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Start the handshake while the user is still reading the board list, so the
    // first click on "New board" is not waiting on a connection.
    getSocket();
  }, [load]);

  const create = async (e) => {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    try {
      const ack = await emit('board:create', { title: value, description: BLANK[0] });
      if (ack.status !== 'ok') throw new Error(ack.message);
      setTitle('');
      onOpen(ack.board.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="dash">
      <header className="dash__top">
        <div>
          <h1 className="dash__brand">FlowBoard</h1>
          <p className="muted">Signed in as {user?.username}</p>
        </div>
        <button
          type="button"
          className="ghostbtn"
          onClick={() => {
            disconnect();
            logout();
          }}
        >
          Sign out
        </button>
      </header>

      <form className="dash__new" onSubmit={create}>
        <input
          value={title}
          placeholder="Name a new board…"
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="btn">
          <Icon name="plus" size={14} /> New board
        </button>
      </form>

      {loading && <p className="muted">Loading your boards…</p>}
      {error && <p className="auth__error">{error}</p>}

      <div className="dash__grid">
        {boards.map((b) => (
          <button key={b.id} type="button" className="boardcard" onClick={() => onOpen(b.id)}>
            <span className="boardcard__icon">
              <Icon name="board" size={18} />
            </span>
            <span className="boardcard__title">{b.title}</span>
            <span className="muted">
              {b.cardCount} {b.cardCount === 1 ? 'card' : 'cards'} · {b.role}
            </span>
            <span className="boardcard__people">
              {(b.people || []).slice(0, 4).map((p) => (
                <Avatar key={p.userId} userId={p.userId} username={p.username} avatar={p.avatar} size={22} />
              ))}
            </span>
          </button>
        ))}
      </div>

      {!loading && boards.length === 0 && (
        <div className="empty">
          <p>No boards yet. Create your first one above.</p>
        </div>
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
