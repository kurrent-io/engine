# KESQ2 — Runtime Query Placement

Evolution of `../kesq`: queries whose execution venue — browser or query
server — is chosen **per call site, at runtime**, with the setup cost scaling
with how much wire capability a query needs.

## The three tiers

Running client-side is the native mode and requires nothing:

| tier | you write | it runs | setup |
|---|---|---|---|
| **local** | a plain factory, anywhere (`src/queries/local.ts`) | in the browser, via `fw.newQuery` | none |
| **flexible** | the same factory, in a `*.flex.ts` module | either side, chosen per call site | codegen + import from `#queries/…` |
| **server-only** | the same factory, in a `*.server.ts` module | only on the query server | same; the client gets a bare wire reference |

The factory shape is identical across tiers — compare `local.ts` and
`stats.flex.ts` — the filename suffix is the only difference.  Flexible and
server-only factories must take serializable arguments, since calls may cross
the wire.

## How it works

`gen-queries.mjs` scans `src/queries` for suffixed modules and mirrors them
into `gen/`:

- `gen/client/<stem>.ts` — flexible exports wrapped via `wrapFlex`, so calling
  `listStats(id)` returns `{ $$kesq: "stats#listStats", args: [id], fn: <the
  query function, instantiated locally> }`: the wire reference and the local
  implementation side by side.  Server-only exports become `serverRef` stubs —
  the reference alone, typed `ServerQuery<T>`; the implementation is imported
  type-only, so it never enters the browser bundle.
- `gen/server/<stem>.ts` — everything wrapped via `wrapFlex` (on the server
  the implementation is always available).
- `gen/server/registry.ts` — raw factories keyed by `"<stem>#<export>"`, for
  the query server's subscribe dispatch.

The package.json `imports` field routes `#queries/*` by environment — no
bundler plugin, just Node-standard conditional imports (the `browser`
condition for client builds, `default` otherwise), which tsc mirrors via
`customConditions`:

```json
"#queries/*": { "browser": "./gen/client/*.ts", "default": "./gen/server/*.ts" }
```

`useQuery` accepts all three tiers, and its overloads enforce them: a plain
factory takes no placement, a flexible query takes an optional placement
(default `'local'`), and passing a placement with a server-only query is a
compile error.

```tsx
const stats = useQuery(client, useMemo(() => boardStats(), []), placement);
// placement: 'server' → subscribe over the websocket
// placement: 'local'  → fw.newQuery(wrapper.fn) against synced state
```

The demo makes the point with a toggle in the board header: click `@server ⇄`
and the *same* boardStats query re-subscribes on the other side of the wire —
same numbers, different execution venue.  Each list's `n/m done` badge pins
the other factory from the same module (`listStats`) to `'local'`, and the
`archived @server` badge is a server-only query (`archive.server.ts`).

Flexible queries degrade gracefully: if the server rejects a subscription
(unknown id after a deploy, say), the client logs the reason and re-runs the
query locally behind the same subscription surface.  Server-only queries have
no fallback — that's the tier's contract.

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

- No bundler plugin: the `'use server'` directive is replaced by filename
  suffixes, and the rollup transform by `gen-queries.mjs` + conditional
  imports.  The build works with any bundler that resolves package imports.
- Types are honest: query factories' generated types say what they return
  (`FlexQuery` / `ServerQuery`), instead of the client build swapping
  implementations behind unchanged source types.
- A server-only tier, with the implementation structurally excluded from the
  browser bundle.
- The wire protocol grew `{type: "error", sub, reason}` for rejected
  subscriptions, and the client a local fallback for flexible queries.
- Everything else (query server, remote subscription registry, UI) is the
  kesq demo, on ports 3008/3009.

## Running it

Prereqs: KurrentDB devcluster and the Go relay from `../relay` running, and
`make kesq2` from `todo/` to install deps, generate `src/model.{js,d.ts}`,
and build `dist/` (query codegen runs as part of `pnpm build`).

```
pnpm server   # query server: relay client + ws://localhost:3008/ws
pnpm serve    # rollup watch + static server on http://localhost:3009
```
