# Frontend Integration

The frontend runs the framework natively in the browser. Each user gets their own framework
instance, websocket connection, and materialized view.

## Key Hooks

### useFramework

App-specific hook that creates a framework instance and manages the websocket connection. Overloaded
to return the right framework type:

```typescript
// admin: no patronId
function useFramework(relayUrl: string, enabled: boolean): [AdminFramework, ConnectionState];
// patron: with patronId
function useFramework(relayUrl: string, enabled: boolean, patronId: string): [UserFramework, ConnectionState];
```

The websocket lifecycle handles:
- **Connect**: call `fw.reconnect(cb)` to get the last checkpoint from storage
- **Handshake**: send `{patron_id, since}` as the first message
- **Receive**: parse messages, call `fw.recvEvents([event])` for data, `fw.caughtUp()` for the
  catchup-complete signal
- **Reconnect**: exponential backoff (1s to 60s), reset on successful connect
- **Resend**: on reconnect, resend unsent commands from `result.commands`
- **Toggle**: `enabled` prop controls connect/disconnect

### useQuery

Generic, library-quality hook for subscribing to framework queries. Works with any Framework
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

The structural type `{ newQuery<X>(...) }` with the generic `<X>` is critical - it lets TypeScript
infer the query context type `QX` from the framework instance.

Returns `T | undefined` - `undefined` means the query hasn't produced a value yet (show a loading
state).

## Writing Query Functions

Query functions are generators that access the store via a typed query context (`qx`):

```typescript
const booksLookup = useCallback(function*(qx: UserQX): QueryGenerator<BookInfo[]> {
    const editions = yield* qx.get.editions();
    const out: BookInfo[] = [];
    for (const isbn of Object.keys(editions)) {
        const edition = yield* qx.get.edition(isbn);
        out.push({ isbn, title: edition.title });
    }
    return out;
}, []);

const books = useQuery(fw, booksLookup);
```

The framework's query graph automatically tracks which storage keys each query accesses. When those
keys change (due to new events), the query reruns and the component re-renders.

Wrap query functions in `useCallback` to keep a stable identity. Include any closed-over values
(like `patronId`) in the dependency array.

## Sending Commands

Use `fw.sendCommands()` to send commands to the relay. The framework assigns UUIDs, persists
commands to storage (for replay on reconnect), and calls the `onCommands` callback to send them
over the websocket.

```typescript
fw.sendCommands([{
    type: "try-hold",
    id: generateUuid(),     // domain-level UUID for the hold
    patron: patronId,
    target: { edition: isbn },
    open: false,
    timestamp: new Date(),
}]);
```

Note: the `id` field in the command is the domain-level identifier (e.g. hold UUID), not the
event wrapper UUID. The framework wraps the command in an `Event<T>` with its own UUID for
transport.

## Framework Lifecycle

- `fw.caughtUp()` - Call after the catchup phase completes (when the server sends `"caughtup"`).
  This unfreezes the query graph and runs all pending queries at once.
- `fw.fellBehind()` - Call when the connection is lost. Freezes the query graph so events can
  buffer without triggering expensive query reruns.
- `fw.reconnect(cb)` - Get the last committed checkpoint and any unsent commands from storage.
  Use the checkpoint as `since` in the handshake, and resend the commands.
- `fw.markSent(...ids)` - Explicitly discard forecasted events for commands that have round-tripped
  (when you won't see a matching event ID in the stream). Reducers can also return a `markedSent`
  array to match unsent commands by content shape (see reducers.md).

## Forecasting (Optimistic Updates)

The framework supports forecasting to provide optimistic UI updates. When `sendCommands` is called
with a `forecaster` callback configured, the framework:

1. Runs the forecaster to predict what events the server will produce
2. Applies those forecasted events to an overlay on top of real storage
3. Queries run against the overlay, showing the optimistic state immediately
4. When the real events arrive (matching by event ID), the forecasts are discarded and replaced
   with reality

The `userForecaster` is a plain function (not a generator) that maps commands to predicted events:

```typescript
export function userForecaster(cmd: UserCommands): LibraryEvents[] {
  switch(cmd.type){
    case "rename-patron":
    case "cancel-hold":
      return [cmd];  // pass through directly, virtually guaranteed to land
    case "try-hold":
      return [{
        type: "new-vhold",
        id: cmd.id,
        target: cmd.target,
        open: cmd.open,
        timestamp: cmd.timestamp,
        patron: cmd.patron,
        forecasted: true,  // indicates unresolved optimistic state
      }];
  }
}
```

The `forecasted` flag on `VHold` and `NewVHold` lets the UI distinguish unresolved optimistic holds
from confirmed ones (e.g. show a spinner on the cancel button while the hold is pending).

Configure forecasting in the framework constructor:

```typescript
new UserFramework(storage, {
    migrate: userMigrate,
    reducer: userReducer,
    forecaster: userForecaster,
    onCommands,
});
```

## Component Structure

For a multi-window demo, each window is a self-contained component:

```tsx
function PatronWindow({ patronId, relayUrl }) {
    const [enabled, setEnabled] = useState(true);
    const [fw, connState] = useFramework(relayUrl, enabled, patronId);

    // queries
    const patron = useQuery(fw, patronLookup);
    const books = useQuery(fw, booksLookup);

    // render UI with query results and sendCommands callbacks
}
```

Each `PatronWindow` has its own framework instance, websocket connection, and storage. The
framework's virtualization layer ensures each patron only sees their own data.

The `AdminWindow` works similarly but uses `useFramework(relayUrl, enabled)` (no patronId) to get
an `AdminFramework`. It sees real status (holds/checkouts with patron IDs) and can send admin
commands (edit patrons, editions, books, manage holds/checkouts).

Patron colors are derived from patron IDs via `colorHash()` (deterministic HSL), used as background
on patron names and as borders on held/checked-out book buttons for visual correlation across panels.
