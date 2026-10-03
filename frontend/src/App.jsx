import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import AuthCard from './pages/AuthCard.jsx';
import Dashboard from './pages/Dashboard.jsx';
import BoardPage from './pages/BoardPage.jsx';

function readBoardFromHash() {
  const match = window.location.hash.match(/^#\/board\/([a-f0-9]{24})$/i);
  return match ? match[1] : null;
}

function App() {
  const { user, ready } = useAuth();
  const [mode, setMode] = useState('login');
  const [boardId, setBoardId] = useState(() => readBoardFromHash());

  useEffect(() => {
    const onHash = () => setBoardId(readBoardFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openBoard = useCallback((id) => {
    window.location.hash = `#/board/${id}`;
  }, []);

  const exitBoard = useCallback(() => {
    window.location.hash = '';
  }, []);

  // A token can outlive the account it belongs to; drop it rather than showing
  // an app shell that can only fail every request.
  if (!ready) {
    return (
      <div className="boot" role="status">
        <span className="boot-ring" aria-hidden="true" />
        <p>Starting up…</p>
      </div>
    );
  }

  if (!user) {
    return <AuthCard mode={mode} onSwitch={() => setMode(mode === 'login' ? 'signup' : 'login')} />;
  }

  if (boardId) return <BoardPage boardId={boardId} onExit={exitBoard} />;

  return <Dashboard onOpen={openBoard} />;
}

export default function Root() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
