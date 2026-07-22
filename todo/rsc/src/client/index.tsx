// Pulls every 'use client' module into the bundle and registers it, so flight
// payload references can resolve to the real components.  Must stay the first
// import: it installs the __webpack_require__ shim, which the flight client
// reads during its own module initialization.
import 'rsc:client-modules';

import { Suspense, startTransition, use, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createFromReadableStream } from 'react-server-dom-webpack/client';

import { setSocket } from './connection';
import './styles.css';

const SERVER_URL = 'ws://localhost:3004/ws';

// Each websocket message is one complete flight payload: a serialized render
// of the whole server component tree.  Deserializing yields a React tree with
// the registered client components stitched in at the reference points.
function decode(payload: string): PromiseLike<ReactNode> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return createFromReadableStream<ReactNode>(stream);
}

let update: ((tree: PromiseLike<ReactNode>) => void) | null = null;

function Root({ first }: { first: PromiseLike<ReactNode> }) {
  const [tree, setTree] = useState(first);
  useEffect(() => {
    // the transition keeps the current tree on screen until the next one is
    // ready; React reconciles across trees, so client component state (an
    // open editor, a half-typed input) survives server re-renders
    update = (next) => startTransition(() => setTree(next));
    return () => {
      update = null;
    };
  }, []);
  return use(tree);
}

const root = createRoot(document.getElementById('root')!);
let mounted = false;
let backoff = 1000;

function connect() {
  const ws = new WebSocket(SERVER_URL);
  setSocket(ws);

  ws.onopen = () => {
    backoff = 1000;
  };

  ws.onmessage = (msg) => {
    const tree = decode(msg.data as string);
    if (!mounted) {
      mounted = true;
      root.render(
        <Suspense fallback={<p>loading…</p>}>
          <Root first={tree} />
        </Suspense>,
      );
    } else {
      update?.(tree);
    }
  };

  ws.onclose = () => {
    setSocket(null);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  };
}
connect();
