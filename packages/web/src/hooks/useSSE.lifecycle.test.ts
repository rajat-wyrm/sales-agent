/**
 * Real-time stream lifecycle tests.
 *
 * These cover the two bugs that made the Leads page look frozen:
 *  1. one EventSource per page + an unclosed previous socket (leak), and
 *  2. StrictMode/remount tearing the connection down and never reopening it,
 *     because re-setting the same token short-circuited before opening.
 */
import { renderHook, waitFor } from '@testing-library/react';
import {
  useSSE,
  setRealtimeToken,
  subscribeRealtime,
  realtimeConnected,
  resetRealtime,
} from './useSSE';
import { useAuthStore } from '@/stores/auth';

type FakeSource = {
  url: string;
  readyState: number;
  onopen: ((this: unknown) => void) | null;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: unknown) => void) | null;
  close: jest.Mock;
};

const sockets: FakeSource[] = [];
let ctorCount = 0;

beforeEach(() => {
  resetRealtime();
  useAuthStore.setState({ token: null, isAuthenticated: false });
  sockets.length = 0;
  let id = 0;
  (global as any).EventSource = class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 1;
    onopen: any = null;
    onmessage: any = null;
    onerror: any = null;
    url: string;
    close = jest.fn(() => { this.readyState = 2; });
    constructor(url: string) {
      this.url = url;
      ctorCount += 1;
      sockets.push(this as any);
    }
  };
  (global as any).document = { visibilityState: 'visible', addEventListener: jest.fn() };
});

const fire = (data: unknown) =>
  sockets.filter((s) => s.readyState === 1).forEach((s) => s.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));

describe('shared realtime stream', () => {
  test('multiple hooks share ONE socket instead of one each', async () => {
    useAuthStore.setState({ token: 'tok-a', isAuthenticated: true });
    const a = renderHook(() => useSSE('/sse/token', jest.fn()));
    const b = renderHook(() => useSSE('/sse/token', jest.fn()));
    const c = renderHook(() => useSSE('/sse/token', jest.fn()));

    await waitFor(() => expect(sockets.length).toBe(1));
    a.unmount(); b.unmount(); c.unmount();
  });

  test('same token again still guarantees a live socket after teardown', async () => {
    // Simulate StrictMode: mount -> cleanup (refcount 0, socket closed) -> mount.
    setRealtimeToken('tok-b');
    const first = renderHook(() => useSSE('/sse/token', jest.fn()));
    await waitFor(() => expect(sockets.length).toBe(1));
    const live = () => sockets[sockets.length - 1];
    first.unmount();
    await waitFor(() => expect(live().close).toHaveBeenCalled());

    useAuthStore.setState({ token: 'tok-b', isAuthenticated: true });
    // Same token as before: the hook must still guarantee a live socket.
    const second = renderHook(() => useSSE('/sse/token', jest.fn()));
    await waitFor(() => expect(sockets.length).toBe(2));
    await waitFor(() => expect(sockets[1].readyState).toBe(1));
    expect(realtimeConnected()).toBe(true);
    second.unmount();
  });

  test('one listener gets the event; burst is coalesced to a single call', async () => {
    useAuthStore.setState({ token: 'tok-c', isAuthenticated: true });
    const cb = jest.fn();
    const { unmount } = renderHook(() => useSSE('/sse/token', cb));
    await waitFor(() => expect(sockets.length).toBe(1));

    // 30 rapid events (an army wave) must collapse into one callback.
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(realtimeConnected()).toBe(true);
    for (let i = 0; i < 30; i++) fire({ type: 'lead_updated', lead_id: `l${i}` });
    await waitFor(() => expect(cb).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ type: 'lead_updated' }));
    unmount();
  }, 15000);

  test('last subscriber leaving closes the stream; sign-out does too', async () => {
    useAuthStore.setState({ token: 'tok-d', isAuthenticated: true });
    const a = renderHook(() => useSSE('/sse/token', jest.fn()));
    const b = renderHook(() => useSSE('/sse/token', jest.fn()));
    await waitFor(() => expect(sockets.length).toBe(1));
    const live = sockets[0];

    a.unmount();
    // One holder left: the shared socket must survive, otherwise switching pages
    // would drop real-time updates for whoever remains mounted.
    expect(live.close).not.toHaveBeenCalled();

    b.unmount();
    await waitFor(() => expect(live.close).toHaveBeenCalled());

    // And logging out tears everything down even with no components mounted.
    useAuthStore.setState({ token: 'tok-e2', isAuthenticated: true });
    const c = renderHook(() => useSSE('/sse/token', jest.fn()));
    await waitFor(() => expect(sockets.length).toBe(2));
    resetRealtime();
    expect(sockets[1].close).toHaveBeenCalled();
    c.unmount();
  });

  test('terminal transport error triggers a reconnect attempt', async () => {
    useAuthStore.setState({ token: 'tok-e', isAuthenticated: true });
    const { unmount } = renderHook(() => useSSE('/sse/token', jest.fn()));
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].readyState = 2; // CLOSED => the browser will not retry on its own
    sockets[0].onerror?.({});
    // First backoff step is 1s.
    await waitFor(() => expect(sockets.length).toBe(2), { timeout: 4000 });
    unmount();
  });
});
