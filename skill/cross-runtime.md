# Cross-Runtime Usage

The core value of the framework is write-once business logic.  TypeScript reducers and query
functions are bundled and executed in three different runtimes:

| Runtime | JS Engine | Host Language | Typical Use |
|---------|-----------|---------------|-------------|
| Browser | Native V8/SpiderMonkey | TypeScript/JS | Client UI |
| Python  | QuickJS (via `_quickjs.c`) | Python | Relay server |
| Go      | goja | Go | Relay or decider service |

A given demo picks the runtimes it needs.  The library demo uses all three (JS for UI, Python for
the relay, Go for the decider).  The todo demo uses two (JS for UI, Go for the relay; no decider).

## How It Works

1. Business logic is written in TypeScript (`<demo>/model/reducers.ts`).
2. Per-component export stubs select what each runtime needs
   (`<demo>/model/{ui,relay,decider}.ts`).
3. Rollup bundles each stub into a single JS file.
4. Each runtime loads and executes its bundle.

```
model/reducers.ts ─┬─ model/ui.ts      → rollup → ui/src/model.js
                   ├─ model/relay.ts   → rollup → relay/relay.js
                   └─ model/decider.ts → rollup → decider/decider.js
```

## Browser (Native JS)

The simplest case: the bundled JS runs natively.  Import the demo's framework class directly:

```typescript
import { TodoFramework, InMemStorage, migrateTodos, reduceTodos } from './model';

const fw = new TodoFramework(new InMemStorage(), {
    migrate: migrateTodos,
    reducer: reduceTodos,
});
```

Storage options: `InMemStorage` (default, ephemeral), `IndexedDBStorage` (persistent, for PWAs).

UUID generation uses `crypto.getRandomValues()`.

## Python + QuickJS

The Python relay uses `_quickjs.c` (the QuickJS Python bindings, reusable across projects) to
embed QuickJS.  The generated `model.py` provides typed Python wrappers around the JS framework:

```python
import model

fw = model.RelayFramework(
    "relay.js",          # path to bundled JS
    None,                # storage: None = use JS-side InMemStorage
    "relayMigrate",      # name of the migrate export in the bundle
    "relayReducer",
)
```

### Framework API (Python)

```python
fw.recv_events(events)       # events match the RealEvent shape (id, data, position)
checkpoint = fw.reconnect()  # returns int | None
fw.caught_up()
fw.fell_behind()
result = fw.simulate(validator_fn, events)  # run reducer without committing
```

### Query Context

Python queries use a query context (`QX`) generated from the demo's `Store` definitions, with
typed get/set accessors that bridge to JS storage:

```python
qx = MyQueryContext(ask)   # the framework wires this up automatically
qx.get.some_key()
```

### Storage

- `None` (default): JS-side `InMemStorage`.
- Custom `Txn` protocol: implement `get`, `set`, `delete`, `commit`, `abort` for persistent
  storage (e.g. LMDB).

### Date Handling

`_quickjs.c` handles JS `Date` ↔ Python `datetime.datetime` conversion natively.  JS `Date`
crossing into Python becomes a UTC `datetime.datetime` (via `valueOf()` → timestamp).  Python
`datetime.datetime` crossing into JS becomes `new Date(ms)`.  UTC only; non-UTC datetimes raise
`ValueError`.

### UUID Generation

`uuid.uuid4()` is injected into the QuickJS environment as `generateUuid()` by `_quickjs.c`.

## Go + goja

Go components (relays or deciders) use goja, a pure-Go JavaScript interpreter.  The generated
`model/model.go` provides typed Go wrappers around the JS framework.

```go
fw, err := model.NewYourFramework(
    bundledJS,                  // embedded JS string
    model.NewInMemStorage(),    // Go-side storage
    "migrate",
    "reducer",
)
```

### Framework API (Go)

```go
err := fw.RecvEvents(batch)       // batch is []goja.Value, each a wrapped RealEvent
checkpoint, err := fw.Reconnect() // returns *uint64, error
err := fw.CaughtUp()
err := fw.FellBehind()
```

### Queries (Go)

Go queries use a typed Go query context:

```go
query := model.NewQuery(fw, func(vm *goja.Runtime, qx model.YourQX, prev *MyResult) MyResult {
    // qx.Get.SomeKey() etc.
})

result := query.Start()
unsub := query.Subscribe(func(val MyResult) { ... })
```

### Storage

- `model.NewInMemStorage()` — in-memory default.
- `model.GoStorage` — implement the `Storage` interface for persistent backends.

### UUID Generation

`generateUuid()` is injected into the goja environment using `crypto/rand`, producing RFC 4122 v4
UUIDs.

### Event Conversion

Events from KurrentDB must be converted to goja values with metadata before being fed to the
framework:

```go
ev, err := model.JSONToGoja(vm, recordedEvent.Data)
obj := vm.NewObject()
obj.Set("position", recordedEvent.Position.Commit)
obj.Set("id", recordedEvent.EventID.String())
obj.Set("data", ev)
```

### Structural Validation

The Go codegen also produces `Check*` functions for validating raw JSON against the schema.
These are useful in relays that want structural-only validation without instantiating a full
framework:

```go
value, err := model.JSONToGoja(vm, payload)
if err != nil { return err }
return model.CheckYourEvents(value, "data")
```

A single goja runtime is enough for validation; it's not goroutine-safe, so serialize access
with a mutex.

## Code Generation

| Emitter | Input | Output | Generates |
|---------|-------|--------|-----------|
| `@kurrent/typespec-engine-ts` | `main.tsp` | `<demo>.gen.ts` | Types, decoders, store accessors, framework subclasses |
| `@kurrent/typespec-engine-py` | `main.tsp` | `model.py` | Protocol types, checkers, query contexts, framework subclass |
| `@kurrent/typespec-engine-go` | `main.tsp` | `model.go` | Go types, converters, query contexts, framework subclass, `Check*` validators |

Run `make` in the demo directory to regenerate everything.  The emitters read the demo's model
file (e.g. `model/library.tsp`) and prepend their runtime skeleton
(`tools/emitter-{ts,py,go}/assets/skeleton.*`), which contains the runtime framework
code.

## Environment Setup

Each runtime needs `generateUuid()` available as a global.  The skeleton handles this:

- **Browser**: defined in the TS skeleton, uses `crypto.getRandomValues()`.
- **QuickJS**: injected by `_quickjs.c` from Python's `uuid.uuid4()`.
- **goja**: injected in the Go skeleton using `crypto/rand`.

If `generateUuid` is already defined in `globalThis` (e.g. injected by the host), the browser
version defers to it.
