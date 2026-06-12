# Building a Relay

The relay is the server-side gateway between clients and KurrentDB.  It accepts WebSocket
connections, validates incoming commands, writes them to the database, and streams events back to
clients.

The relay can be implemented in either Python (using QuickJS via `_quickjs.c`) or Go (using goja).
Both runtimes execute the same TypeScript business logic.  The library demo uses a Python relay;
the todo demo uses a Go relay.

## Responsibilities

A minimal relay does three things:

1. Accept a WebSocket connection and read a handshake message.
2. Subscribe to KurrentDB starting from the handshake's `since` checkpoint, stream events to the
   client (with a `"caughtup"` marker at the catchup→live boundary).
3. Read commands from the client, validate them, and append accepted ones to KurrentDB.  Drop the
   connection on invalid input.

A richer relay may also:

- **Run a local read model** via a `RelayFramework`, so it can validate semantically (reference
  checks, authorization) — not just structurally.  Use `fw.simulate()` to run validation logic
  against the read model without committing changes.
- **Partition events across streams** by type (e.g. domain-area streams), so subscriptions can be
  filtered server-side.
- **Virtualize / sanitize events per client** before forwarding.  E.g. strip fields that only the
  owning user should see, or split a `status` stream into a private `status` (admin) and public
  `vstatus` (sanitized) flow.

## WebSocket Protocol

Clients connect to `ws://<host>:<port>/ws`.

**Handshake (client → server):** First message is JSON.  Minimum shape:

```json
{"since": 12345}
```

`since` is the last commit position the client has seen, or `null` for a fresh connection.  Add
identity / auth fields as the demo requires.

**Server → client:** Wrapped event messages:

```json
{"position": 12345, "id": "event-uuid", "data": {...}}
```

Plus a bare string `"caughtup"` when the catchup phase completes.

**Client → server:** Command messages, after the handshake:

```json
{"id": "command-uuid", "data": {...}}
```

The `id` is a client-generated UUID; the relay uses it as the EventID when appending.

## Validation

Two levels, depending on how rich the relay's read model is:

**Structural validation** — Check that the JSON matches the expected schema.  The codegen produces
`Check*` functions (Python and Go) for each event/command union.  In a Go relay this looks like:

```go
value, err := model.JSONToGoja(vm, payload)
if err != nil { return err }
return model.CheckTodoEvents(value, "data")
```

**Semantic validation** — Run the validation reducer against the relay's read model via
`fw.simulate()`.  This catches things like broken references and authorization failures.

```python
new_uuids, errors = self.fw.simulate(self.validator, batch)
if errors:
    raise UserError(errors)
```

The relay deliberately does NOT validate things that could be caused by race conditions (e.g.
holding an already-held item).  Those belong to the decider, which operates after global ordering
is established.

## UUID Uniqueness (optional)

When new entities (e.g. holds) are created by clients with client-generated UUIDs, the relay can
guarantee uniqueness using KurrentDB's optimistic concurrency: write a tiny event to a `uuid.{id}`
stream with `current_version=NO_STREAM`, which fails if that UUID was already taken.  The library
demo does this; the todo demo skips it for simplicity.

## Catchup-to-Live Transition

When a relay maintains its own read model, the transition from historical events to live events
needs care so neither side misses or duplicates events.  Typical sequence:

1. **Cold catchup**: Read historical events, send to the client.
2. **Subscribe to live**: Start a live subscription that buffers in a queue.
3. **Hot catchup**: Read any events that arrived between the cold catchup endpoint and the
   subscription start.
4. **Go live**: Discard duplicates from the live queue (events already seen in hot catchup),
   then switch to streaming the live queue.

If the relay just forwards the KurrentDB subscription directly (no local read model), KurrentDB's
single `SubscribeToAll` call handles catchup + live in one stream; you just emit `"caughtup"` when
the subscription reports the catchup→live transition.

## Per-Client Event Distribution

If the demo virtualizes events per user, the subscriber dispatches each event to the right
subset of connected clients based on stream and event content.  Patterns:

- **Global**: All clients receive it.
- **Owner-only**: Only the user who owns the entity receives the event.
- **Sanitized fanout**: All clients receive it, but with sensitive fields stripped for non-owners.
- **Admin-only / privileged**: Only privileged connections see it.

The library demo's relay implements all four patterns over streams named `books`, `patron.*`,
`status`, and `vstatus`; see `relay/relay.py` for the full table.  Simpler demos (like todo) skip
this entirely and broadcast a single stream to all connected clients.

## Framework Setup

The relay creates a framework instance that runs the TypeScript relay logic inside QuickJS or
goja.  Python:

```python
fw = model.RelayFramework(
    "relay.js",      # path to the bundled JS
    None,            # storage: None means JS-side InMemStorage
    "relayMigrate",  # name of the migrate export in the bundle
    "relayReducer",
)
```

Go:

```go
fw, err := model.NewRelayFramework(
    relayScript,                // embedded JS string
    model.NewInMemStorage(),
    "relayMigrate",
    "relayReducer",
)
```

The relay's read model should be intentionally minimal — only track what's needed for validation
or per-client dispatching.

## Sync Utility (round-trip tracking)

When the relay validates against its own read model, it must wait for newly-appended events to
flow back through its `$all` subscription before validating the next batch.  The library demo's
`Sync` class (in `relay.py`) tracks the latest committed position and lets the appender wait for
the subscriber to catch up before unblocking.  Demos without a local read model don't need this.
