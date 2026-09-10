import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, LoginResponse } from '@/lib/types';
import api, { auth as authApi } from '@/lib/api';

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  setTokens: (accessToken: string, refreshToken: string) => void;
  init: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        const res: LoginResponse = await authApi.login(email, password);
        const user: User = {
          id: res.user.id,
          email: res.user.email,
          role: res.user.role as User['role'],
        };
        set({ user, token: res.access_token, refreshToken: res.refresh_token || res.access_token, isAuthenticated: true });
        api.defaults.headers.common['Authorization'] = `Bearer ${res.access_token}`;
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch {
          // ignore logout errors
        } finally {
          set({ user: null, token: null, refreshToken: null, isAuthenticated: false });
          delete api.defaults.headers.common['Authorization'];
        }
      },

      register: async (email: string, password: string) => {
        await authApi.register(email, password);
        await get().login(email, password);
      },

      setTokens: (accessToken: string, refreshToken: string) => {
        set({ token: accessToken, refreshToken });
        api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
      },

      init: () => {
        const token = get().token;
        if (token) {
          set({ isAuthenticated: true });
          api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken, user: state.user }),
    },
  ),
);
