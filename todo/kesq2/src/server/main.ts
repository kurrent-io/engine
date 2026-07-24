import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import { TodoFramework, InMemStorage, migrateTodos, reduceTodos } from '../model';
import type { Query } from '../model';
import { queries } from 'kesq:queries';

/* The query server.  It runs its own framework instance as an ordinary relay
   client — the same code path the browser uses, just in Node — and executes
   flexible queries against it on behalf of browsers.

   Browsers speak one websocket to this server, carrying three flows:

     client → server   {type: "handshake", since}
                       {type: "command", command: {id, data}}
                       {type: "subscribe", sub, query, args}
                       {type: "unsubscribe", sub}
     server → client   {type: "event", event: {position, id, data}}
                       {type: "caughtup"}
                       {type: "result", sub, value}

   Events and commands are proxied through a per-connection upstream relay
   socket (each browser has its own catchup position), so local queries in the
   browser keep working exactly as they do against the relay directly.
   Subscriptions run here, against this server's framework instance. */

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:3003/ws';
const LISTEN_PORT = 3008;

let relay: WebSocket | null = null;

const fw = new TodoFramework(new InMemStorage(), {
  migrate: migrateTodos,
  reducer: reduceTodos,
  onCommands: (commands) => {
    for (const cmd of commands) relay?.send(JSON.stringify(cmd));
  },
});

let backoff = 1000;
function connectRelay() {
  fw.reconnect((result) => {
    const ws = new WebSocket(RELAY_URL);
    relay = ws;

    ws.on('open', () => {
      backoff = 1000;
      ws.send(JSON.stringify({ since: result.checkpoint ?? null }));
      for (const cmd of result.commands) ws.send(JSON.stringify(cmd));
      console.log(`relay connected: ${RELAY_URL}`);
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'caughtup') {
        fw.caughtUp();
      } else {
        fw.recvEvents([JSON.parse(text)]);
      }
    });

    ws.on('close', () => {
      relay = null;
      console.log(`relay disconnected; retrying in ${backoff}ms`);
      setTimeout(connectRelay, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });

    ws.on('error', () => {
      // 'close' fires after 'error'
    });
  });
}
connectRelay();

const wss = new WebSocketServer({ port: LISTEN_PORT, path: '/ws' });
wss.on('connection', (ws) => {
  let upstream: WebSocket | null = null;
  const pendingCommands: unknown[] = [];
  const subs = new Map<number, Query<unknown>>();

  ws.on('message', (raw: RawData) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error('bad message:', e);
      return;
    }

    switch (msg.type) {
      case 'handshake': {
        const up = new WebSocket(RELAY_URL);
        upstream = up;
        up.on('open', () => {
          up.send(JSON.stringify({ since: msg.since ?? null }));
          for (const cmd of pendingCommands) up.send(JSON.stringify(cmd));
          pendingCommands.length = 0;
        });
        up.on('message', (r) => {
          const text = r.toString();
          if (text === 'caughtup') {
            ws.send(JSON.stringify({ type: 'caughtup' }));
          } else {
            ws.send(JSON.stringify({ type: 'event', event: JSON.parse(text) }));
          }
        });
        up.on('close', () => ws.close());
        up.on('error', () => {});
        break;
      }

      case 'command': {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify(msg.command));
        } else {
          pendingCommands.push(msg.command);
        }
        break;
      }

      case 'subscribe': {
        const factory = queries[msg.query];
        if (!factory) {
          console.error(`unknown server query: ${msg.query}`);
          break;
        }
        const query = fw.newQuery(factory(...msg.args));
        query.subscribe((value) => {
          ws.send(JSON.stringify({ type: 'result', sub: msg.sub, value }));
        });
        subs.set(msg.sub, query);
        console.log(`subscribe ${msg.query}(${JSON.stringify(msg.args).slice(1, -1)})`);
        break;
      }

      case 'unsubscribe': {
        subs.get(msg.sub)?.close();
        subs.delete(msg.sub);
        break;
      }

      default:
        console.error('unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    for (const query of subs.values()) query.close();
    subs.clear();
    upstream?.close();
  });
});
console.log(`serving events + flexible queries on ws://localhost:${LISTEN_PORT}/ws`);
