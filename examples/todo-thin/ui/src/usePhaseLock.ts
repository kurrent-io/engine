import {
  ClientMessage,
  encodeProto,
  RemoteTodoQueries,
  ServerMessage,
  TodoEvents,
  TodoQueries,
} from '@todo-thin/model/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import { generateUuid } from './util';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

// Our server supports commands and queries.
interface Server {
  sendCommand(command: TodoEvents): void;
  queries: TodoQueries;
}

export function usePhaseLock(serverUrl: string): [Server, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');

  const mem = useRef<{
    ws: WebSocket | null;
    outbox: any[];
    activeQueries: Record<string, { raw: any; onResult: (result: any) => void }>;
  }>({
    ws: null,
    outbox: [],
    activeQueries: {},
  });

  const server = useMemo(() => {
    const wsMaybeSend = (msg: ClientMessage) => {
      if (mem.current.ws) {
        mem.current.ws.send(JSON.stringify(msg));
      }
    };

    // Track active queries.  Active queries get re-opened for each connection.
    let queryId: number = 1;
    const queriesIO = {
      createQuery(raw: any[], onResult: (result: any) => void): () => void {
        const qid = `${queryId++}`;
        mem.current.activeQueries[qid] = { raw, onResult };
        wsMaybeSend({ subscribeQueries: { [qid]: raw } });
        const onClose = () => {
          delete mem.current.activeQueries[qid];
          wsMaybeSend({ closeQueries: [qid] });
        };
        return onClose;
      },
    };

    const sendCommand = (command: TodoEvents) => {
      const raw = {
        id: generateUuid(),
        data: encodeProto(command),
      };
      mem.current.outbox.push(raw);
      wsMaybeSend({ commands: [raw] });
    };

    const queries = new RemoteTodoQueries(queriesIO);

    return { sendCommand, queries };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;

    function connect() {
      if (cancelled) return;
      setConnState('connecting');

      const ws = new WebSocket(serverUrl);
      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        backoff = 1000;
        mem.current.ws = ws;
        setConnState('connected');

        const msg: ClientMessage = {};

        // re-submit our active queries
        if (Object.keys(mem.current.activeQueries).length > 0) {
          const queries: Record<string, any> = {};
          for (const [qid, { raw }] of Object.entries(mem.current.activeQueries)) {
            queries[qid] = raw;
          }
          msg.subscribeQueries = queries;
        }

        // re-submit our unack'd commands
        if (mem.current.outbox.length > 0) {
          msg.commands = mem.current.outbox;
        }

        if (msg.subscribeQueries || msg.commands) {
          ws.send(JSON.stringify(msg));
        }
      };

      ws.onmessage = (ev: MessageEvent<any>) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        // handle query results
        if (msg.queryResults) {
          for (const [qid, result] of Object.entries(msg.queryResults)) {
            mem.current.activeQueries[qid]?.onResult(result);
          }
        }

        // handle command acks
        if (msg.acks) {
          // acks are ordered; just shift N times
          new Array(msg.acks).map(() => mem.current.outbox.shift());
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnState('disconnected');
        mem.current.ws = null;
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (mem.current.ws) {
        mem.current.ws.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- we know this is the right `mem`
        mem.current.ws = null;
      }
    };
  }, [serverUrl]);

  return [server, connState];
}
