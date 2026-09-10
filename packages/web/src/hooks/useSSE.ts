import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth';

// SSE must ride the same base URL as the REST client (/api in prod via nginx proxy,
// /sse dev-proxy in vite). Relative base keeps it working behind any reverse proxy.
const SSE_BASE = import.meta.env.VITE_SSE_URL || '/api';

type SSEEvent = {
  type: string;
  [key: string]: unknown;
};

export function useSSE(url: string, onEvent?: (event: SSEEvent) => void) {
  const { token } = useAuthStore();
  const eventSourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);

  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (!token) return;

    const es = new EventSource(`${SSE_BASE}${url}?token=${encodeURIComponent(token)}`);

    es.onopen = () => {
      console.info('[SSE] Connected');
    };

    es.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        onEventRef.current?.(data);
      } catch {
        onEventRef.current?.({ type: 'raw', data: event.data });
      }
    };

    es.onerror = (err) => {
      console.warn('[SSE] Connection error:', err);
    };

    eventSourceRef.current = es;
  }, [token, url]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { connect, disconnect };
}
