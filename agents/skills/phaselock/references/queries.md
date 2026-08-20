# Queries

A query is a plain function that reads the store and returns a result.
The engine tracks which keys each query reads and reruns it when any of
them change, pushing the new result to subscribers. Queries come in two
flavors: local (a function you hand to an engine at runtime) and
predefined (a typed contract declared in the data model, servable
either locally or over a transport).

Queries never write. They are also one-shot pure functions of current
state — write them as straight-line reads, no caching tricks.

## Local queries

A query function is a generator over a typed query context (`TodoQX`,
...), with read-only accessors mirroring the store:

```typescript
import type { QueryGenerator, TodoQX } from './model.gen';

function* allLists(qx: TodoQX): QueryGenerator<ListData[]> {
  const ids = (yield* qx.get.all_lists()) ?? [];
  const out: ListData[] = [];
  for (const id of ids) {
    const list = yield* qx.get.list(id);
    if (list.archived) continue;
    out.push({ id: list.id, name: list.name });
  }
  return out;
}

const q = engine.newQuery(allLists);
const unsubscribe = q.subscribe((lists) => render(lists));
// q.latest holds the most recent value; q.close() stops it.
```

Behavior to rely on:

- Dependency tracking is automatic and per-run: each rerun records the
  keys actually read, so conditional reads narrow the dependency set.
- Queries do not run while the engine is catching up on history; they all
  run once when the engine is told it has caught up. Until the first run,
  there is no value — surface a loading state.
- Values handed to queries are read-only views; attempting to mutate them
  throws.
- Local Queries compose: inside a query function, `yield*
  otherQuery.awaitResult()` makes this query depend on another's result.

### React

The examples ship a small generic hook that works with any engine via
structural typing (the generic method signature is what lets TypeScript
infer the query context):

```typescript
export function useLocalQuery<QX, T>(
  engine: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },
  fn: QueryFunction<QX, T>,
): T | undefined {
  const [state, setState] = useState<T | undefined>();
  const query = useMemo(() => {
    const q = engine.newQuery(fn);
    q.subscribe((val: T) => setState(val));
    return q;
  }, [engine, fn]);
  useEffect(() => () => query.close(), [query]);
  return state;
}
```

Wrap query functions in `useCallback` (closed-over values in the deps array) so
the query isn't recreated every render. `undefined` means "not yet run" —
render a spinner.  The reason that a manual `useCallback` step is required is
to make sure eslint can properly detect missing dependencies, which would not
work if `useLocalQuery()` took dependencies and called `useCallback` internally.

## Server-defined queries

Declaring a `Queries` interface in the model turns queries into a typed,
wire-crossing contract:

```typespec
interface TodoQueries extends Queries {
  allLists(): ListViewData[];
}
```

Generation produces, per interface:

- `TodoQuery` — the wire shape, a tagged tuple:
  `["TodoQueries.allLists", ...args]`.
- `checkTodoQuery(raw)` / `decodeTodoQuery(raw)` — validate and revive a
  tuple from the wire (dates decoded, etc.).
- `TodoQueryDefs<QX>` — the interface a server implements: one generator
  per query, given the query context plus the declared args.
- `new LocalTodoQueries(engine, defs)` — binds defs to an engine, yielding an
  object with one method per query returning live `Query<T>` handles.
- `RemoteTodoQueries(io)` — the client side: same shaped object, but each
  method encodes a tuple and subscribes via your transport.
- `dispatchTodoQuery(queries, decoded)` — routes a decoded tuple to the
  right method; use it server-side on incoming subscriptions.

Server wiring (from the todo-thin example):

```typescript
class ServerQueryDefs implements TodoQueryDefs<TodoQX> {
  *allLists(qx: TodoQX): QueryGenerator<ListViewData[]> {
    // same body a local query would have
  }
}

// per connection: identity-specific defs, live handles, dispatch
const queries = new LocalTodoQueries(engine, new ServerQueryDefs(/* identity */));
const errs = checkTodoQuery(raw);
if (errs.length) return closeConnection(errs);
const q = dispatchTodoQuery(queries, decodeTodoQuery(raw));
q.subscribe((result) => send({ queryResults: { [qid]: result } }));
// q.close() when the client unsubscribes or disconnects
```

Client wiring: implement the transport as a `QueriesIO` —
`createQuery(rawTuple, onResult)` returning a closer — and hand it to
`RemoteTodoQueries`. The transport can be anything: a websocket to a
server, or a `MessagePort` to a SharedWorker hosting the engine in
another thread of the same browser. The UI then calls typed methods
(`server.queries.allLists()`) and gets `Query<T>` handles identical in
shape to local ones, so the examples' generic `useQuery` hook works
(keyed by method name and args instead of a function). The naming marks
the guarantee: `useQuery` assumes only the baseline `Query<T>` contract,
so it serves any queries object, local or remote; `useLocalQuery` is the
marked special case, because local queries have a superset of powers
(arbitrary query functions, composition).

Results cross the wire as plain JSON (`encodeProto` on the way out, generated
decoders on the way in). Query arguments must therefore be JSON-representable
data — one reason why local queries can compose with other query objects
but server-defined ones take only data arguments.

Instantiate the server's `QueryDefs` with the connection's identity and
filter/shape results inside the query bodies — this is one of the places
authorization lives (see `server.md`).

## Design notes

- Query granularity: one query per screen-region works well; the engine
  dedupes work through key-level dependencies, so several medium queries
  beat one giant one.
- Large scans: a query that reads an unbounded number of keys reruns
  whenever any of them changes. There are no ordered indexes yet (see
  ROADMAP); design store keys so queries read what they need (id-set keys
  plus point reads).
- Server-defined query results are shared per (query, args) by the
  engine's graph; heavy fan-out to many subscribers is cheap on the
  compute side, and the transport layer decides how to fan results out.
