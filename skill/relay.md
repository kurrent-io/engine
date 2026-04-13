# Building a Relay

The relay is the server-side gateway between clients and KurrentDB. It validates incoming commands,
writes them to the database, and streams events back to clients. It runs Python with QuickJS
embedded for executing the TypeScript business logic.

## Architecture

The relay has four main components:

- **Subscriber** - Reads from KurrentDB's `$all` stream, updates the relay's read model, and
  dispatches events to connected clients.
- **Writer** - Manages the outgoing event stream to a single WebSocket client, handling the
  transition from catchup (historical events) to live (real-time events).
- **Reader** - Reads incoming commands from a WebSocket client, validates them, and batches them
  for appending.
- **Appender** - Writes validated commands to KurrentDB, using optimistic concurrency on UUID
  streams to guarantee uniqueness.

## WebSocket Protocol

Clients connect to `ws://<host>:<port>/ws`.

**Handshake (client -> server):** The first message is JSON:
```json
{"patron_id": "some-uuid", "since": 12345}
```
- `patron_id`: identifies the user; empty or missing for admin connections
- `since`: last known commit position, or `null` for a fresh connection

Admin clients subscribe to the `status` stream directly and see all events. Patron clients subscribe
to `vstatus` and receive sanitized events.

**Server -> client:** Wrapped event messages:
```json
{"position": 12345, "id": "event-uuid", "data": {"type": "add-edition", ...}}
```
Plus a bare string `"caughtup"` when the catchup phase completes.

**Client -> server:** Command messages:
```json
{"id": "command-uuid", "data": {"type": "try-hold", ...}}
```

## Event Routing

Events are written to different KurrentDB streams based on type:

```python
def stream_for(event):
    match event.type:
        case "add-edition" | "update-edition-title" | "add-book" | ...:
            return "books"
        case "add-patron" | "rename-patron" | "assign-patron":
            return f"patron.{event.id}"
        case "try-hold" | "cancel-hold" | "try-checkout" | "end-checkout":
            return "status"
```

## Event Distribution

The subscriber dispatches events to clients based on stream name:

| Stream | Distribution |
|--------|-------------|
| `books` | All connected clients |
| `patron.{id}` | That patron + all admins |
| `status` | Subset broadcast globally (`cancel-hold`, `expire-hold`, `end-checkout`); rest admin-only |
| `vstatus` | Sanitized per-patron (see below); admins do not receive vstatus |

**VStatus sanitization:** Events on the `vstatus` stream contain sensitive patron IDs. Before
forwarding to patron clients:
- `new-vhold` and `new-vcheckout`: strip the `patron` field (unless the recipient is the owner)
- `vhold-rejected`: only forward to the patron whose hold was rejected
- Admins are excluded from vstatus distribution entirely (they see real status instead)

## Validation

The relay validates incoming commands at two levels:

**Structural validation** (before queuing): Checks that the JSON matches the expected schema using
generated `check*` functions from `model.py`.

**Semantic validation** (before appending): Uses `fw.simulate()` to run the validation logic
against the current read model without modifying it. This catches:
- Broken references (e.g. holding a book that doesn't exist)
- Authorization failures (e.g. one patron canceling another's hold)

The relay deliberately does NOT validate things that could be caused by race conditions (e.g.
holding an already-held book). Those are handled by the decider, which operates after global
ordering is established.

```python
# validation functions run inside fw.simulate()
new_uuids, errors = self.fw.simulate(self.validator, batch)
if errors:
    raise UserError(errors)
```

## UUID Uniqueness

Each new entity (hold, checkout, etc.) gets a client-generated UUID. The relay uses KurrentDB's
optimistic concurrency to guarantee uniqueness: it writes a small event to a `uuid.{id}` stream
with `current_version=NO_STREAM`, which fails if that UUID was already used.

## Catchup-to-Live Transition

The `Subscriber.stream()` method handles the tricky transition from reading historical events to
receiving live events without gaps or duplicates:

1. **Cold catchup**: Read historical events from KurrentDB, send to client
2. **Subscribe to live events**: Start collecting live events in a queue
3. **Hot catchup**: Read any events that arrived during step 2
4. **Go live**: Discard duplicate events from the live queue, then switch to the live stream

## Setting Up the Framework

The relay creates a `RelayFramework` instance that runs the TypeScript relay logic inside QuickJS:

```python
fw = model.RelayFramework(
    os.path.join(os.path.dirname(__file__), "relay.js"),
    None,           # storage: None means use InMemStorage from TypeScript
    "relayMigrate",
    "relayReducer",
)
```

The relay's read model is intentionally minimal - it only tracks what's needed for validation.

## Sync Utility

The `Sync` class tracks round-trips through the database. After appending commands, the relay
waits for those events to appear in its own `$all` subscription before responding. This ensures
the read model is up-to-date before validating the next batch of commands.
