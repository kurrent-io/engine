# Kurrent Engine

Event-sourcing sync engine that distributes state from KurrentDB to frontend and backend services.
Business logic is written once in TypeScript and executed in multiple runtimes: browser (native),
Python (QuickJS), and Go (goja).

## Current State

This is a demo project.  The library domain (books, patrons, holds, checkouts) is a showcase for the
framework; the real product is the reusable tooling in `tools/` and `relay/_quickjs.c`.  Demo code
should be high-quality and readable but may take shortcuts (e.g. no authentication).

The UI is connected to the relay (read path works).  Next steps: wire up command sending (holds,
renames, etc.) and continue debugging the relay.

## Architecture

Three system components consume the shared model:

- **UI (browser)** - Runs framework natively in JS.  Gets virtualized status events (VHold,
  VCheckout) so it can't see other patrons' data.  Uses OverlayStorage for optimistic updates.
- **Relay (Python + QuickJS)** - Validates incoming commands (reference checks, authorization).
  Does not make domain decisions; rejects obviously invalid requests and forwards the rest.
- **Decider (Go + goja)** - Has full state, makes authoritative decisions.  Emits DeciderEvents
  (new-vhold, vhold-rejected, new-vcheckout) that flow back through the relay to clients.

KurrentDB is the event store (always required, runs locally via devcluster on port 2113).
InMemStorage, IndexedDB, etc. are for client-side materialized views, not event storage.

## Repo Layout

```
model/              Shared business logic (TypeScript)
  library.py        Data model definition (Python DSL using tools/protos.py)
  library.gen.ts    GENERATED from library.py - do not edit (edits are overwritten on rebuild)
  reducers.ts       Hand-written business logic (reducer functions for all event types)
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
  src/App.tsx           Top-level layout; renders multiple PatronWindows side by side
  src/PatronWindow.tsx  Per-patron UI: books list, holds, checkouts, name editing
  src/useFramework.ts   Hook combining framework creation + websocket lifecycle
  src/useQuery.ts       Generic React hook for framework queries (library-quality, framework-agnostic)
  src/model.{js,d.ts}   GENERATED bundles from model/ui.ts

populate.py         Utility script to seed KurrentDB with test data (run with relay/.venv/bin/python)
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
2. `relay/.venv/bin/python populate.py` - seed test data (4 editions, 8 books, 3 patrons)
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
and passed to the optional `forecaster` callback to predict server responses.  Forecasts are keyed
by command ID and discarded when matching event IDs appear in `recvEvents()`.  If a command is
rejected, call `roundTripped(id)` to explicitly discard its forecasts.

**UUID generation:** `generateUuid()` is available in all runtimes.  In browsers it uses
`crypto.getRandomValues()`.  In QuickJS it's injected from Python's `uuid.uuid4()`.  In goja it's
implemented in Go using `crypto/rand`.

**useQuery hook:** Generic over any Framework subclass.  Uses structural typing with a generic
method signature (`{ newQuery<X>(fn: QueryFunction<QX, X>): Query<X> }`) to infer the query
context type from the framework instance.

**useFramework hook:** App-specific hook that creates a `UserFramework` instance and manages the
websocket connection lifecycle (handshake, message decoding, exponential backoff reconnect capping
at 60s, enable/disable toggle).

## Working Conventions

- Do not commit or manage git history; the user handles all source control.
- Generated files (`library.gen.ts`, `model.py`, `model.go`, `ui/src/model.*`) should not be
  hand-edited except for throwaway experiments.  Change `library.py` and regenerate instead.
- Prefer larger changes; the user will ask to slow down if needed.
- No test suite is in place right now; `test.py` is throwaway, jest config is leftover.
- `useQuery.ts` should be treated as library-quality code (generic, reusable).
- `useFramework.ts` is app-specific (hardcodes relay protocol); prioritize clarity over generality.
