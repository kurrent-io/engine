import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AdminEngine,
  adminMigrate,
  adminReducer,
  InMemStore,
  UserEngine,
  userForecaster,
  userMigrate,
  userReducer,
} from './model';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

// function overload signature: without patronId, return AdminEngine
export function usePhaseLock(relayUrl: string, enabled: boolean): [AdminEngine, ConnectionState];

// function overload signature: with patronId, return UserEngine
export function usePhaseLock(
  relayUrl: string,
  enabled: boolean,
  patronId: string,
): [UserEngine, ConnectionState];

// implementation signature: returns either AdminEngine or UserEngine
export function usePhaseLock(
  relayUrl: string,
  enabled: boolean,
  patronId?: string,
): [UserEngine | AdminEngine, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  // create an engine instance once, for the lifetime of this hook
  const eng = useMemo(() => {
    const store = new InMemStore();
    const onCommands = (commands: any[]) => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      for (const cmd of commands) {
        ws.send(JSON.stringify(cmd));
      }
    };
    if (patronId !== undefined) {
      return new UserEngine(store, {
        migrate: userMigrate,
        reducer: userReducer,
        forecaster: userForecaster,
        onCommands,
      });
    } else {
      return new AdminEngine(store, {
        migrate: adminMigrate,
        reducer: adminReducer,
        onCommands,
      });
    }
  }, [patronId]);

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

      // ask the engine where we left off
      eng.reconnect((result) => {
        if (cancelled) return;

        const ws = new WebSocket(relayUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) {
            ws.close();
            return;
          }
          backoff = 1000;
          // handshake: identify ourselves and where to resume
          ws.send(
            JSON.stringify({
              patron: patronId,
              since: result.checkpoint ?? null,
            }),
          );
          setConnState('connected');
          // resend any commands that were persisted but which haven't round-tripped
          for (const cmd of result.commands) {
            ws.send(JSON.stringify(cmd));
          }
        };

        ws.onmessage = (msg) => {
          console.log('recv:', msg.data);
          if (msg.data === 'caughtup') {
            eng.caughtUp();
          } else {
            const event = JSON.parse(msg.data);
            eng.recvEvents([event]);
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
  }, [enabled, eng, patronId, relayUrl]);

  return [eng, connState];
}
