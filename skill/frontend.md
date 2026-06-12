# Frontend Integration

The frontend runs the framework natively in the browser.  Each window gets its own framework
instance, websocket connection, and materialized view.

## Key Hooks

### useFramework

App-specific hook that creates a framework instance and manages the websocket connection.  Its
signature depends on what the demo distinguishes — a demo with no user types might have:

```typescript
function useFramework(relayUrl: string): [TodoFramework, ConnectionState];
```

A demo with multiple user roles might overload:

```typescript
function useFramework(url: string, enabled: boolean): [AdminFramework, ConnectionState];
function useFramework(url: string, enabled: boolean, userId: string): [UserFramework, ConnectionState];
```

The websocket lifecycle handles:

- **Connect**: call `fw.reconnect(cb)` to get the last checkpoint and any persisted unsent
  commands from storage.
- **Handshake**: send `{since, ...}` as the first message — include whatever identity / auth
  fields the demo's relay protocol requires.
- **Receive**: parse messages; call `fw.recvEvents([event])` for data and `fw.caughtUp()` for the
  catchup-complete signal.
- **Reconnect**: exponential backoff (e.g. 1s → 60s), reset on successful connect.
- **Resend**: after reconnecting, resend the unsent commands from `result.commands` so they're
  not lost.
- **Toggle (optional)**: an `enabled` prop that controls connect/disconnect — useful for demoing
  reconnection behavior.

Keep `useFramework.ts` clear over generic; it's tightly coupled to the demo's protocol.

### useQuery

Generic, library-quality hook for subscribing to framework queries.  Works with any Framework
subclass via structural typing.

```typescript
import type { Query, QueryFunction } from './model';

export function useQuery<QX, T>(
    fw: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },
    fn: QueryFunction<QX, T>,
): T | undefined {
    const [state, setState] = useState<T | undefined>();
    const query = useMemo(() => {
        const q = fw.newQuery(fn);
        q.subscribe((val: T) => setState(val));
        return q;
    }, [fw, fn]);
    useEffect(() => () => { query.close() }, [query]);
    return state;
}
```

The structural type `{ newQuery<X>(...) }` with the generic `<X>` is critical — it lets TypeScript
infer the query context type `QX` from the framework instance.

Returns `T | undefined`.  `undefined` means the query hasn't produced a value yet (typically
because the framework is still in catchup); render a loading state.

## Writing Query Functions

Query functions are generators that read from a typed query context (`qx`):

```typescript
const listsLookup = useCallback(function*(qx: TodoQX): QueryGenerator<ListData[]> {
    const ids = (yield* qx.get.all_lists()) ?? [];
    const out: ListData[] = [];
    for (const id of ids) {
        const list = yield* qx.get.list(id);
        if (list.archived) continue;
        out.push({ id: list.id, name: list.name });
    }
    return out;
}, []);

const lists = useQuery(fw, listsLookup);
```

The framework's query graph automatically tracks which storage keys each query touches.  When
those keys change (due to new events), the query reruns and the component re-renders.

Wrap query functions in `useCallback` to keep a stable identity.  Include any closed-over values
in the dependency array.

## Sending Commands

Use `fw.sendCommands()` to send commands to the relay.  The framework assigns event UUIDs,
persists the commands to storage (so they survive a reconnect), and calls the `onCommands`
callback to send them over the wire.

```typescript
fw.sendCommands([{
    type: "new-list",
    id: generateUuid(),
    name: "Groceries",
}]);
```

The `id` field is the domain-level identifier for the entity the command creates (or refers to).
The framework wraps the command in an `Event<T>` envelope with its own UUID for transport.

## Framework Lifecycle

- `fw.caughtUp()` — Call after the catchup phase completes (server sent `"caughtup"`).
  Unfreezes the query graph and runs all pending queries at once.
- `fw.fellBehind()` — Call when the connection is lost (or when intentionally pausing).  Freezes
  the query graph so events can buffer without triggering expensive reruns.
- `fw.reconnect(cb)` — Get the last committed checkpoint and any unsent commands from storage.
  Use the checkpoint as `since` in the handshake; resend the commands.
- `fw.markSent(...ids)` — Explicitly discard forecasted events for commands that have
  round-tripped (when you won't see a matching event ID in the stream).  Reducers can also return
  a `markedSent` array to match unsent commands by content shape (see reducers.md).

## Forecasting (Optimistic Updates)

When the framework is configured with a `forecaster`, calls to `sendCommands` are run through the
forecaster first to predict what events the server will produce.  The framework applies those
forecasted events to an overlay on top of real storage, so queries immediately see the optimistic
state.  When the real events arrive (matched by event ID), the forecasts are discarded and
replaced with reality.

```typescript
new TodoFramework(new InMemStorage(), {
    migrate: migrateTodos,
    reducer: reduceTodos,
    forecaster: todoForecaster,  // optional
    onCommands,
});
```

The forecaster is a plain function (not a generator) mapping each command to the events it's
expected to produce.  For commands that round-trip directly (the server doesn't transform them),
return the command as-is.  For commands that the server transforms (e.g. `try-X` → `new-X`),
return the predicted post-transform shape — and consider adding a `forecasted: true` flag on it so
the UI can distinguish unresolved optimistic state from confirmed state (e.g. show a spinner on a
button until the forecast resolves).

A simple demo may skip forecasting entirely; the round-trip latency through a local relay is
usually low enough that the UI feels responsive without it.

## Component Structure

For a multi-window demo, each window is a self-contained component with its own framework:

```tsx
function Window({ name, relayUrl }) {
    const [fw, connState] = useFramework(relayUrl);
    const data = useQuery(fw, dataLookup);

    return /* render data + buttons that call fw.sendCommands(...) */;
}
```

Each window has its own framework instance, websocket, and storage.  Multiple windows can run
side by side to demonstrate sync across clients.  If the demo virtualizes per user, the window
takes a user identifier prop and passes it to `useFramework`.
