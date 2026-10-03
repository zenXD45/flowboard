import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function AuthCard({ mode, onSwitch }) {
  const { signup, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isSignup = mode === 'signup';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isSignup) await signup({ username, password, ...(email ? { email } : {}) });
      else await login({ username, password });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth__card">
        <h1 className="auth__brand">FlowBoard</h1>
        <p className="auth__tag">Boards that move the moment you do.</p>

        <form onSubmit={submit} className="auth__form">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              minLength={3}
              maxLength={24}
              pattern="[A-Za-z0-9_\-]+"
              required
            />
          </label>

          {isSignup && (
            <label>
              Email <span className="muted">optional</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </label>
          )}

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              minLength={8}
              required
            />
          </label>

          {error && <p className="auth__error">{error}</p>}

          <button type="submit" className="btn btn--wide" disabled={busy}>
            {busy ? 'One moment…' : isSignup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="auth__swap">
          {isSignup ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" onClick={onSwitch}>
            {isSignup ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>
    </div>
  );
}
