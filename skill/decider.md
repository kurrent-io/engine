# Building a Decider

The decider is the authoritative component that processes events after global ordering is
established by KurrentDB. It makes domain-level decisions (accept/reject holds, checkouts, etc.)
and emits decision events that flow back to clients through the relay.

## Role in the Architecture

```
clients -> relay (validates) -> KurrentDB -> decider (decides) -> KurrentDB -> relay -> clients
```

The relay prevents obviously invalid commands. The decider resolves race conditions and enforces
business rules that require global state. For example, two patrons might simultaneously try to hold
the last copy of a book - the relay allows both (since each is individually valid), but the decider
accepts only the first one it sees in the global order.

## Go + goja Architecture

The decider runs in Go, executing the TypeScript business logic via goja (a Go JavaScript runtime).
The bundled JS is embedded at compile time:

```go
//go:embed decider.js
var deciderScript string
```

The framework is created with the generated `NewDeciderFramework`:

```go
fw, err := model.NewDeciderFramework(
    deciderScript,
    model.NewInMemStorage(),
    "deciderMigrate",
    "deciderReducer",
)
```

## Event Processing Loop

The decider reads from KurrentDB's `$all` stream and processes events in batches:

```go
for batch, err := range recvBatches(vm, sub, dbCheckpoint) {
    if err != nil { return err }

    // push events into the framework
    err = fw.RecvEvents(batch.Events)
    if err != nil { return err }

    // the reducer populates deciderEvents via rx.set.decider_events()
    // retrieve them after processing
    decisions := getDeciderEvents()

    // publish decisions to the vstatus stream
    _, err = publishDecisions(ctx, client, decisions, batch.Checkpoint, revision)
    if err != nil { return err }
}
```

## Event Wrapping

Events fed to the framework must be wrapped in metadata matching the `RealEvent` shape:

```go
for i, r := range recordedEvents {
    ev, err := model.JSONToGoja(vm, r.Data)
    if err != nil { return err }

    obj := vm.NewObject()
    obj.Set("position", r.Position.Commit)
    obj.Set("id", r.EventID.String())
    obj.Set("data", ev)
    batch[i] = obj
}
```

## Decision Events

The decider's reducer processes commands and emits decision events. These are stored in a special
`decider_events` key in the store:

```typescript
// In deciderReducer:
case "try-hold": {
    const rejected = yield* reduceTryHold(rx, e);
    if (rejected) {
        deciderEvents.push({
            type: "vhold-rejected", id: e.id, reason: rejected, patron: e.patron,
        });
    } else {
        deciderEvents.push({ ...e, type: "new-vhold" });
    }
} break;
```

After processing a batch, the Go code reads `decider_events` and publishes them to the `vstatus`
stream in KurrentDB.

## Decision Event Types

| Event | Meaning |
|-------|---------|
| `new-vhold` | Hold was accepted. Contains target, expiration, patron. |
| `vhold-rejected` | Hold was rejected. Contains reason and patron (for notification). |
| `end-vhold` | Hold was forcibly removed (e.g. patron demoted from researcher). |
| `new-vcheckout` | Checkout was accepted. Contains book, expiration, patron. |

These flow from `vstatus` through the relay to patron clients (sanitized) and from `status` to
admin clients (unsanitized).

The `end-vhold` event is emitted when `assign-patron` revokes researcher status and the patron held
restricted books. The hold cleanup (book status, edition holds, patron holds) happens inside
`reduceAssignPatron`, and the decider emits `end-vhold` so other clients learn about the removal.

## Publishing Decisions

Decisions are published to the `vstatus` stream. The decider also maintains its own checkpoint in a
`decider-state` stream, so it can resume from where it left off after a restart:

```go
func publishDecisions(
    ctx context.Context,
    client *kurrentdb.Client,
    deciderEvents []model.DeciderEvents,
    checkpoint uint64,
    revision *kurrentdb.StreamRevision,
) (*kurrentdb.StreamRevision, error) {
    // write decision events to vstatus
    // write checkpoint to decider-state (with optimistic concurrency)
}
```

## CaughtUp / FellBehind

The decider framework supports `caughtUp()` and `fellBehind()` to control when the query graph
runs. During initial catchup from KurrentDB, the decider processes events without running queries.
After catching up, `caughtUp()` is called to enable the full query pipeline.

## At-Most-One Semantics

The decider must have at-most-one runner at a time to ensure deterministic ordering of decisions.
To scale, shard the decider's responsibility (e.g. by domain area) with at-most-one runner per
shard.

## Batching

Events are received in batches from the KurrentDB subscription. The batch boundary is determined by
what's available in the subscription at the time of reading. The framework processes the entire
batch atomically (one reducer call with all events).
