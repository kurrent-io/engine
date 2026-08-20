# Python host

Python components run the TypeScript business logic via QuickJS. The
generated `model.py` wraps the embedded engine with typed native APIs,
so host code never touches JavaScript values directly. The QuickJS
extension ships as its own package (`kurrent-phaselock-quickjs`,
imported as `kurrent.phaselock._quickjs`); `model.py` imports it
internally.

**Status:** The Python host works end to end — engine, live queries, and
external stores. Expect rough edges in packaging: the generation step is
multi-layered (emit `model.gen.ts` and `model.py`, bundle the entry stub,
glue the two together at runtime), and the QuickJS extension must
currently be built from source.

## Bundle

The component's entry stub is bundled to ESM with inline sourcemaps
(embedded stack traces then point at real TypeScript lines):

```
esbuild relay.ts --bundle --format=esm --sourcemap=inline --outfile=relay.js
```

## Engine

The generated `model.py` provides a `<Name>Engine` class per engine in
the model. The names below (`RelayEngine`, `validateUserCommands`) come
from the library example (`examples.md`):

```python
import model

engine = model.RelayEngine(
    "relay.js",       # path to the bundled JS
    None,             # store: None = in-memory (JS-side)
    "relayMigrate",   # name of the migrate export in the bundle
    "relayReducer",   # name of the reducer export
)
```

API (snake_case mirrors of the engine):

```python
engine.recv_events(events)   # dicts shaped {position, id, data}
engine.caught_up()
engine.fell_behind()
ckpt = engine.reconnect()    # int | None
result = engine.simulate(fn, batch)   # fn from engine.module[...]
q = engine.new_query(query_generator) # async-style typed query context
```

`engine.module["validateUserCommands"]` reaches any export of the bundle;
wrap it with connection args before handing to `simulate`.

## Stores

Pass a transaction factory instead of `None` — a callable
`(writable: bool) -> Txn` where `Txn` has `get`/`set`/`delete`/
`commit`/`abort`. Synchronous stores only (LMDB is the proven fit).

## Validation

Structural validation without an engine: the generated `check*` functions
take plain dicts and return a list of problems; `model.check_identified(obj,
model.check_user_commands)` validates the `Identified` wrapper plus body.

## Host bridging

Dates bridge natively: JS `Date` ↔ UTC `datetime.datetime` (non-UTC
raises). `generateUuid()` inside JS is backed by Python's `uuid.uuid4()`.
