# RSC over WebSocket

A third face for the todo demo: the UI is rendered as React Server Components
on a Node "flight server" and pushed to browsers over a websocket, instead of
running the framework in the browser.

## How it works

- `src/server/main.tsx` — the flight server.  It connects to the Go relay as
  an ordinary framework client (the same code path the browser UI uses, just
  running in Node with `InMemStorage`), subscribes to a query over the reduced
  state, and on every change renders `src/server/App.tsx` to a flight payload
  (React's serialized component-tree format) and broadcasts it to connected
  browsers over its own websocket.  Commands flow the other way up the same
  socket and are forwarded to the relay, so all business state lives server
  side; the browser holds only component-local UI state.
- `src/server/App.tsx` — server components.  Never shipped to the browser as
  code; only their rendered output crosses the wire.
- `src/client/interactive.tsx` — the `'use client'` components (the
  interactive leaves).  These ship to the browser and receive their props from
  the flight payload; server-rendered children flow *through* them.
- `src/client/index.tsx` — browser bootstrap: deserializes each pushed payload
  into a React tree inside a transition, so client component state survives
  server re-renders.
- `rsc-plugin.ts` — the bundler integration (see the comment at the top of
  the file): stubs `'use client'` modules out of the server build as client
  references, and registers the real modules in the client build under the
  same ids.

One payload message per render (no mid-render streaming): the state is local
and synchronous, so nothing suspends and chunked delivery would buy nothing.

## Running it

Prereqs: KurrentDB devcluster and the Go relay from `../relay` running (see
the todo demo makefile), and `make rsc` from `todo/` to install deps, generate
`src/model.{js,d.ts}`, and build `dist/`.

```
pnpm server   # flight server: relay client + ws://localhost:3004/ws
pnpm serve    # rollup watch + static server on http://localhost:3005
```

`pnpm server` runs node with `--conditions react-server`, which is what makes
`react` resolve to its server-components build inside `dist/server.js`.
Rebuilds are not hot: restart it after changing server-side code.
