# Writing Reducers

Reducers are generator functions that process events and update the materialized view (store). They
use `yield*` instead of `await` to interact with storage, because the generator-based approach works
with synchronous storage backends like IndexedDB (which requires same-stackframe execution).

Think of `yield*` as `await`. The framework intercepts each yield to perform the actual storage
operation.

## Basic Reducer

```typescript
import { Reducer } from './model.gen';

function *reduceNewList(rx: TodoRX, e: NewList): Reducer<void> {
  yield* rx.update.all_lists((all_lists) => all_lists.push(e.id));
  yield* rx.set.list(e.id, { id: e.id, name: e.name, items: [], archived: false });
}
```

## The RX Parameter

The `rx` parameter provides typed storage access.  It is generated from the `Store` definition in
the demo's `.py`.  Available operations:

- `rx.get.key(params...)` - Read a value (returns the value or undefined)
- `rx.set.key(params..., value)` - Write a value
- `rx.update.key(params..., fn)` - Read, apply a mutation function, write back
- `rx.del.key(params...)` - Delete a value
- `rx.old.key(params...)` - Read the value from before this transaction started

The `update` helper is a convenience for read-modify-write:

```typescript
// These are equivalent:
yield* rx.update.list(id, (list) => list.name = newName);

// vs:
const list = yield* rx.get.list(id);
list.name = newName;
yield* rx.set.list(id, list);
```

Values returned by `rx.get` are wrapped in copy-on-write proxies. You can mutate them freely and
call `rx.set` to persist the changes. The framework tracks which keys were modified.

## Return Values

Individual reducers can return values.  This is useful for reducers that make decisions — e.g.
returning a rejection reason (empty string for success, non-empty for the reason):

```typescript
function *reduceTryThing(rx: SomeRX, e: TryThing): Reducer<string> {
  if (/* some constraint fails */) return "constraint violated";
  // ... apply the change ...
  return "";
}
```

Top-level reducers can return `void` or `any[]`.  When a top-level reducer returns an array, it
is treated as a `markedSent` list — partial command shapes that the framework uses to match and
discard unsent commands (for forecasting).  This is how a client learns that a `try-X` command has
round-tripped when the published event has a different ID (`new-vX`):

```typescript
export function *userReducer(rx: UserRX, events: AppEvents[]): Reducer<any[]> {
  const sent: any[] = [];
  for (const e of events) {
    switch(e.type){
      case "new-vhold":      yield* reduceNewVHold(rx, e, sent);      break;
      case "vhold-rejected": yield* reduceVHoldRejected(rx, e, sent); break;
      // ...
    }
  }
  return sent;
}
```

Inside those reducers, push partial shapes like `{ type: "try-hold", id: e.id }` onto `sent`.
The framework's `matchSent()` does a structural subset match against each unsent command.

## Composing Reducers

Each system component has its own top-level reducer that dispatches to individual reducers by event
type.  Use an exhaustive `switch` on the event `type` discriminator:

```typescript
export function *reduceTodos(rx: TodoRX, events: TodoEvents[]): Reducer<void> {
  for (const e of events) {
    switch(e.type) {
      case "new-list":     yield* reduceNewList(rx, e);     break;
      case "rename-list":  yield* reduceRenameList(rx, e);  break;
      case "new-item":     yield* reduceNewItem(rx, e);     break;
      // ... handle all event types ...

      // events this component doesn't process (if any) — fall through to `break`

      // TypeScript exhaustiveness check
      default:
        const _typecheck: never = e;
        return _typecheck;
    }
  }
}
```

The `never` typecheck at the end ensures you handle every event variant.  If you add a new event
type and forget to handle it, TypeScript will report an error.

A demo with multiple components (e.g. user-facing vs. admin-facing clients) may have multiple
top-level reducers in the same file (one per component), often sharing helpers.

## Cross-Store Access with NoSet

When a reducer needs access to a store it doesn't own (e.g. shared logic that runs in multiple
components, each with a slightly different RX), use `NoSet<T>` to strip the `set` operation (only
`set` — `get`, `del`, `update`, and `old` all remain).  `set` is stripped because it has
type-safety issues with union types.

For example, the library demo runs the same `reduceUpdateBookRestricted` against either the
decider's full status store or a per-user virtualized status store; the type is
`BookRX & NoSet<StatusRX|VStatusRX> & PatronRX`.

When a reducer invalidates entities from another store, return the IDs rather than emitting events
directly.  Its caller is responsible for emitting the corresponding decision events.

## Safety Patterns

**Idempotency guards:** Check if an update is actually changing anything before doing work.  This
prevents unnecessary side effects and makes correctness obvious:

```typescript
const item = yield* rx.get.item(e.id);
if (item.done === e.done) return [];  // no-op
```

**Relevance guards:** When an event might trigger cascading effects, check preconditions
explicitly — bail out early when the event isn't actually relevant to the cascade.

**Optional fields under `NoSet<A|B>`:** types become the union of both stores.  Some fields may be
required in one store and optional in the other (e.g. a `patron` field that's always present in
admin state but masked in per-user state).  Guard with `if`, never `!`:

```typescript
if (hold.patron) {
  yield* rx.update.patron(hold.patron, (p) => delete p.holds[holdId]);
}
```

**Don't rely on object key order.**  Copy-on-write proxies and serialization layers may not
preserve JS insertion order.  When ordering matters (e.g. "end the most recently added entry"),
use explicit data like timestamps.

## Shared Helpers

When multiple reducers need the same cascading logic, extract a helper.  Pass it the relevant
`rx` slice (using intersection types and `NoSet<>` as needed) and have it return the IDs of any
entities the caller needs to clean up or emit events about.

## Migrations

Migration functions initialize storage with default values.  They run once when the framework
starts with empty storage:

```typescript
export function *migrateTodos(rx: TodoRX): Reducer<void> {
  yield* rx.set.all_lists((yield* rx.get.all_lists()) ?? []);
}
```

The pattern `(yield* rx.get.key()) ?? defaultValue` ensures idempotency — if the key already
exists (e.g. after a reconnect), the existing value is preserved.

## Different Reducers for Different Components

When a demo has multiple components consuming the same events differently, each gets its own
top-level reducer.  Common patterns:

- **Privileged vs. user-facing**: a privileged component (decider, admin client) sees real
  events; user-facing clients see only virtualized versions.  The privileged reducer often
  produces decision events that the decider publishes back to KurrentDB; the user reducer applies
  the resulting virtualized events.
- **Shared logic via a helper reducer**: when two components need overlapping business logic
  (e.g. decider + admin client both validate the same way), factor it into a helper that both
  top-level reducers call.  The helper returns whatever data the callers need to do their
  component-specific work.
- **Minimal relay reducer**: a relay's read model may only track existence of objects for
  reference validation and authorization, not full state.

The library demo uses all three of these (see its `userReducer`, `adminReducer`, `deciderReducer`,
`relayReducer`, and the shared `privilegedReducer` helper).  A simple demo (like the todo demo)
has a single `reduceTodos` used everywhere.

## Forecasting and `markedSent`

When a client sends a command that the server transforms before publishing (e.g. `try-hold` →
`new-vhold` with a different event ID), the forecaster predicts the post-transform event with
`forecasted: true`.  When the real event later arrives, the framework needs to discard the
forecast.

Matching by event ID isn't enough here because the IDs differ.  Top-level reducers can return a
`markedSent` array of partial command shapes that the framework matches structurally against
unsent commands.  See `frontend.md` for the forecaster side.

## Unit Testing with ReducerTester

The code generators produce a `ReducerTester` subclass for each framework.  It runs reducers
synchronously against `InMemStorage`, returning updated keys and `markedSent`:

```typescript
import { TodoReducerTester } from './model.gen';
import { migrateTodos, reduceTodos } from './reducers';

test("new-list adds to all_lists and creates the list", () => {
  const t = new TodoReducerTester(migrateTodos, reduceTodos);
  const result = t.run([
    { type: "new-list", id: "list-1", name: "Groceries" },
  ]);
  expect(t.data.all_lists()).toStrictEqual(["list-1"]);
  expect(t.data.list("list-1")).toMatchObject({ name: "Groceries", items: [] });
  expect(result.updates).toStrictEqual(["all_lists", "list.list-1"]);
});
```

The constructor accepts either a migrate function or an initial-data object (a plain
`Record<string, any>`).  The `t.data` accessor provides typed read access to the store via a
generated `TestData` class.
