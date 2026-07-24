# KESQ2 — Runtime Query Placement

Evolution of `../kesq`: flexible queries whose execution venue — browser or
query server — is chosen **per call site, at runtime**, instead of being fixed
at build time by the directive.

In `../kesq`, `'use server'` means "runs on the server" (the client gets only
a reference stub).  Here it means "*also available* on the server": the client
bundle keeps the real implementation, and the bundler routes imports through a
proxy so each factory call returns both halves:

```ts
listStats(id)  // → { $$kesq: "src/queries/server.ts#listStats", args: [id],
               //     fn: <the real query function, instantiated locally> }
```

`useQuery` takes a placement argument and picks a side:

```tsx
const stats = useQuery(client, useMemo(() => boardStats(), []), placement);
// placement: 'server' → subscribe over the websocket
// placement: 'local'  → fw.newQuery(wrapper.fn) against synced state
```

Placement is a plain runtime value.  The demo makes the point with a toggle
in the board header: click `@server ⇄` and the *same* boardStats query
re-subscribes on the other side of the wire — same numbers, different
execution venue.  Meanwhile each list's `n/m done` badge pins the *other*
factory from the same module (`listStats`) to `'local'`.

## Why this matters (see COMPETITORS.md)

Runtime placement is the mechanism behind "KESQ hydration": a cold client
could boot with every flexible query running `'server'` (first paint costs
one round trip, not a log download), background-sync the event log — the
same socket already carries it — and switch each query to `'local'` once the
framework catches up.  The switchover mechanics (gating on the log position a
pushed result reflects, swapping sources inside the subscription so React
never notices) are left as an exercise for the reader; the placement
machinery they need is what this demo builds.

## What changed vs ../kesq

- `kesq2-plugin.ts` — client side no longer stubs directive modules; it
  routes their imports through a generated proxy (`\0kesq-flex:` modules)
  that wraps each export via `kesq:runtime`'s `wrapFlex`.  The server-side
  registry (`kesq:queries`) is unchanged.
- `src/client/useQuery.ts` — grew the `placement` parameter.
- Everything else (query server, wire protocol, remote subscription
  registry, UI) is the kesq demo, on ports 3008/3009.

## Running it

Prereqs: KurrentDB devcluster and the Go relay from `../relay` running, and
`make kesq2` from `todo/` to install deps, generate `src/model.{js,d.ts}`,
and build `dist/`.

```
pnpm server   # query server: relay client + ws://localhost:3008/ws
pnpm serve    # rollup watch + static server on http://localhost:3009
```
