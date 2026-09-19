import api from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { navigateToLogin } from '@/lib/navigation';

// jsdom 26 (jest 30) made window.location [LegacyUnforgeable], so the redirect
// goes through a one-line seam module that automock can intercept instead.
jest.mock('@/lib/navigation');

// A JWT outlives the account it was minted for (deleted user, or a re-seeded
// database). The API answers those requests with 401, and the interceptor is the
// only thing that turns that into a working session again. It used to call an
// async logout() that made its own API request while the refresh lock was held:
// the request parked forever, the rejection escaped unhandled, and the redirect
// never ran -- so the user stared at "Loading…" with no way out. These assert the
// recovery actually completes.

const respondWith = (status: number) => ({
  status,
  data: { error: 'Unauthorized' },
  headers: {},
  config: { headers: {} },
});

const settle = () => new Promise((r) => setTimeout(r, 0));

async function trigger(handler: any, error: any) {
  return handler.rejected.call(api, error);
}

describe('401 auth recovery', () => {
  beforeEach(() => {
    jest.mocked(navigateToLogin).mockClear();
    useAuthStore.setState({
      token: 'dead-access',
      user: { id: 'ghost', email: 'ghost@example.com', role: 'admin' } as any,
      isAuthenticated: true,
      ready: true,
    });
    api.defaults.headers.common['Authorization'] = 'Bearer dead-access';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('clears credentials and redirects when the refresh token is also dead', async () => {
    // /auth/refresh rejects like the server does for a user that no longer exists.
    // The interceptor must surface that rejection to the leader instead of
    // queueing it behind its own refresh lock.
    jest.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/auth/refresh') {
        throw Object.assign(new Error('Request failed with status code 401'), {
          config: { url: '/auth/refresh', headers: {} },
          response: respondWith(401),
        });
      }
      throw new Error(`unexpected request during recovery: ${url}`);
    });

    const handler = (api.interceptors.response as any).handlers[0];
    const first = Object.assign(new Error('401'), {
      config: { headers: {}, _retry: false },
      response: respondWith(401),
    });

    await expect(trigger(handler, first)).rejects.toBeTruthy();
    await settle();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.token).toBeNull();
    // Nothing durable is stored client-side any more (no refreshToken field), so
    // "cleared" also means the user object is gone.
    expect(state.user).toBeNull();
    expect(api.defaults.headers.common['Authorization']).toBeUndefined();
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
  }, 10000);

  test('a 401 from /auth/refresh never re-enters the refresh path (deadlock guard)', async () => {
    const handler = (api.interceptors.response as any).handlers[0];
    // The refresh call itself failing must fall straight through to rejection.
    const refreshError = Object.assign(new Error('401'), {
      config: { url: '/auth/refresh', headers: {} },
      response: respondWith(401),
    });

    await expect(trigger(handler, refreshError)).rejects.toBeTruthy();
    await settle();

    // Lock released => the next unrelated 401 can still start a refresh rather
    // than being parked forever behind a leader that already finished.
    const post = jest.spyOn(api, 'post').mockRejectedValueOnce(
      Object.assign(new Error('401'), { response: respondWith(401), config: { url: '/auth/refresh', headers: {} } }),
    );

    const other = Object.assign(new Error('401'), {
      config: { url: '/leads', headers: {} },
      response: respondWith(401),
    });
    await expect(trigger(handler, other)).rejects.toBeTruthy();
    // No body: the refresh token now travels in an HttpOnly cookie, so the
    // request carries no credential the page script can see.
    expect(post).toHaveBeenCalledWith('/auth/refresh');
    await settle();
    expect(navigateToLogin).toHaveBeenCalledTimes(1);
  }, 10000);

  test('logout() performs no network call, so it cannot deadlock the interceptor', async () => {
    const post = jest.spyOn(api, 'post').mockResolvedValue({ data: {} } as any);
    await useAuthStore.getState().logout();
    expect(post).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  test('revokeCurrentToken() blacklists a still-valid token, and never throws', async () => {
    const post = jest.spyOn(api, 'post').mockResolvedValue({ data: { message: 'Logged out' } } as any);
    await useAuthStore.getState().revokeCurrentToken();
    expect(post).toHaveBeenCalledWith('/auth/logout');

    // A failing revocation must not prevent signing out.
    post.mockRejectedValueOnce(new Error('offline'));
    await expect(useAuthStore.getState().revokeCurrentToken()).resolves.toBeUndefined();
  });
});
