import { create } from 'zustand';
import { resetRealtime } from '@/hooks/useSSE';
import { User, LoginResponse } from '@/lib/types';
import api, { auth as authApi } from '@/lib/api';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /**
   * True once the boot-time silent refresh has settled. The UI must not decide
   * "signed out" before that, or a reload flashes the login page at a user who
   * still has a perfectly good session cookie.
   */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  revokeCurrentToken: () => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  setTokens: (accessToken: string) => void;
  refreshSession: () => Promise<boolean>;
  init: () => Promise<void>;
}

/**
 * Session state is IN MEMORY ONLY.
 *
 * The store used to be wrapped in `persist`, which wrote the access token AND the
 * 30-day refresh token to localStorage under `auth-storage`. Anything running in
 * the page -- an injected script, or a single compromised transitive npm
 * dependency -- could read them and mint sessions far beyond the tab's lifetime.
 * The refresh token now lives in an HttpOnly cookie the server sets
 * (Path=/api/auth, SameSite=Strict), and the access token is never written to
 * storage: a reload re-establishes the session through the cookie via
 * refreshSession(). XSS can no longer exfiltrate a durable credential.
 */
export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  ready: false,

  login: async (email: string, password: string) => {
    const res: LoginResponse = await authApi.login(email, password);
    const user: User = {
      id: res.user.id,
      email: res.user.email,
      role: res.user.role as User['role'],
    };
    set({ user, token: res.access_token, isAuthenticated: true, ready: true });
    api.defaults.headers.common['Authorization'] = `Bearer ${res.access_token}`;
  },

  // Local teardown only, and deliberately free of any API call: the 401
  // recovery path in lib/api.ts invokes this while holding the refresh lock,
  // so a request here would re-enter that same interceptor with the already
  // dead token and never settle (silent hang, no redirect). Callers that sign
  // out voluntarily use revokeCurrentToken() first -- see components/Header.
  logout: async () => {
    set({ user: null, token: null, isAuthenticated: false, ready: true });
    delete api.defaults.headers.common['Authorization'];
    // Close the shared realtime stream explicitly: useSSE only opens on a
    // token change and never tears down on sign-out (so that one page
    // mounting signed-out cannot kill another's connection), so this is the
    // single place that must. Without it a logged-out browser keeps
    // receiving lead events until reload.
    resetRealtime();
  },

  // Ask the server to revoke this session. Only for user-initiated sign-out,
  // where the token is still valid and the refresh lock is not held. Best
  // effort: a failure must not block signing out.
  revokeCurrentToken: async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore -- local teardown below is what actually ends the session
    }
  },

  register: async (email: string, password: string) => {
    await authApi.register(email, password);
    await get().login(email, password);
  },

  setTokens: (accessToken: string) => {
    set({ token: accessToken });
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
  },

  // Exchange the HttpOnly refresh cookie for a fresh access token. Used on boot
  // and by the reconnect path; the cookie is sent automatically and the server
  // rotates it, so nothing sensitive is ever read or written by JS here.
  refreshSession: async () => {
    try {
      const res = await api.post('/auth/refresh');
      const payload = res.data as LoginResponse;
      const user: User | null = payload.user
        ? {
            id: payload.user.id,
            email: payload.user.email,
            role: payload.user.role as User['role'],
          }
        : get().user;
      set({ user, token: payload.access_token, isAuthenticated: true, ready: true });
      api.defaults.headers.common['Authorization'] = `Bearer ${payload.access_token}`;
      return true;
    } catch {
      set({ user: null, token: null, isAuthenticated: false, ready: true });
      delete api.defaults.headers.common['Authorization'];
      return false;
    }
  },

  init: async () => {
    if (get().ready) return;
    if (get().token) {
      set({ isAuthenticated: true, ready: true });
      api.defaults.headers.common['Authorization'] = `Bearer ${get().token}`;
      return;
    }
    await get().refreshSession();
  },
}));
