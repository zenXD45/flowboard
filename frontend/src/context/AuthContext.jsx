import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setToken, tokenPresent } from '../lib/api.js';
import { disconnect } from '../lib/socket.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
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
  }, []);

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

  const value = useMemo(() => ({ user, ready, signup, login, logout }), [user, ready, signup, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
