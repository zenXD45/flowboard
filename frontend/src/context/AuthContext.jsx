import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken, tokenPresent } from '../lib/api.js';
import { disconnect } from '../lib/socket.js';
import { applyTheme, storeTheme, storedTheme, watchSystemTheme } from '../lib/theme.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  /**
   * The OAuth handoff, read once from the fragment on mount.
   *
   * It has to be captured synchronously: the fragment is consumed during the
   * first render pass, and by the time an effect runs the router may already
   * have reacted to it.
   */
  const [handoff] = useState(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const code = params.get('code');
    const authError = params.get('auth');
    if (!code && !authError) return null;
    return { code, authError };
  });

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      // A social sign-in is mid-flight. The handoff effect below owns the ready
      // gate, so returning here without setting it keeps the boot screen up
      // instead of flashing the auth card before the user is signed in.
      if (handoff) return;
      if (!tokenPresent()) {
        setReady(true);
        return;
      }
      try {
        const { user: storedUser } = await api.me();
        if (!cancelled) setUser(storedUser);
      } catch (err) {
        // Only a token the server actually rejected may be discarded. A network
        // blip or a 5xx must not sign the user out, so retry once and then
        // leave the token in place for the next attempt.
        if (err?.status === 401) {
          setToken(null);
        } else {
          await new Promise((r) => setTimeout(r, 700));
          try {
            const { user: retryUser } = await api.me();
            if (!cancelled) setUser(retryUser);
          } catch (retryErr) {
            if (retryErr?.status === 401) setToken(null);
          }
        }
      }
      if (!cancelled) setReady(true);
    }
    restore();
    const onUnauth = () => {
      disconnect();
      setToken(null);
      setUser(null);
      setReady(true);
    };
    window.addEventListener('flowboard:unauthorized', onUnauth);
    return () => {
      cancelled = true;
      window.removeEventListener('flowboard:unauthorized', onUnauth);
    };
  }, [handoff]);

  const signup = useCallback(async (fields) => {
    const data = await api.signup(fields);
    setToken(data.token);
    setUser(data.user);
    setReady(true);
  }, []);

  const login = useCallback(async (fields) => {
    const data = await api.login(fields);
    setToken(data.token);
    setUser(data.user);
    setReady(true);
  }, []);

  const logout = useCallback(() => {
    disconnect();
    setToken(null);
    setUser(null);
  }, []);

  /**
   * The server's copy of `theme` wins once we know it, but the inline script in
   * index.html already applied the last choice from localStorage before React
   * existed. Mirroring back here is what keeps a reload on a different device —
   * or after clearing storage — consistent with the account rather than the
   * generic system default.
   */
  useEffect(() => {
    const preference = user?.theme || storedTheme();
    if (user?.theme) storeTheme(user.theme);
    else applyTheme(preference);
    if (preference !== 'system') return undefined;
    return watchSystemTheme(() => applyTheme('system'));
  }, [user?.theme]);

  const updateUser = useCallback((patch) => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  /**
   * Finish a social sign-in on return from the provider.
   *
   * The server hands back `#code=…` rather than a token, so the JWT is obtained
   * here over POST and stored exactly the way a password login stores it. The
   * fragment is stripped immediately: leaving it would let a refresh replay a
   * spent code — which fails, but bounces the user back to the sign-in screen —
   * and would keep the code in the address bar and in history.
   */
  useEffect(() => {
    if (!handoff) return;

    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    if (handoff.authError) {
      const messages = {
        cancelled: 'Sign-in was cancelled.',
        'invalid-state': 'That sign-in link could not be verified. Please try again.',
        'already-linked': 'That account is already connected to a different FlowBoard account.',
        failed: 'Social sign-in did not complete. Please try again.'
      };
      window.dispatchEvent(
        new CustomEvent('flowboard:auth-error', {
          detail: { message: messages[handoff.authError] || messages.failed }
        })
      );
      setReady(true);
      return;
    }

    let cancelled = false;
    api
      .exchangeOauthCode(handoff.code)
      .then((data) => {
        if (cancelled) return;
        setToken(data.token);
        setUser(data.user);
      })
      .catch((err) => {
        if (cancelled) return;
        window.dispatchEvent(
          new CustomEvent('flowboard:auth-error', { detail: { message: err.message } })
        );
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [handoff]);

  const value = useMemo(
    () => ({ user, ready, signup, login, logout, updateUser }),
    [user, ready, signup, login, logout, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
