import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser, LoginResponse } from '@pic/shared';
import { ApiRequestError, api } from '../api/http';

interface AuthState {
  /** undefined while the first /auth/me is in flight; null = signed out. */
  user: AuthUser | null | undefined;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api<AuthUser>('/auth/me')
      .then((me) => !cancelled && setUser(me))
      .catch((err: unknown) => {
        // 401 = no session. Anything else (server down) also lands on the login page, which
        // reports the real error when the person tries to sign in.
        if (!cancelled) setUser(null);
        if (!(err instanceof ApiRequestError && err.status === 401)) console.warn(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      queryClient.clear(); // nothing from a previous role may linger
      setUser(res.user);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api<void>('/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      setUser(null);
    }
  }, [queryClient]);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
