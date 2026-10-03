import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { API_BASE } from '../lib/config.js';

/**
 * Inline marks rather than a font icon set: two small glyphs cost nothing to
 * ship and cannot render as a broken box.
 */
const MARKS = {
  google: (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H1v2.34A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H1a9 9 0 0 0 0 8.12l2.97-2.34Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 1 4.94l2.97 2.34C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  ),
  github: (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
};

export default function AuthCard({ mode, onSwitch }) {
  const { signup, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState([]);

  const isSignup = mode === 'signup';

  // Ask the server which providers actually have credentials. Rendering a
  // Google button that the API has no client id for would send the user to a
  // 503 page, so the button list is driven by configuration, not hardcoded.
  useEffect(() => {
    let cancelled = false;
    api
      .oauthProviders()
      .then((data) => {
        if (!cancelled) setProviders(Array.isArray(data?.providers) ? data.providers : []);
      })
      .catch(() => {
        /* social sign-in is optional; the password form still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Failures inside the redirect flow arrive as an event rather than a thrown
  // error, because the browser has already navigated back to this page.
  useEffect(() => {
    const onAuthError = (e) => setError(e.detail?.message || 'Social sign-in did not complete.');
    window.addEventListener('flowboard:auth-error', onAuthError);
    return () => window.removeEventListener('flowboard:auth-error', onAuthError);
  }, []);

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

        {providers.length > 0 && (
          <>
            <div className="auth__social">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="auth__provider"
                  disabled={busy}
                  onClick={() => {
                    // A real navigation, not fetch: the provider has to own the
                    // top-level page so its own cookies and consent UI apply.
                    window.location.assign(`${API_BASE}/auth/${p.id}`);
                  }}
                >
                  {MARKS[p.id]}
                  Continue with {p.label}
                </button>
              ))}
            </div>
            <p className="auth__or">or</p>
          </>
        )}

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

          <button type="submit" className={`btn btn--wide${busy ? ' btn--busy' : ''}`} disabled={busy}>
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
