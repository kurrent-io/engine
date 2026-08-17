import { InMemStore, migrateTodos, reduceTodos, TodoEngine } from '@todo-basic/model/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export function usePhaseLock(serverUrl: string): [TodoEngine, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  // create an engine instance once, for the lifetime of this hook
  const eng = useMemo<TodoEngine>(() => {
    const onCommands = (commands: any[]) => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      for (const cmd of commands) {
        ws.send(JSON.stringify(cmd));
      }
    };
    return new TodoEngine(new InMemStore(), {
      migrate: migrateTodos,
      reducer: reduceTodos,
      onCommands,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;

    function connect() {
      if (cancelled) return;
      setConnState('connecting');

      // ask the engine where we left off
      eng.reconnect((result) => {
        if (cancelled) return;

        const ws = new WebSocket(serverUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) {
            ws.close();
            return;
          }
          backoff = 1000;
          // handshake: identify where to resume
          ws.send(
            JSON.stringify({
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
  }, [eng, serverUrl]);

  return [eng, connState];
}
