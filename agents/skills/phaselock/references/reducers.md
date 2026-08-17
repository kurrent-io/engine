# Writing reducers

Reducers are generator functions that consume events and update the store.
They use `yield*` where async code would use `await`: every store access
is a `yield*` so the engine can run the same reducer against any storage
backend — including IndexedDB, whose transactions demand same-stack
execution that promises cannot provide. Read `yield*` as `await` and the
code reads naturally.

Reducers must be pure and deterministic: their only inputs are the events
and the store, their only output is store writes (plus the return value
below). No IO, no `Date.now()`, no randomness — timestamps belong inside
events, ids arrive in events. The same events must produce the same state
in every runtime, forever, because history replays.

## The rx contexts

Each engine's reducer receives a typed context (`TodoRX`, `UserRX`, ...)
generated from its store declaration. One accessor per key template, with
template params as arguments:

- `yield* rx.get.list(id)` — read (undefined if missing)
- `yield* rx.set.list(id, value)` — write
- `yield* rx.update.list(id, fn)` — read, mutate via `fn`, write back
- `yield* rx.del.list(id)` — delete
- `yield* rx.old.list(id)` — the value from before this batch started

Values from `rx.get` are copy-on-write proxies: mutate them freely, then
`rx.set` persists. Writes that end up equal to the old value are detected
and skipped, so idempotent reducers are cheap. Do not rely on object key
insertion order surviving the proxy and serialization layers — when order
matters, use explicit data (timestamps, arrays).

A complete small reducer:

```typescript
import type { Reducer, TodoEvents, TodoRX } from './model.gen';

export function* reduceTodos(rx: TodoRX, events: TodoEvents[]): Reducer<void> {
  for (const e of events) {
    switch (e.type) {
      case 'new-list':
        yield* rx.update.all_lists((all) => all.push(e.id));
        yield* rx.set.list(e.id, { id: e.id, name: e.name, items: [], archived: false });
        break;

      case 'mark-item':
        yield* rx.update.item(e.id, (item) => (item.done = e.done));
        break;

      // ... every event type ...

      default: {
        const _typecheck: never = e;
        return _typecheck;
      }
    }
  }
}
```

The `never` default makes the switch exhaustive: adding an event type to
the union becomes a compile error until every reducer handles it. Event
types a component receives but ignores get explicit `case` labels falling
through to `break`.

## Batches and return values

The engine calls the top-level reducer with a batch of events and runs
it inside one store transaction. Helper functions are just functions —
they return whatever their caller needs.  For example, this helper
returns a rejection reason (or empty string) so multiple top-level reducers in
the system can reuse it, even though only the decider actually cares about the
rejection reason:

```typescript
function* reduceTryHold(rx: FullStatusRX, e: TryHold): Reducer<string> {
  const patron = yield* rx.get.patron(e.patron);
  if (!patron.researcher && e.open) return 'non-researcher cannot open-hold';
  // ... apply the hold ...
  return '';
}
```

The top-level reducer's return type is fixed by the engine: `void` or
`any[]`. The array is round-trip detection.

Background: a sent command stays in the outbox (and keeps its forecast
alive) until the client knows the server processed it — until it has
round-tripped. Normally this is automatic: the server stores the event
under the command's own id, the event comes back, ids match, done. But
some commands are not 1:1 with the events they produce — the server
answers a `try-hold` by publishing a `new-vhold` (or `vhold-rejected`)
with a different id — and then something has to recognize the response.

That recognition belongs in the reducer, which is the code that already
understands the response event. The top-level reducer returns an array of
partial command shapes; the engine matches each shape against the
commands in the outbox and marks the matches as round-tripped:

```typescript
export function* userReducer(rx: UserRX, events: LibraryEvents[]): Reducer<any[]> {
  const sent: any[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'new-vhold':
        yield* reduceNewVHold(rx, e, sent);   // pushes {type:'try-hold', id:e.id}
        break;
      // ...
    }
  }
  return sent;
}
```

Why shapes instead of ids: reducers see event data, never the id
wrapper around it, so they cannot name the outbox entry directly.
Matching is subset-structural instead — every field present in the shape
must equal the corresponding command field (a function in the shape acts
as a predicate on that field).

The engine also has `markSent(id)` for the app to do this from outside,
but prefer the in-reducer return: reducers run identically in every
environment the engine runs in, so the detection is written once, while
`markSent` calls live in per-application transport code and must be
rewritten for each host.

## Sharing logic across components

Reducers over public and sharded data domains (see `data-model.md`)
are shared verbatim — every component runs the same functions. The
interesting case is virtualized domains, where backend and frontend
stores hold different shapes (`Hold` vs `VHold`, from the library
example — `examples.md`). Virtualization costs
customized reducers; the goal is to keep that cost to the minimum, and
`NoSet` is the tool.

Split the reducers for a virtualized domain by what they do:

- **Creators** are per-store. Constructing an entry requires the full
  typed object for that store's shape, so each side has its own
  (`reduceTryHold` sets a `Hold`; `reduceNewVHold` sets a `VHold`).
- **Mutators** are shared. Because the store is denormalized, plenty of
  other events must read, tweak, or delete existing entries — a book
  turning restricted ends holds, a demoted patron loses privileges.
  Those touch only fields the two shapes have in common, so one helper
  serves both components, typed against the union with `set` stripped:

```typescript
type RebalanceRX = BookRX & NoSet<StatusRX | VStatusRX> & PatronRX;

function* rebalanceEditionHolds(rx: RebalanceRX, edition: Edition): Reducer<string[]> {
  // ... deletes/updates holds; returns ids of holds no longer valid
}
```

`NoSet<T>` strips only `set` — `get`/`old`/`del`/`update` remain. `set`
is the one operation a store-union cannot type soundly (a written value
would have to satisfy both shapes at once), and it is also the operation
the per-store creators exist for; the split falls out of the types.

This is also why the design rule in `data-model.md` matters here: the
closer a virtualized shape stays to the real shape, the more fields the
union has in common, the more reducers land on the shared-mutator side —
and the blast radius of virtualization stays confined to the creators.

Conventions that keep shared reducers sane:

- Idempotency guards: check whether the event changes anything before
  cascading (`if (book.restricted === e.restricted) return [];`).
- Under `NoSet<A | B>`, fields optional in either store are optional in
  the union. Guard with `if (x.field)`, never `!` (a field the backend
  always has may be sharded or stripped on the client).
- When a helper invalidates entities, return their ids and let each
  caller do its component-specific thing (a decider emits decision
  events; a client just cleans up).

## Migrations

The optional `migrate` callback runs at every engine startup, before any
events, inside a write transaction, with the full rx. It brings the store
schema up to date. The simplest migration seeds defaults idempotently:

```typescript
export function* migrateTodos(rx: TodoRX): Reducer<void> {
  yield* rx.set.all_lists((yield* rx.get.all_lists()) ?? []);
}
```

Because it runs on every startup, write migrations idempotently
(version-gate or `?? default`). Reshaping stored values when the model
changes is the same mechanism: read old shape, write new shape, guarded
so a second run is a no-op.

## Time-based triggers (known gap + workaround)

Reducers wake only for events; nothing fires on the passage of time (see
ROADMAP). The blessed workaround is the Tick pattern:

1. Reducers maintain a wakeups value in the store (e.g.
   `"wakeups": Record<utcDateTime | null>` keyed by task) — computing the
   next due time for each piece of scheduled work.
2. Define a `Tick` event carrying `time: utcDateTime`.
3. The app watches wakeups with an ordinary query; whenever it changes,
   `setTimeout` until the earliest one, then submit a Tick.
4. On Tick, the reducer runs everything whose wakeup has passed and
   computes the next wakeups.

The reducer stays deterministic — time enters the system only as event
data. Where the Tick comes from depends on raciness: a purely local,
per-client concern can tick from each client; anything that races with
other decisions (expirations, deadlines with consequences) should tick
from a single backend worker, which emits the resulting decision events
(e.g. `overdue-checkout`). Be deliberate about replay: Ticks are history,
and reducers must handle a Tick that arrives "late" relative to the
wakeups it satisfies.

## Testing reducers

Generation produces a `<Name>ReducerTester` per engine. It runs reducers
synchronously against an in-memory store:

```typescript
import { TodoReducerTester } from './model.gen';
import { migrateTodos, reduceTodos } from './reducers';

test('new-list creates the list', () => {
  const t = new TodoReducerTester(migrateTodos, reduceTodos);
  const result = t.run([{ type: 'new-list', id: 'l1', name: 'Groceries' }]);
  expect(t.data.all_lists()).toStrictEqual(['l1']);
  expect(t.data.list('l1')).toMatchObject({ name: 'Groceries', items: [] });
  expect(result.updates).toStrictEqual(['all_lists', 'list.l1']);
});
```

- The constructor takes a migrate function or an initial-data object
  (`Record<string, any>` keyed by storage key).
- `t.run(events)` returns `{ updates, markedSent }` — the sorted list of
  written keys and the markedSent array — so tests assert what changed
  and what round-tripped.
- `t.data` is a generated typed reader (`t.data.list('l1')`).

Test the interesting reducers the way the domain talks: seed with setup
events, apply the event under test, assert the store and the updates
list. Rejection-returning helpers get tested through the top-level
reducer's observable effects (e.g. a rejection decision event appears).
