import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TodoFramework,
  migrateTodos,
  reduceTodos,
  InMemStorage,
} from '../model';
import type { TodoEvents } from '../model';
import { RemoteQueries } from './remote';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type KesqClient = {
  fw: TodoFramework;
  remote: RemoteQueries;
  sendCommands: (commands: TodoEvents[]) => void;
};

export function useFramework(serverUrl: string): [KesqClient, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  // create a framework + remote-query registry once, for the hook's lifetime
  const client = useMemo<KesqClient>(() => {
    const onCommands = (commands: any[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      for (const cmd of commands) {
        ws.send(JSON.stringify({ type: 'command', command: cmd }));
      }
    };
    const fw = new TodoFramework(new InMemStorage(), {
      migrate: migrateTodos,
      reducer: reduceTodos,
      onCommands,
    });
    return {
      fw,
      remote: new RemoteQueries(),
      sendCommands: (commands) => fw.sendCommands(commands),
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;

    function connect() {
      if (cancelled) return;
      setConnState('connecting');

      // ask the framework where we left off
      client.fw.reconnect((result) => {
        if (cancelled) return;

        const ws = new WebSocket(serverUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) { ws.close(); return; }
          backoff = 1000;
          ws.send(JSON.stringify({
            type: 'handshake',
            since: result.checkpoint ?? null,
          }));
          // resend any commands that were persisted but haven't round-tripped
          for (const cmd of result.commands) {
            ws.send(JSON.stringify({ type: 'command', command: cmd }));
          }
          // re-issue all live server-query subscriptions
          client.remote.attach((msg) => ws.send(JSON.stringify(msg)));
          setConnState('connected');
        };

        ws.onmessage = (raw) => {
          const msg = JSON.parse(raw.data as string);
          switch (msg.type) {
            case 'event':
              client.fw.recvEvents([msg.event]);
              break;
            case 'caughtup':
              client.fw.caughtUp();
              break;
            case 'result':
              client.remote.deliver(msg.sub, msg.value);
              break;
            default:
              console.error('unknown message type:', msg.type);
          }
        };

        ws.onclose = () => {
          if (cancelled) return;
          setConnState('disconnected');
          client.remote.detach();
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
      client.remote.detach();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [client, serverUrl]);

  return [client, connState];
}
