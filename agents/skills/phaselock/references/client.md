# Building a client

A fat client runs the engine in the browser: events stream in over some
transport, reducers fold them into a local store, queries drive the UI,
and user actions become commands sent back out. The engine is IO-agnostic
— the app owns the transport and the protocol; the engine owns everything
else.

## Constructing an engine

Generation produces one class per engine declared in the model:

```typescript
import { InMemStore, TodoEngine } from './model';
import { migrateTodos, reduceTodos } from './model';

const engine = new TodoEngine(new InMemStore(), {
  migrate: migrateTodos,        // optional: runs at startup
  reducer: reduceTodos,         // required
  forecaster: todoForecaster,   // optional: enables forecasts
  onCommands,                   // required if sendCommands is used
});
```

Store choices:

- `InMemStore` — ephemeral; state rebuilds from the log each load.
- `IndexedDBStore` — persistent; the app resumes from its checkpoint and
  works offline. Constructed with an open `IDBDatabase` and an
  object-store name.
- `ExternalStore` — adapt any transactional key-value store by supplying
  a transaction factory (used server-side more than in browsers). The
  Store is responsible for accepting rich values for `set` and returning
  rich values for `get`.  `set` can use encodeProto to lower to plain JSON
  or protoStringify to lower to json-encoded string; `get` receives a
  decoder parameter to lift from plain JSON to rich object.  If the store
  natively handles rich types, the decoder can be ignored.

## The engine API

- `recvEvents(events)` — feed committed events from the wire, each shaped
  `{ position, id, data }` (a `Committed`). `events` should be in plain
  JSON format (no Date, Map, or Set); the engine applies the generated
  decoders internally so don't pre-decode events yourself.
- `caughtUp()` / `fellBehind()` — bracket live-ness. During catchup (and
  disconnection) events fold into the store but queries hold; on
  `caughtUp()` all queries run once against the settled state.  For most
  applications, calling `caughtUp()` once after waking up and finishing
  the initial sync is sufficient.
- `sendCommands(commands)` — hand over command values in rich form (a
  `Date` field is a real `Date`). The engine wraps each as `Identified`
  (assigns the wrapper id), persists it (the outbox — commands survive
  restarts until acknowledged), runs the forecaster, and then calls
  `onCommands(identified)` with the commands already encoded to plain
  JSON — transmit them as-is.
- `reconnect(cb)` — asks the store for `{ checkpoint, commands }`: the last
  applied log position and any outbox contents. Call it before (re)dialing
  so the server can resume you from `checkpoint`, then retransmit
  `commands`.
- `markSent(...ids)` — explicitly discard forecasts for commands known to
  have round-tripped when no event with a matching id will ever arrive
  (e.g. the command was rejected). Reducers can do this by content instead
  via reducer return value (see `reducers.md`).
- `newQuery(fn)` — see `queries.md`.
- `simulate(fn, cb, events?)` — run reducer-shaped logic against current
  state without writing; mostly a server-side validation tool.

## Connection lifecycle (the usePhaseLock pattern)

The examples wrap engine + websocket in one hook, `usePhaseLock`. The
protocol is app-defined; the lifecycle shape is what matters:

```typescript
export function usePhaseLock(serverUrl: string): [TodoEngine, ConnectionState] {
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);

  const engine = useMemo(() => {
    const onCommands = (commands: Identified<any>[]) => {
      const ws = wsRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;  // outbox will resend
      for (const cmd of commands) ws.send(JSON.stringify(cmd));
    };
    return new TodoEngine(new InMemStore(), {
      migrate: migrateTodos, reducer: reduceTodos, onCommands,
    });
  }, []);

  useEffect(() => {
    let backoff = 1000;
    function connect() {
      engine.reconnect(({ checkpoint, commands }) => {
        const ws = new WebSocket(serverUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          ws.send(JSON.stringify({ since: checkpoint ?? null }));  // app protocol
          for (const cmd of commands) ws.send(JSON.stringify(cmd)); // resend outbox
          backoff = 1000;
          setConnState('connected');
        };
        ws.onmessage = (msg) => {
          if (msg.data === 'caughtup') engine.caughtUp();          // app protocol
          else engine.recvEvents([JSON.parse(msg.data)]);
        };
        ws.onclose = () => {
          setConnState('disconnected');
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60000);
        };
      });
    }
    connect();
    // cleanup: cancel timers, close socket
  }, [engine, serverUrl]);

  return [engine, connState];
}
```

Load-bearing details:

- Always `reconnect()` first and hand the checkpoint to the server, or
  clients refetch all of history on every connect.
- Always resend `commands` from the reconnect result — that is the outbox
  doing its job after an offline stretch or a crash.
- Surface connection state in the UI; with forecasts enabled the app is
  fully usable while disconnected, and users should be able to tell.
- The engine dedupes nothing at the transport level; if the server may
  redeliver the event at `since`, drop it server-side or client-side by
  position.

## Sending commands from the UI

```typescript
engine.sendCommands([{ type: 'new-list', id: crypto.randomUUID(), name }]);
```

The `id` in that command is the new list's permanent identity, minted by
the client — see the next section, because that one line carries a lot of
the offline story. Note that rich data types are passed to sendCommands
(like Date), but what you later receive in your onCommands or reconnect
callback will be plain json (Dates encoded as strings).  The reason is that
sendCommands() is called from the UI with rich typing, but onCommands and
reconnect callbacks are meant to be passed directly over the wire, with
nothing but a type-agnostic JSON.stringify() or messagepack step.

## Client-minted ids

Entity ids are minted by the client that creates the entity, not
assigned by the server. The creating command carries the entity's final
id, so the client knows it before the command is submitted. This is
a load-bearing property for offline apps:

- **Creation needs no round trip.** There is no id-granting request to
  wait for, and no temporary id to fix up later — the id in the UI the
  moment the button is pressed is the id forever.
- **Queued commands can reference each other.** An offline session can
  create a list and then add items to it: the later commands cite the
  list's id because it existed at mint time. With server-assigned ids,
  that chain could not be expressed until reconnect.
- **Forecasts predict reality.** The forecasted event carries the
  same entity id the real event will carry, so nothing in the store needs
  rewriting when truth arrives.
- **Retries are detectable.** Resending the outbox after a reconnect
  cannot silently create duplicates when the server enforces per-id
  uniqueness (see `server.md`).

There are two id layers, and they have different jobs. The domain id
above lives inside the command data and is declared in your model. The
wrapper id the engine assigns (`Identified<T>`) is outbox bookkeeping;
servers commonly reuse it as the stored event's id so forecasts can be
automatically discarded when the real event arrives (below).

Client-minted ids are the supported scheme, and they are cheap: the only
cost is that the server enforces per-id uniqueness, likely via
KurrentDB's optimistic concurrency mechanism (see `server.md`).
Server-minted ids have some small UI-facing drawbacks (e.g. a "share"
button cannot produce a URL for an object created while still offline)
and are not yet supported (see ROADMAP.md).

## Forecasts (optimistic updates)

With a `forecaster` configured, `sendCommands` also predicts the events
the server will eventually publish for each command. Forecasted events
run through the ordinary reducers into a disposable overlay on top of the
store; queries read through the overlay, so the UI updates instantly —
offline included. Real events land in the real store, and the overlay is
rebuilt from whatever forecasts are still outstanding.

This forecaster is from the library example (`examples.md`):

```typescript
export function userForecaster(cmd: UserCommands): LibraryEvents[] {
  switch (cmd.type) {
    // sure things: the server stores the command as-is
    case 'rename-patron':
    case 'cancel-hold':
      return [cmd];

    // racy things: predict the decision, flagged as unresolved
    case 'try-hold':
      return [{ ...holdShapeFrom(cmd), type: 'new-vhold', forecasted: true }];
  }
}
```

A forecast is discarded when the real event from its command round-trips:

1. An event arrives whose wrapper id matches the command's wrapper id, or
2. the reducer returns a `markedSent` shape matching the command (for
   servers that publish a different id — `try-hold` → `new-vhold`), or
3. the app calls `markSent(wrapperId)` explicitly.

For racy commands, put a `forecasted?: true` field on the predicted event
(declare it in the model) and let reducers store it; the UI can render those
entities as pending (spinner on the button) until the real decision
arrives. A rejection surfaces as its own event (e.g. `vhold-rejected`)
that both discards the forecast and carries a reason to display.

Skipping forecasts entirely is legitimate: with high connectivity and low
latency, the round trip time is short.  In those conditions, `sendCommands` can
likely be omitted too, or kept to offer an outbox for handling brief
disconnects.

## Multiple windows

Each browser window may construct its own Engine, Store, and transport.  Or
multiple tabs may share a single Engine/Store/transport via a SharedWorker.

Sharing stops being optional when the Store is an IndexedDBStore.  An engine
assumes exclusive ownership of its store — its checkpoint and outbox live
there as ordinary keys — and an IndexedDB database is shared across the
whole origin.  Two tabs each running their own engine over the same database
would double-process events and race on each other's checkpoint and outbox,
corrupting resume state; single-tab testing never trips the bug.  Either
give each tab its own database, or host one engine in a SharedWorker and let
every tab subscribe to it.  See `queries.md` for techniques useful when
separating the UI in one tab from the Engine in the worker.
