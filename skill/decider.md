# Building a Decider

A decider is an optional authoritative component that processes events after global ordering has
been established by KurrentDB.  It makes domain-level decisions (accept/reject) and emits decision
events that flow back to clients through the relay.

Not every demo needs a decider.  Use one when the demo has decisions that require global state
or that resolve races between concurrent commands.  The library demo uses a decider to arbitrate
holds and checkouts (where two clients might simultaneously try to claim the last copy of
something).  The todo demo has no decider — every command is trivially acceptable.

## Role in the Architecture

```
clients → relay (validates) → KurrentDB → decider (decides) → KurrentDB → relay → clients
```

The relay rejects obviously invalid commands (structurally or semantically against its read
model).  The decider resolves anything that requires the global, committed ordering of events: for
example, two patrons simultaneously trying to hold the last copy of a book — the relay lets both
through (each is individually valid), but the decider accepts only the first one it sees.

## Go + goja Setup

Deciders run in Go, executing the TypeScript business logic via goja.  The bundled JS is embedded
at compile time:

```go
//go:embed decider.js
var deciderScript string

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
    if err := fw.RecvEvents(batch.Events); err != nil { return err }

    // The reducer populates a "decider_events" key in the store via rx.set.
    // Retrieve the decisions emitted for this batch.
    decisions := getDeciderEvents()

    // Publish decisions back to KurrentDB; clients see them via the relay.
    if _, err := publishDecisions(ctx, client, decisions, batch.Checkpoint, revision); err != nil {
        return err
    }
}
```

## Event Wrapping

Events fed to the framework must be wrapped in `RealEvent` metadata:

```go
ev, err := model.JSONToGoja(vm, r.Data)
obj := vm.NewObject()
obj.Set("position", r.Position.Commit)
obj.Set("id", r.EventID.String())
obj.Set("data", ev)
```

## Decision Events

The decider's reducer emits decision events into a dedicated store key (typically
`decider_events`):

```typescript
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

After processing a batch, the Go code reads that key and publishes the events to the appropriate
KurrentDB stream(s).

Common decision-event shapes (from the library demo, illustrative):

| Event | Meaning |
|-------|---------|
| `new-vhold` | A hold was accepted; carries target / expiration / patron. |
| `vhold-rejected` | A hold was rejected; carries reason and the patron who tried it. |
| `end-vhold` | A previously-accepted hold was forcibly removed. |
| `new-vcheckout` | A checkout was accepted. |

## Publishing Decisions and Checkpoints

Decision events are written to a publication stream (e.g. `vstatus` in the library demo).  The
decider also persists its own checkpoint in a dedicated stream (`decider-state`) so it can resume
exactly where it left off after a restart:

```go
func publishDecisions(
    ctx context.Context,
    client *kurrentdb.Client,
    deciderEvents []model.DeciderEvents,
    checkpoint uint64,
    revision *kurrentdb.StreamRevision,
) (*kurrentdb.StreamRevision, error) {
    // append decisions to the publication stream
    // append a checkpoint to decider-state with optimistic concurrency on `revision`
}
```

## CaughtUp / FellBehind

During initial catchup from KurrentDB, the decider processes events without running queries.
After catching up, `fw.CaughtUp()` unfreezes the query graph.  This mirrors the framework lifecycle
on the client side.

## At-Most-One Semantics

A decider must have at-most-one runner at a time to ensure deterministic ordering of decisions.
To scale, shard the decider's responsibility (e.g. by domain area) with at-most-one runner per
shard.

## Batching

Events arrive in batches from the KurrentDB subscription.  The batch boundary is whatever's
available in the subscription at the moment of read.  The framework processes each batch
atomically — one reducer call with all events.
