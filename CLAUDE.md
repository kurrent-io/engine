# Kurrent Engine

Event-sourcing sync engine that distributes state from KurrentDB to frontend and backend services.
Business logic is written once in TypeScript and executed in multiple runtimes: browser (native),
Python (QuickJS), and Go (goja).

## Current State

This is a demo project.  The library domain (books, patrons, holds, checkouts) is a showcase for the
framework; the real product is the reusable tooling in `tools/` and `relay/_quickjs.c`.  Demo code
should be high-quality and readable but may take shortcuts (e.g. no authentication).

The UI is connected to the relay.  Read path, command sending (holds, cancels, renames), and
forecasting all work.  Admin window supports editing patrons, editions, books, and managing
holds/checkouts.  Next steps: continue debugging edge cases.

## Architecture

Three system components consume the shared model:

- **UI (browser)** - Runs framework natively in JS.  Patron clients get virtualized status events
  (VHold, VCheckout) so they can't see other patrons' data; admin clients see real status.  Uses
  OverlayStorage for optimistic updates.
- **Relay (Python + QuickJS)** - Validates incoming commands (reference checks, authorization).
  Does not make domain decisions; rejects obviously invalid requests and forwards the rest.
- **Decider (Go + goja)** - Has full state, makes authoritative decisions.  Emits DeciderEvents
  (new-vhold, vhold-rejected, end-vhold, new-vcheckout) that flow back through the relay to clients.

KurrentDB is the event store (always required, runs locally via devcluster on port 2113).
InMemStorage, IndexedDB, etc. are for client-side materialized views, not event storage.

## Repo Layout

```
model/              Shared business logic (TypeScript)
  library.py        Data model definition (Python DSL using tools/protos.py)
  library.gen.ts    GENERATED from library.py - do not edit (edits are overwritten on rebuild)
  reducers.ts       Hand-written business logic (reducer functions for all event types)
  reducers.test.ts  Jest tests for reducers (using generated ReducerTester)
  {ui,relay,decider}.ts   Export stubs for each system component

tools/              Reusable codegen tooling
  protos.py         Type system DSL (Struct, Union, Store, Framework, etc.)
  gen_{ts,py,go}.py Code generators
  skeleton.{ts,py,go}  Generator templates

relay/              Python relay server
  relay.py          WebSocket server (aiohttp); handles auth, event dispatch, command validation
  _quickjs.c        QuickJS Python bindings (reusable across projects)
  quickjs/          QuickJS source

decider/            Go decider service
  main.go           Entry point
  model/model.go    GENERATED from library.py

ui/                 Frontend (React 19 + Ant Design 6 + @ant-design/icons)
  src/App.tsx           Top-level layout; renders AdminWindow + PatronWindows side by side
  src/AdminWindow.tsx   Admin UI: patron editing, edition/book management, hold/checkout actions
  src/PatronWindow.tsx  Per-patron UI: books list, holds, checkouts, name editing
  src/useFramework.ts   Hook combining framework creation + websocket lifecycle
  src/useQuery.ts       Generic React hook for framework queries (library-quality, framework-agnostic)
  src/colorhash.ts      Deterministic HSL color from string (for patron color correlation)
  src/model.{js,d.ts}   GENERATED bundles from model/ui.ts

skill/              Developer skill files for building apps on this framework
  data-model.md     Python DSL for defining types, events, stores, frameworks
  reducers.md       Generator-based reducers, rx contexts, composition
  relay.md          Relay architecture, websocket protocol, validation
  decider.md        Go+goja decider, decision events, at-most-one semantics
  frontend.md       React integration, useFramework, useQuery, commands, forecasting
  cross-runtime.md  Browser/Python/Go runtimes, code generation, UUID injection

populate.py         Utility script to seed KurrentDB with test data (run with relay/.venv/bin/python)
dump.py             Utility to dump events from a KurrentDB stream as JSON
devcluster.yaml     Config for running KurrentDB locally via devcluster
```

## Build System

Run `make` to build everything.  Key targets:

- `make model` - Regenerate `library.gen.ts` from Python DSL
- `make relay` - Bundle relay JS + generate model.py + compile _quickjs.so
- `make decider` - Bundle decider JS + generate Go model + build Go binary
- `make ui` - Bundle UI JS + generate .d.ts
- `make check` - Type checking (tsc for model/UI, mypy for relay)
- `make ui/check` - Type check UI only

Prerequisites: `cd model && pnpm i` and `cd ui && pnpm i` for dependencies.

When changing `library.py` or codegen in `tools/`, run `make` to regenerate all outputs.

## Running the Demo

1. `devcluster --config devcluster.yaml` - start KurrentDB on port 2113
2. `relay/.venv/bin/python populate.py` - seed test data (4 editions, 8 books, 2 patrons)
3. `cd relay && .venv/bin/python relay.py` - start relay on port 3003
4. `cd ui && pnpm serve` - start UI on http://localhost:3000

## Key Patterns

**Generator-based reducers:** The framework uses generators (`yield*`) instead of async/await
because async does not work well with IndexedDB transactions (which require same-stackframe
execution).  Think of `yield*` as `await`.  A side benefit is that generators allow sandboxing and
transparent interception of all storage calls (useful for caching, overlay storage, etc.).

**Typed storage contexts:** Reducers receive an `rx` parameter with typed `get`/`set`/`update`/`del`
operations generated from the Store definitions in `library.py`.  Query functions receive a `qx`
parameter with read-only access.

**Event metadata:** All events are wrapped in metadata.  `Event<T> = {id, data}` is the base
wrapper (used for commands and forecasts).  `RealEvent<T> = Event<T> & {position}` adds the
KurrentDB commit position (used for events from the wire).  The framework handles decoding
internally via `decodeEvent`/`decodeCommand` callbacks passed to the constructor.

**Event flow:** Commands arrive at the relay, get validated, are written to KurrentDB.  The decider
reads events, applies reducers (which may accept or reject), and emits decision events.  Decision
events flow back through the relay to clients as virtualized status updates.

**WebSocket protocol:** Clients connect to `ws://localhost:3003/ws`.  First message is a JSON
handshake: `{"patron_id": "...", "since": <number|null>}`.  Server sends `RealEvent`-shaped
messages: `{"position": <N>, "id": "<uuid>", "data": <LibraryEvent>}`, plus a bare `"caughtup"`
string when the catchup phase is complete.  Clients send commands as `Event`-shaped messages:
`{"id": "<uuid>", "data": <command>}`.

**Framework lifecycle:** The framework has `caughtUp()` and `fellBehind()` methods to control when
queries execute.  During catchup, events are buffered and the query graph is frozen.  When
`caughtUp()` is called, the overlay is rebuilt and all queries run at once.

**Forecasting:** When `sendCommands()` is called, commands are assigned UUIDs, persisted to storage,
and passed to the optional `forecaster` callback to predict server responses.  The `userForecaster`
predicts `new-vhold` (with `forecasted: true`) for `try-hold` commands, and passes through
`rename-patron` and `cancel-hold` directly.  Forecasts are keyed by command ID and discarded when
matching event IDs appear in `recvEvents()`.  Reducers can also return a `markedSent` array of
partial command shapes to match unsent commands by content (used when the round-tripped event has a
different ID than the original command, e.g. `try-hold` → `new-vhold`).  Call `markSent(id)` to
explicitly discard forecasts by event ID.

**UUID generation:** `generateUuid()` is available in all runtimes.  In browsers it uses
`crypto.getRandomValues()`.  In QuickJS it's injected from Python's `uuid.uuid4()`.  In goja it's
implemented in Go using `crypto/rand`.

**useQuery hook:** Generic over any Framework subclass.  Uses structural typing with a generic
method signature (`{ newQuery<X>(fn: QueryFunction<QX, X>): Query<X> }`) to infer the query
context type from the framework instance.

**useFramework hook:** App-specific hook that manages websocket connection lifecycle (handshake,
message decoding, exponential backoff reconnect capping at 60s, enable/disable toggle).  Overloaded:
`useFramework(url, enabled)` returns `AdminFramework`; `useFramework(url, enabled, patronId)`
returns `UserFramework`.

## Working Conventions

- Do not commit or manage git history; the user handles all source control.
- Generated files (`library.gen.ts`, `model.py`, `model.go`, `ui/src/model.*`) should not be
  hand-edited except for throwaway experiments.  Change `library.py` and regenerate instead.
- Prefer larger changes; the user will ask to slow down if needed.
- Reducer tests use the generated `ReducerTester` class: `cd model && pnpm test`.  `test.py` is
  throwaway.
- `useQuery.ts` should be treated as library-quality code (generic, reusable).
- `useFramework.ts` is app-specific (hardcodes relay protocol); prioritize clarity over generality.
