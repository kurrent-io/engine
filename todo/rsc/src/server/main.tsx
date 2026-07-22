import { WebSocket, WebSocketServer } from 'ws';
import { renderToReadableStream } from 'react-server-dom-webpack/server.edge';

import { TodoFramework, InMemStorage, migrateTodos, reduceTodos } from '../model';
import type { TodoQX, QueryGenerator } from '../model';
import type { ListData } from '../types';
import { App } from './App';

/* The flight server.  It joins the relay as an ordinary framework client —
   the same code path the browser UI uses, just running in Node — and instead
   of committing renders to a DOM, it renders the server component tree to a
   flight payload and pushes it to every connected browser whenever the query
   result changes.  Browsers send commands back up the same websocket, so all
   business state lives here; the browser holds only component-local UI state. */

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:3003/ws';
const LISTEN_PORT = 3004;

/* The client manifest tells the flight renderer what the browser needs in
   order to resolve each client reference: the module id to require, the
   code-split chunks that must load first, and the export name.  It is keyed
   by the reference's full "<module>#<export>" id.  This demo ships every
   client component in the single browser bundle, registered under the same
   module id the reference carries, so the manifest is total and trivial:
   every reference maps to itself, with no chunks to load. */
const clientManifest = new Proxy(
  {},
  {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      const hash = key.lastIndexOf('#');
      if (hash === -1) return undefined;
      return { id: key.slice(0, hash), chunks: [], name: key.slice(hash + 1) };
    },
  },
);

function* listsLookup(qx: TodoQX): QueryGenerator<ListData[]> {
  const ids = (yield* qx.get.all_lists()) ?? [];
  const out: ListData[] = [];
  for (const id of ids) {
    const list = yield* qx.get.list(id);
    if (list.archived) continue;
    const items = [];
    for (const itemId of list.items) {
      const item = yield* qx.get.item(itemId);
      if (item.archived) continue;
      items.push({ id: item.id, text: item.text, done: item.done });
    }
    out.push({ id: list.id, name: list.name, items });
  }
  return out;
}

async function renderApp(lists: ListData[]): Promise<string> {
  const stream = renderToReadableStream(
    <App lists={lists} renderedAt={new Date().toISOString()} />,
    clientManifest,
  );
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const browsers = new Set<WebSocket>();
let lastPayload: string | null = null;
// renders are serialized so payloads reach browsers in query order
let renderChain: Promise<void> = Promise.resolve();

function broadcast(lists: ListData[]) {
  renderChain = renderChain
    .then(async () => {
      lastPayload = await renderApp(lists);
      for (const ws of browsers) ws.send(lastPayload);
      console.log(`rendered ${lastPayload.length} bytes to ${browsers.size} browser(s)`);
    })
    .catch((e) => console.error('render failed:', e));
}

let relay: WebSocket | null = null;

const fw = new TodoFramework(new InMemStorage(), {
  migrate: migrateTodos,
  reducer: reduceTodos,
  onCommands: (commands) => {
    for (const cmd of commands) relay?.send(JSON.stringify(cmd));
  },
});

fw.newQuery(listsLookup).subscribe(broadcast);

let backoff = 1000;
function connectRelay() {
  // ask the framework where we left off
  fw.reconnect((result) => {
    const ws = new WebSocket(RELAY_URL);
    relay = ws;

    ws.on('open', () => {
      backoff = 1000;
      // handshake: identify where to resume
      ws.send(JSON.stringify({ since: result.checkpoint ?? null }));
      // resend any commands that haven't round-tripped
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
  browsers.add(ws);
  if (lastPayload !== null) ws.send(lastPayload);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      fw.sendCommands([msg.command]);
    } catch (e) {
      console.error('bad command:', e);
    }
  });
  ws.on('close', () => browsers.delete(ws));
});
console.log(`serving flight payloads on ws://localhost:${LISTEN_PORT}/ws`);
