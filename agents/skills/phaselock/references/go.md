# Go host

Go components run the TypeScript business logic via goja, a pure-Go
JavaScript interpreter (no cgo). The generated `model.go` wraps the
embedded engine with typed native APIs, so host code mostly avoids raw
JavaScript values.

**Status: proof of concept.** The Go host works for evaluation and
experiments but is not ready for serious use: the Go generator does not
handle some model shapes at all, and the Go-native store path
(`NewGoStore`) is untested — use `NewInMemStore`.

## Bundle

The component's entry stub is bundled to CJS with inline sourcemaps
(embedded stack traces then point at real TypeScript lines), and
typically embedded at compile time:

```
esbuild decider.ts --bundle --format=cjs --sourcemap=inline --outfile=decider.js
```

## Engine

The generated `model.go` provides constructors per engine in the model.
The names below (`DeciderEngine`, `DeciderQueryContext`) come from the
library example (`examples.md`):

```go
//go:embed decider.js
var deciderScript string

engine, err := model.NewDeciderEngine(
    deciderScript,
    model.NewInMemStore(),
    "deciderMigrate",
    "deciderReducer",
)
```

API:

```go
err  = engine.RecvEvents(batch)   // batch: []goja.Value (wrapped, below)
err  = engine.CaughtUp()
err  = engine.FellBehind()
ckpt, err := engine.Reconnect()   // *uint64
```

Events from KurrentDB are converted from raw JSON bytes and wrapped with
metadata:

```go
ev, err := model.JSONToGoja(vm, recorded.Data)
obj := vm.NewObject()
obj.Set("position", recorded.Position.Commit)
obj.Set("id", recorded.EventID.String())
obj.Set("data", ev)
```

## Queries

Queries use generated typed contexts and native Go result types:

```go
q := model.NewQuery(engine, func(vm *goja.Runtime, qx model.DeciderQueryContext) []model.DeciderEvents {
    return qx.Decider_events()
})
unsubscribe := q.Subscribe(func(out []model.DeciderEvents) { ... })
```

## Stores

Implement the `Txn` interface and wrap with `model.NewGoStore(txnFactory)`;
`model.NewInMemStore()` is the in-memory default.

## Validation

Structural validation: generated `Check<Union>(vm, value, path)` returns
problem strings; combine with `JSONToGoja` for zero-copy checking of raw
payloads.

## Threading

A goja runtime is single-threaded and not goroutine-safe. Confine each
engine (and any bare-checker runtime) to one goroutine, or serialize
access with a mutex. The examples batch events on a receiving goroutine
and feed the engine from one processing loop.
