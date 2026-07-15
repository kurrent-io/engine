# Kurrent Engine

Event-sourcing sync engine that distributes state from KurrentDB to frontend and backend services.
Business logic is written once in TypeScript and executed in multiple runtimes: browser (native),
Python (QuickJS), and Go (goja).

## Current State

The framework (`tools/`, `relay/_quickjs.c`, the runtime skeletons) is the real product.  Demos in
this repo exercise the framework end-to-end against a concrete domain.

Demos:

- **Library** (root: `model/`, `relay/`, `decider/`, `ui/`) — books, patrons, holds, checkouts.
  Mature: relay (Python+QuickJS) + decider (Go+goja) + UI all working, including command sending,
  forecasting/optimistic updates, and virtualized per-patron status events.
- **Todo** (`todo/`) — a collaborative todo list.  Newer and intentionally minimal: single shared
  stream, no decider, structural-only command validation.  Relay is written in Go (instead of
  Python) to show the alternate runtime path.  No forecasting yet.

Demo code should be high-quality and readable but may take shortcuts (e.g. no authentication).

## Architecture

Each demo composes one or more system components that share a single TypeScript business-logic
codebase:

- **UI (browser)** — Runs the framework natively in JS.  Per-window in-memory storage (or
  IndexedDB for persistence).  Optionally uses `OverlayStorage` to layer forecasted events for
  optimistic UI.
- **Relay (Python+QuickJS or Go+goja)** — WebSocket server.  Validates incoming commands
  structurally (and optionally semantically via `fw.simulate()`), writes accepted commands to
  KurrentDB, and streams events back to clients.  May virtualize / sanitize events on the way out
  (e.g. per-user views).
- **Decider (Go+goja)** — Optional.  Has full state, makes authoritative decisions that require
  global ordering (e.g. resolving races between simultaneous commands).  Emits decision events
  that flow back through the relay.

Simpler demos (like the todo demo) may have no decider and no virtualization — just a relay
that appends and broadcasts.

KurrentDB is the event store (always required for non-trivial demos; runs locally via devcluster on
port 2113).  `InMemStorage`, `IndexedDBStorage`, etc. are for client-side or component-local
materialized views — not event storage.

## Repo Layout

```
tools/              Reusable framework + codegen tooling
  protos.py         Type system DSL (Struct, Union, Store, Framework, ...)
  gen_{ts,py,go}.py Code generators
  skeleton.{ts,py,go}  Runtime skeletons compiled into each target language
  typespec/         Experimental TypeSpec replacement for the Python DSL — read
                    tools/typespec/CLAUDE.md for status + settled design decisions
                    before working on it

relay/_quickjs.c    Reusable Python ↔ QuickJS bindings (used by Python relays)

skill/              Developer skill files for building apps on the framework
  data-model.md     Python DSL for defining types, events, stores, frameworks
  reducers.md       Generator-based reducers, rx contexts, composition
  relay.md          Relay architecture, websocket protocol, validation
  decider.md        Go+goja decider, decision events, at-most-one semantics
  frontend.md       React integration, useFramework, useQuery, commands, forecasting
  cross-runtime.md  Browser/Python/Go runtimes, code generation, UUID injection

# Library demo (full architecture: Python relay + Go decider + forecasting UI)
model/              Shared business logic
  library.py        Data model (Python DSL)
  library.gen.ts    GENERATED — do not edit
  reducers.ts       Hand-written reducer functions
  reducers.test.ts  Jest tests (using generated ReducerTester)
  {ui,relay,decider}.ts   Export stubs for each system component
relay/              Python relay server
decider/            Go decider service
ui/                 React frontend
populate.py         Seed KurrentDB with test data
dump.py             Dump events from a stream
devcluster.yaml     Local KurrentDB config

# Todo demo (minimal: Go relay only, single stream, no decider)
todo/
  model/            model.py, reducers.ts, relay.ts, ui.ts
  relay/            Go relay + generated model.go
  ui/               React frontend
  makefile          Demo-local build
```

## Build System

Each demo has its own makefile (root for library, `todo/makefile` for todo) with the same target
shape:

- `make model` — Regenerate `*.gen.ts` from the Python DSL
- `make relay` — Bundle relay JS, generate relay-side model bindings (Python or Go), build the
  relay binary
- `make decider` — (Library only) Bundle decider JS, generate Go model, build the decider binary
- `make ui` — Bundle UI JS and `.d.ts` from `model/ui.ts`
- `make check` — Type checking
- `make` — Build everything

Prerequisites: `cd model && pnpm i` and `cd ui && pnpm i` (per demo).

When changing the demo's `.py` data model or any codegen in `tools/`, run `make` to regenerate.

## Key Patterns

**Generator-based reducers:** The framework uses generators (`yield*`) instead of async/await
because async does not work well with IndexedDB transactions (which require same-stackframe
execution).  Think of `yield*` as `await`.  A side benefit is that generators allow sandboxing and
transparent interception of all storage calls (useful for caching, overlay storage, etc.).

**Typed storage contexts:** Reducers receive an `rx` parameter with typed `get`/`set`/`update`/`del`
operations generated from the `Store` definitions in the demo's `.py`.  Query functions receive a
`qx` parameter with read-only access.

**Event metadata:** All events are wrapped in metadata.  `Event<T> = {id, data}` is the base
wrapper (used for commands and forecasts).  `RealEvent<T> = Event<T> & {position}` adds the
KurrentDB commit position (used for events from the wire).  The framework handles decoding
internally via `decodeEvent`/`decodeCommand` callbacks passed to the constructor.

**Event flow:** Commands arrive at the relay, get validated, are written to KurrentDB.  Optionally
a decider reads events, applies reducers (which may accept or reject), and emits decision events.
Events flow back through the relay to clients, possibly virtualized or sanitized.

**WebSocket protocol:** Clients connect to `ws://<host>:<port>/ws`.  First message is a JSON
handshake — at minimum `{"since": <number|null>}`, with any additional auth/identity fields the
demo requires.  Server sends `RealEvent`-shaped messages: `{"position": <N>, "id": "<uuid>",
"data": <event>}`, plus a bare `"caughtup"` string when the catchup phase is complete.  Clients
send commands as `Event`-shaped messages: `{"id": "<uuid>", "data": <command>}`.

**Framework lifecycle:** The framework has `caughtUp()` and `fellBehind()` methods to control when
queries execute.  During catchup, events are buffered and the query graph is frozen.  When
`caughtUp()` is called, the overlay is rebuilt and all queries run at once.

**Forecasting:** When `sendCommands()` is called, commands are assigned UUIDs, persisted to storage,
and passed to the optional `forecaster` callback to predict server responses.  Forecasts are keyed
by command ID and discarded when matching event IDs appear in `recvEvents()`.  Reducers can also
return a `markedSent` array of partial command shapes to match unsent commands by content (used
when the round-tripped event has a different ID than the original command).  Call `markSent(id)` to
explicitly discard forecasts by event ID.

**UUID generation:** `generateUuid()` is available in all runtimes.  In browsers it uses
`crypto.getRandomValues()`.  In QuickJS it's injected from Python's `uuid.uuid4()`.  In goja it's
implemented in Go using `crypto/rand`.

**useQuery hook:** Generic over any Framework subclass.  Uses structural typing with a generic
method signature (`{ newQuery<X>(fn: QueryFunction<QX, X>): Query<X> }`) to infer the query
context type from the framework instance.  Library-quality; treat as reusable across demos.

**useFramework hook:** App-specific.  Manages websocket connection lifecycle (handshake, message
decoding, reconnect, enable/disable).  May be a single function or overloaded depending on whether
the demo distinguishes user types.  Prioritize clarity over generality.

## Working Conventions

- Do not commit or manage git history; the user handles all source control.
- Generated files (`*.gen.ts`, generated `model.py`, `model.go`, `ui/src/model.*`) should not be
  hand-edited except for throwaway experiments.  Change the demo's `.py` and regenerate instead.
- The user typically drives `make` themselves after editing `.py` — read the regenerated files
  rather than re-running codegen unprompted.
- Prefer larger changes; the user will ask to slow down if needed.
- Reducer tests use the generated `ReducerTester` class.  `cd <demo>/model && pnpm test`.
- `useQuery.ts` is library-quality code (generic, reusable across demos).
- `useFramework.ts` is app-specific (hardcodes the demo's relay protocol); prioritize clarity.
- **Ask for help as soon as you are confused.**  If a result contradicts your model of what should
  happen, do not keep poking at it with more commands hoping it will resolve.  Stop, summarize what
  you observed and what you expected, and ask the user.  Burning rounds on cache theories, weird
  Go behavior, "maybe it's a build artifact" etc. is wasted effort — the user usually sees the
  answer immediately (e.g. wrong cwd, stale file, missing step).
