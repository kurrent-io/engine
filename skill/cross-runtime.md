# Cross-Runtime Usage

The core value of the framework is write-once business logic. TypeScript reducers and query
functions are bundled and executed in three different runtimes:

| Runtime | JS Engine | Language | Use Case |
|---------|-----------|----------|----------|
| Browser | Native V8/SpiderMonkey | TypeScript/JS | Client UI |
| Python  | QuickJS (via `_quickjs.c`) | Python | Relay server |
| Go      | goja | Go | Decider service |

## How It Works

1. Business logic is written in TypeScript (`model/reducers.ts`)
2. Export stubs select what each component needs (`model/{ui,relay,decider}.ts`)
3. Rollup bundles each stub into a single JS file
4. Each runtime loads and executes that bundle

```
model/reducers.ts ─┬─ model/ui.ts      ─→ rollup ─→ ui/src/model.js
                   ├─ model/relay.ts   ─→ rollup ─→ relay/relay.js
                   └─ model/decider.ts ─→ rollup ─→ decider/decider.js
```

## Browser (Native JS)

The simplest case. The bundled JS runs natively. The framework class is imported directly:

```typescript
import { UserFramework, InMemStorage, userMigrate, userReducer } from './model';

const fw = new UserFramework(new InMemStorage(), {
    migrate: userMigrate,
    reducer: userReducer,
});
```

Storage options: `InMemStorage` (default), `IndexedDBStorage` (persistent, for production PWAs).

UUID generation uses `crypto.getRandomValues()`.

## Python + QuickJS

The relay uses `_quickjs.c` to embed QuickJS in Python. The generated `model.py` provides a typed
Python interface around the JS framework.

```python
import model

fw = model.RelayFramework(
    "relay.js",          # path to bundled JS
    None,                # storage: None = use JS InMemStorage
    "relayMigrate",      # name of migrate function in bundle
    "relayReducer",      # name of reducer function in bundle
)
```

### Framework API (Python)

```python
# Feed events from KurrentDB
fw.recv_events(events)      # events are dicts matching RealEvent shape

# Get checkpoint for reconnecting
checkpoint = fw.reconnect()  # returns int | None

# Lifecycle
fw.caught_up()
fw.fell_behind()

# Run validation without modifying state
result = fw.simulate(validator_fn, events)
```

### Query Context

Python queries use a Python query context (`QX`) that bridges to the JS storage. The generated
framework subclass wires this up automatically:

```python
class RelayQueryContext:
    def __init__(self, ask):
        self.get = RelayQueryContextGet(ask)

# The framework creates this for you
qx = RelayQueryContext()
```

### Storage

- `None` (default): Uses `InMemStorage` from the JS bundle
- Custom `Txn` protocol: Implement `get`, `set`, `delete`, `commit`, `abort` for persistent
  storage (e.g. LMDB)

### UUID Generation

`uuid.uuid4()` is injected into the QuickJS environment as `generateUuid()` via `_quickjs.c`.

## Go + goja

The decider uses goja, a pure-Go JavaScript interpreter. The generated `model/model.go` provides
typed Go wrappers.

```go
fw, err := model.NewDeciderFramework(
    deciderScript,           // embedded JS string
    model.NewInMemStorage(), // Go-side storage
    "deciderMigrate",
    "deciderReducer",
)
```

### Framework API (Go)

```go
// Feed events (pre-wrapped in metadata as goja.Value objects)
err := fw.RecvEvents(batch)

// Get checkpoint for reconnecting
checkpoint, err := fw.Reconnect()  // returns *uint64, error

// Lifecycle
err := fw.CaughtUp()
err := fw.FellBehind()
```

### Queries (Go)

Go queries use a Go query context with typed accessors:

```go
query := model.NewQuery(fw, func(vm *goja.Runtime, qx model.DeciderQX, prev *MyResult) MyResult {
    // qx.Get.Edition(isbn) etc.
    // Returns typed Go values
})

result := query.Start()
unsub := query.Subscribe(func(val MyResult) { ... })
```

### Storage

- `model.NewInMemStorage()`: In-memory (default)
- `model.GoStorage`: Implement the `Storage` interface for persistent backends

### UUID Generation

`generateUuid()` is injected into the goja environment using `crypto/rand` for randomness,
producing RFC 4122 v4 UUIDs.

### Event Conversion

Events from KurrentDB must be converted to goja values with metadata:

```go
ev, err := model.JSONToGoja(vm, recordedEvent.Data)
obj := vm.NewObject()
obj.Set("position", recordedEvent.Position.Commit)
obj.Set("id", recordedEvent.EventID.String())
obj.Set("data", ev)
```

## Code Generation

Each target language has its own code generator:

| Generator | Input | Output | What it generates |
|-----------|-------|--------|-------------------|
| `gen_ts.py` | `library.py` | `library.gen.ts` | Types, decoders, store accessors, framework subclasses |
| `gen_py.py` | `library.py` | `model.py` | Protocol types, checkers, query contexts, framework subclass |
| `gen_go.py` | `library.py` | `model.go` | Go types, converters, query contexts, framework subclass |

Run all generators with `make`. The generators read `library.py` and the skeleton files
(`skeleton.{ts,py,go}`) which contain the runtime framework code.

## Environment Setup

Each runtime needs `generateUuid()` available as a global. The framework skeleton code handles
this:

- **Browser**: Defined in `skeleton.ts`, uses `crypto.getRandomValues()`
- **QuickJS**: Injected by `_quickjs.c` from Python's `uuid.uuid4()`
- **goja**: Injected in `skeleton.go` using `crypto/rand`

If `generateUuid` is already defined in `globalThis` (e.g. injected by the host), the browser
version defers to it.
