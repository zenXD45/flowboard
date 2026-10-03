import { useCallback, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import AuthCard from './pages/AuthCard.jsx';
import Dashboard from './pages/Dashboard.jsx';
import BoardPage from './pages/BoardPage.jsx';
import Settings from './pages/Settings.jsx';

function readRoute() {
  const hash = window.location.hash;
  const board = hash.match(/^#\/board\/([a-f0-9]{24})$/i);
  if (board) return { name: 'board', boardId: board[1] };
  if (hash === '#/settings') return { name: 'settings' };
  return { name: 'home' };
}

function App() {
  const { user, ready } = useAuth();
  const [mode, setMode] = useState('login');
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openBoard = useCallback((id) => {
    window.location.hash = `#/board/${id}`;
  }, []);

  const goHome = useCallback(() => {
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

  if (route.name === 'settings') return <Settings onExit={goHome} />;
  if (route.name === 'board') return <BoardPage boardId={route.boardId} onExit={goHome} />;

  return <Dashboard onOpen={openBoard} />;
}

export default function Root() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
