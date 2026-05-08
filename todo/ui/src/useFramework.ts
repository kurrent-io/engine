import { useEffect, useMemo, useRef, useState } from 'react';
import {
  TodoFramework,
  migrateTodos,
  reduceTodos,
  InMemStorage,
} from './model';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export function useFramework(
  relayUrl: string,
  enabled: boolean,
): [TodoFramework, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  // create a framework instance once, for the lifetime of this hook
  const fw = useMemo<TodoFramework>(() => {
    // const onCommands = (commands: any[]) => {
    //   const ws = wsRef.current;
    //   if (!ws || ws.readyState !== WebSocket.OPEN) return;
    //   for (const cmd of commands) {
    //     ws.send(JSON.stringify(cmd));
    //   }
    // };
    const onCommands = (commands: any[]) => {
      if (connState !== "connected") return;
      fw.recvEvents(commands);
    };
    return new TodoFramework(
      new InMemStorage(),
      {
        migrate: migrateTodos,
        reducer: reduceTodos,
        onCommands,
      },
    );
  }, []);

  useEffect(() => {
    setConnState(enabled ? 'connected' : 'disconnected');
  }, [enabled]);

  // useEffect(() => {
  //   if (!enabled) {
  //     if (wsRef.current) {
  //       wsRef.current.close();
  //       wsRef.current = null;
  //     }
  //     setConnState('disconnected');
  //     return;
  //   }

  //   let cancelled = false;
  //   let reconnectTimer: ReturnType<typeof setTimeout>;
  //   let backoff = 1000;

  //   function connect() {
  //     if (cancelled) return;
  //     setConnState('connecting');

  //     // ask the framework where we left off
  //     fw.reconnect((result) => {
  //       if (cancelled) return;

  //       const ws = new WebSocket(relayUrl);
  //       wsRef.current = ws;

  //       ws.onopen = () => {
  //         if (cancelled) { ws.close(); return; }
  //         backoff = 1000;
  //         // handshake: identify where to resume
  //         ws.send(JSON.stringify({
  //           since: result.checkpoint ?? null,
  //         }));
  //         setConnState('connected');
  //         // resend any commands that were persisted but which haven't round-tripped
  //         for (const cmd of result.commands) {
  //           ws.send(JSON.stringify(cmd));
  //         }
  //       };

  //       ws.onmessage = (msg) => {
  //         console.log("recv:", msg.data);
  //         if (msg.data === "caughtup") {
  //           fw.caughtUp();
  //         } else {
  //           const event = JSON.parse(msg.data);
  //           fw.recvEvents([event]);
  //         }
  //       };

  //       ws.onclose = () => {
  //         if (cancelled) return;
  //         setConnState('disconnected');
  //         wsRef.current = null;
  //         reconnectTimer = setTimeout(connect, backoff);
  //         backoff = Math.min(backoff * 2, 60000);
  //       };

  //       ws.onerror = () => {
  //         // onclose will fire after onerror
  //       };
  //     });
  //   }

  //   connect();

  //   return () => {
  //     cancelled = true;
  //     clearTimeout(reconnectTimer);
  //     if (wsRef.current) {
  //       wsRef.current.close();
  //       wsRef.current = null;
  //     }
  //   };
  // }, [enabled, fw, relayUrl]);

  void relayUrl;
  void wsRef;

  return [fw, connState];
}
