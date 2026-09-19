import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth';
// SSE rides the same base as the REST client (/api in prod via nginx, /sse
// dev-proxy in vite). Relative base keeps it working behind any reverse proxy.
import { SSE_URL as SSE_BASE } from '@/lib/env';

type SSEEvent = {
  type: string;
  lead_id?: string;
  [key: string]: unknown;
};

// Single real-time contract (mirrors the event names the API + workers
// publish; see api/src/utils/sse.ts). Heartbeats/connected are transport
// noise and never match.
export const LEAD_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  'enrichment_queued',
  'enrichment_complete',
  'verification_queued',
  'verification_complete',
  'draft_queued',
  'draft_generated',
  'send_queued',
  'send_complete',
  'send_blocked',
  'verify_send_queued',
  'verify_and_send_queued',
  'verify_send_complete',
  'lead_updated',
]);

export function isLeadLifecycleEvent(type: string | undefined): boolean {
  return !!type && LEAD_LIFECYCLE_EVENTS.has(type);
}

/** Detail page refreshes only for ITS lead's lifecycle events (never on
 * heartbeats, connects, or other leads' events — the old handler refetched
 * on everything). */
export function shouldRefreshLeadDetail(event: SSEEvent, leadId: string | undefined): boolean {
  if (!leadId) return false;
  if (!isLeadLifecycleEvent(event.type)) return false;
  return event.lead_id === leadId;
}

// ---------------------------------------------------------------------------
// One shared connection for the whole app.
//
// Root cause of "the Leads page is not real time": every page called useSSE()
// and opened its OWN EventSource, and connect() overwrote eventSourceRef without
// closing the previous socket. React StrictMode double-invokes effects, and the
// token changes on every silent refresh, so a single tab accumulated ~16
// connection attempts and left orphaned server-side subscriber streams behind
// (observed: 3 live `sub=` clients from one browser tab, one idle 75s). The page
// you were looking at could end up attached to a socket that was no longer the
// one being read, so events arrived at Redis but never reached react-query.
//
// Fix: a module-level singleton refcounted by active subscribers. Reconnect with
// exponential backoff (the browser does NOT retry a failed EventSource on its
// own once it hits a terminal error), and re-arm on auth change.
// ---------------------------------------------------------------------------

type Listener = (event: SSEEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let currentToken: string | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// Set when the tab goes to background; events are cheap to replay by refetching
// once, so we drop the socket there and reconnect on return.
let visible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';

const RECONNECT_MAX_MS = 30_000;

function emit(data: SSEEvent) {
  listeners.forEach((cb) => {
    try {
      cb(data);
    } catch {
      // A throwing listener must not tear down the stream for everyone else.
    }
  });
}

function scheduleReconnect() {
  if (retryTimer || !currentToken || !visible) return;
  const delay = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_MS);
  attempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, delay);
}

function open() {
  if (typeof EventSource === 'undefined' || !currentToken || !visible) return;
  closeSocket();
  // Authenticated by the HttpOnly `sse_auth` cookie set at login/refresh, NOT by
  // a token in the URL. The previous `?token=<jwt>` form put a full 7-day access
  // token into every nginx access log line, the browser history entry and any
  // Referer header, and the endpoint that accepted it had no revocation check.
  // withCredentials makes the cookie travel when the API is on another origin.
  const es = new EventSource(`${SSE_BASE}/sse`, { withCredentials: true });
  es.onopen = () => {
    attempt = 0; // healthy again; next failure backs off from 1s
  };
  es.onmessage = (event: MessageEvent) => {
    try {
      emit(JSON.parse(event.data) as SSEEvent);
    } catch {
      emit({ type: 'raw', data: event.data });
    }
  };
  es.onerror = () => {
    // ReadyState CONNECTING means a transient blip the browser will retry itself;
    // CLOSED is terminal and needs our own backoff, otherwise the UI silently
    // stops updating until the user reloads.
    if (es.readyState === EventSource.CLOSED) {
      closeSocket();
      scheduleReconnect();
    }
  };
  source = es;
}

function closeSocket() {
  if (source) {
    source.onmessage = null;
    source.onopen = null;
    source.onerror = null;
    source.close();
    source = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function teardown() {
  closeSocket();
  currentToken = null;
  attempt = 0;
}

function onVisibilityChange() {
  if (typeof document !== 'undefined') {
    visible = document.visibilityState !== 'hidden';
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    onVisibilityChange();
    if (visible) {
      // Coming back to a foreground tab: reconnect and let listeners refetch.
      attempt = 0;
      open();
      emit({ type: 'reconnected' });
    } else {
      teardown();
    }
  });
}

/** Subscribe to the shared stream. Returns an unsubscribe fn. */
export function subscribeRealtime(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
    if (listeners.size > 0) return;
    // Defer the close by a macrotask. StrictMode's mount -> cleanup -> remount all
    // happen in one tick, so an immediate teardown closed a stream that a listener had
    // already re-subscribed to on the next line, leaving the app permanently deaf with
    // no error surfaced. A genuine unmount (logout, last page navigating away) still
    // closes it one task later, which is indistinguishable to the server.
    setTimeout(() => {
      if (listeners.size === 0) teardown();
    }, 0);
  };
}

// A full army run publishes one event per lead per stage. Without coalescing,
// each subscriber called refetch() on every single one -- hundreds of back-to-back
// list queries that queued behind each other and made the table look frozen.
// Trailing-edge throttle: fire once per window with the most recent event.
const COALESCE_MS = 1500;

export function coalesceEvents(cb: Listener, windowMs = COALESCE_MS): Listener {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: SSEEvent | null = null;
  return (event) => {
    last = event;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const e = last;
      last = null;
      if (e) cb(e);
    }, windowMs);
  };
}

/** Drop every listener and close the stream. Used on logout and by tests to get
 * a clean slate between cases without re-requiring the module (which would load
 * a second React copy and break hook calls). */
export function resetRealtime() {
  listeners.clear();
  teardown();
  // Re-read visibility: a test may have installed its own `document` after this
  // module was first evaluated, which would otherwise leave `visible` stale-false
  // and make every open() call silently no-op.
  onVisibilityChange();
}

/** Exposed for tests and for an explicit "go live now" after a login. */
export function setRealtimeToken(token: string | null) {
  const sameToken = token === currentToken;
  currentToken = token;
  if (!token) {
    teardown();
    attempt = 0;
    return;
  }
  // Re-setting the SAME token must still guarantee a live socket. StrictMode
  // (and any remount) runs cleanup first, which unsubscribes the last listener
  // and tears the connection down; an early return here would leave the app
  // permanently deaf because no further token change ever arrives.
  if (sameToken && source && source.readyState !== EventSource.CLOSED) return;
  attempt = 0;
  open();
}

/** Live diagnostics for debugging a silent stream; also set on window in dev. */
export function realtimeDiagnostics() {
  return {
    hasToken: !!currentToken,
    visible,
    listeners: listeners.size,
    sourceState: source ? source.readyState : null,
    retryScheduled: !!retryTimer,
    attempt,
  };
}

export function realtimeConnected(): boolean {
  return source !== null && source.readyState === EventSource.OPEN;
}

export function useSSE(_url: string, onEvent?: (event: SSEEvent) => void) {
  const token = useAuthStore((s) => s.token);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Stable wrapper so the throttle timer survives re-renders.
  const throttled = useRef<Listener | null>(null);
  if (!throttled.current) {
    throttled.current = coalesceEvents((e) => onEventRef.current?.(e));
  }

  useEffect(() => {
    // Subscribe BEFORE publishing the token. React StrictMode mounts, cleans up and
    // remounts every effect in development and in this production build; with the old
    // order the first pass opened the socket and its cleanup then dropped the listener
    // count to zero, which tore the stream down -- and because the token never changed
    // again, nothing ever reopened it. Result: realtime silently off, no events, no
    // error anywhere.
    const unsubscribe = subscribeRealtime(throttled.current!);
    if (token) setRealtimeToken(token);
    return unsubscribe;
  }, [token]);

  // The connection is shared and refcount-managed; per-page connect/disconnect
  // would recreate the leak this replaced, so these stay no-ops kept for API
  // compatibility with existing callers.
  const connect = useCallback(() => setRealtimeToken(token ?? null), [token]);
  const disconnect = useCallback(() => {}, []);

  return { connect, disconnect };
}
