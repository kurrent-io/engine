import { useEffect, useMemo, useRef, useState } from 'react';
import {
  InMemStorage,
  UserFramework,
  DecodeLibraryEvents,
  userMigrate,
  userReducer,
} from './model';
import { FW } from './types';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export function useFramework(
  relayUrl: string,
  patronId: string,
  enabled: boolean,
): [FW, ConnectionState] {
  // create a framework instance once, for the lifetime of this hook
  const fw = useMemo(() => {
    const storage = new InMemStorage();
    return new UserFramework<number>(storage, {
      migrate: userMigrate,
      reducer: userReducer,
    });
  }, []);

  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnState('disconnected');
      return;
    }

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;

    function connect() {
      if (cancelled) return;
      setConnState('connecting');

      // ask the framework where we left off
      fw.reconnect((result) => {
        if (cancelled) return;

        const ws = new WebSocket(relayUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) { ws.close(); return; }
          backoff = 1000;
          // handshake: identify ourselves and where to resume
          ws.send(JSON.stringify({
            patron_id: patronId,
            since: result.checkpoint ?? null,
          }));
          setConnState('connected');
        };

        ws.onmessage = (msg) => {
          if (msg.data === "caughtup") {
            fw.caughtUp();
          } else {
            const parsed = JSON.parse(msg.data);
            const event = DecodeLibraryEvents(parsed.event);
            fw.recvEvents([event], parsed.position);
          }
        };

        ws.onclose = () => {
          if (cancelled) return;
          setConnState('disconnected');
          wsRef.current = null;
          reconnectTimer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60000);
        };

        ws.onerror = () => {
          // onclose will fire after onerror
        };
      });
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, fw, patronId, relayUrl]);

  return [fw, connState];
}
