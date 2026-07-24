# KESQ — Kurrent Engine Server Queries

A third face for the todo demo: the same framework, reducers, and query style
as the browser UI, but with a `'use server'` directive that moves individual
queries to a server-side framework instance.  Local and server queries mix
freely in one app with identical call sites — the directive on the query's
module is its entire deployment story.

```
src/queries/local.ts    query factories, run in the browser against synced state
src/queries/server.ts   'use server' — run on the query server; results pushed
```

Both are used from components the same way:

```tsx
const lists = useQuery(client, useMemo(() => allLists(), []));          // local
const stats = useQuery(client, useMemo(() => boardStats(), []));        // server
const ls    = useQuery(client, useMemo(() => listStats(id), [id]));     // server, with args
```

## How it works

- `kesq-plugin.ts` — the bundler integration (see the comment at the top).
  In the client build, `'use server'` modules are replaced by stubs whose
  factories return `{$$kesq: "<module>#<export>", args}` references.  In the
  server build, the virtual module `kesq:queries` registers the real
  factories under the same ids.
- `src/server/main.ts` — the query server.  Runs its own framework instance
  as an ordinary relay client (the same code path the browser uses, in Node),
  and serves one websocket to browsers carrying three flows: the relay event
  stream (proxied per-connection, so local queries and catchup work exactly
  as against the relay directly), commands going up, and server-query
  subscriptions (`subscribe`/`result`/`unsubscribe`).
- `src/client/remote.ts` + `useQuery.ts` — `useQuery` accepts whatever a
  query factory returns.  A real query function runs through `fw.newQuery`;
  a stub reference becomes a websocket subscription presenting the same
  subscribe/close interface.  Subscriptions are re-issued on reconnect.

Server query results cross the wire as plain JSON view-models — no flight
protocol, no React on the server.

The trade-off to know about: server queries reflect the query server's state
and update a round-trip later than local ones, and they don't see forecast
overlays (this demo has no forecaster, so nothing is lost here).

## Running it

Prereqs: KurrentDB devcluster and the Go relay from `../relay` running (see
the todo demo makefile), and `make kesq` from `todo/` to install deps,
generate `src/model.{js,d.ts}`, and build `dist/`.

```
pnpm server   # query server: relay client + ws://localhost:3006/ws
pnpm serve    # rollup watch + static server on http://localhost:3007
```

Restart `pnpm server` after changing server-side code (rebuilds are not hot).
