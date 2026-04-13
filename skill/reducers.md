# Writing Reducers

Reducers are generator functions that process events and update the materialized view (store). They
use `yield*` instead of `await` to interact with storage, because the generator-based approach works
with synchronous storage backends like IndexedDB (which requires same-stackframe execution).

Think of `yield*` as `await`. The framework intercepts each yield to perform the actual storage
operation.

## Basic Reducer

```typescript
import { Reducer } from './library.gen';

function *reduceAddEdition(rx: BookRX, e: AddEdition): Reducer<void> {
  yield* rx.set.edition(e.isbn, {
    isbn: e.isbn,
    title: e.title,
    books: {},
    holds: {},
  });
  const editions = yield* rx.get.editions();
  editions[e.isbn] = true;
  yield* rx.set.editions(editions);
}
```

## The RX Parameter

The `rx` parameter provides typed storage access. It is generated from the `Store` definition in
`library.py`. Available operations:

- `rx.get.key(params...)` - Read a value (returns the value or undefined)
- `rx.set.key(params..., value)` - Write a value
- `rx.update.key(params..., fn)` - Read, apply a mutation function, write back
- `rx.del.key(params...)` - Delete a value
- `rx.old.key(params...)` - Read the value from before this transaction started

The `update` helper is a convenience for read-modify-write:

```typescript
// These are equivalent:
yield* rx.update.edition(isbn, (edition) => edition.title = newTitle);

// vs:
const edition = yield* rx.get.edition(isbn);
edition.title = newTitle;
yield* rx.set.edition(isbn, edition);
```

Values returned by `rx.get` are wrapped in copy-on-write proxies. You can mutate them freely and
call `rx.set` to persist the changes. The framework tracks which keys were modified.

## Return Values

Individual reducers can return values. This is useful for reducers that make decisions:

```typescript
// Returns rejection reason, or empty string on success
function *reduceTryHold(rx: FullStatusRX, e: TryHold): Reducer<string> {
  const patron = yield* rx.get.patron(e.patron);
  if (!patron.researcher && e.open) {
    return "non-researcher not allowed to issue open hold";
  }
  // ... validation logic ...
  // success
  return "";
}
```

Top-level reducers can return `void` or `any[]`. When a top-level reducer returns an array, it is
treated as a `markedSent` list — partial command shapes that the framework uses to match and discard
unsent commands (for forecasting). This is how the client learns that a `try-hold` has round-tripped
when it sees a `new-vhold` with a different event ID:

```typescript
export function *userReducer(rx: UserRX, events: LibraryEvents[]): Reducer<any[]> {
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

Inside those reducers, push partial shapes like `{ type: "try-hold", id: e.id }` onto the `sent`
array. The framework's `matchSent()` does a structural subset match against each unsent command.

## Composing Reducers

Each system component has its own top-level reducer that dispatches to individual reducers by event
type. Use an exhaustive `switch` on the event `type` discriminator:

```typescript
export function *userReducer(rx: UserRX, events: LibraryEvents[]): Reducer<void> {
  for (const e of events) {
    switch(e.type) {
      case "add-edition":    yield* reduceAddEdition(rx, e);    break;
      case "add-book":       yield* reduceAddBook(rx, e);       break;
      case "rename-patron":  yield* reduceRenamePatron(rx, e);  break;
      // ... handle all event types ...

      // events this component doesn't process
      case "try-hold":
      case "try-checkout":
        break;

      // TypeScript exhaustiveness check
      default:
        const _typecheck: never = e;
        return _typecheck;
    }
  }
}
```

The `never` typecheck at the end ensures you handle every event variant. If you add a new event
type and forget to handle it, TypeScript will report an error.

## Cross-Store Access with NoSet

When a reducer needs access to a store it doesn't own, use `NoSet<T>` to strip the `set` operation
(only `set` — `get`, `del`, `update`, and `old` all remain). `set` is stripped because it has
type-safety issues with union types. Using `NoSet<StatusRX|VStatusRX>` lets the same reducer work
in both the decider (StatusRX) and user (VStatusRX) contexts:

```typescript
function *reduceUpdateBookRestricted(
  rx: BookRX & NoSet<StatusRX|VStatusRX> & PatronRX, e: UpdateBookRestricted,
): Reducer<string[]> {
  // can read holds from StatusRX or VStatusRX
  const hold = yield* rx.get.hold(holdId);
  // can delete holds
  yield* rx.del.hold(holdId);
  // can update patrons (PatronRX is not wrapped in NoSet)
  yield* rx.update.patron(hold.patron, (p) => delete p.holds[holdId]);
  // ...
}
```

When a reducer invalidates entities from another store, return the IDs rather than emitting events
directly. The caller (`privilegedReducer`) is responsible for emitting the corresponding decider
events:

```typescript
// in privilegedReducer:
case "update-book-restricted": {
  const invalidHolds = yield* reduceUpdateBookRestricted(rx, e);
  for (const hold_uuid of invalidHolds) {
    deciderEvents.push({ type: "end-vhold", id: hold_uuid, timestamp: new Date() })
  }
} break;
```

## Safety Patterns

**Idempotency guards:** Check if an update is actually changing anything before doing work. This
prevents unnecessary side effects and makes correctness obvious:

```typescript
const book = yield* rx.get.book(e.id);
if (book.restricted === e.restricted) return [];  // no-op
```

**Relevance guards:** When an event might trigger cascading effects, check preconditions explicitly.
For example, marking a book restricted only affects the unrestricted pool if the book was available:

```typescript
if (!e.restricted || book.status) return [];  // only available→restricted matters
```

**Optional fields:** When working with `NoSet<StatusRX|VStatusRX>`, types are the union of both
stores. For example, `Hold.patron` is always a string, but `VHold.patron` is optional (other
patrons' holds are anonymous). Guard with `if`, never use `!`:

```typescript
if (hold.patron) {
  yield* rx.update.patron(hold.patron, (p) => delete p.holds[holdId]);
}
```

**Don't rely on object key order.** Copy-on-write proxies and serialization layers may not preserve
JS insertion order. When ordering matters (e.g. "end the most recently added hold"), use explicit
data like timestamps.

## Shared Helpers

When multiple reducers need the same cascading logic, extract a helper. For example,
`rebalanceEditionHolds` is used by both `reduceUpdateBookRestricted` and `reduceRemoveBook` to end
excess edition-level holds when the unrestricted book pool shrinks:

```typescript
type RebalanceRX = BookRX & NoSet<StatusRX|VStatusRX> & PatronRX;

function *rebalanceEditionHolds(
  rx: RebalanceRX, edition: Edition,
): Reducer<string[]> {
  // count available unrestricted books, sort holds by timestamp descending,
  // end the most recent holds until holds <= available
}
```

The caller passes the edition (which it may have already modified, e.g. after deleting a book from
`edition.books`) and is responsible for calling `rx.set.edition()` afterward.

## Migrations

Migration functions initialize storage with default values. They run once when the framework starts
with empty storage:

```typescript
export function *userMigrate(rx: UserRX): Reducer<void> {
  yield* rx.set.editions((yield* rx.get.editions()) ?? {});
  yield* rx.set.patrons((yield* rx.get.patrons()) ?? {});
  yield* rx.set.messages([]);
}
```

The pattern `(yield* rx.get.key()) ?? defaultValue` ensures idempotency - if the key already
exists (e.g. after a reconnect), the existing value is preserved.

## Shared Privileged Reducer

The decider and the admin UI both have access to all events and the same store shape (modulo the
decider's extra `decider_events` key). Their common logic is extracted into `privilegedReducer`,
which returns `DeciderEvents[]`:

```typescript
function *privilegedReducer(rx: AdminRX, events: LibraryEvents[]): Reducer<DeciderEvents[]> {
  const deciderEvents: DeciderEvents[] = [];
  // ... full business logic, pushes to deciderEvents ...
  return deciderEvents;
}

export function *deciderReducer(rx: DeciderRX, events: LibraryEvents[]): Reducer<void> {
  const deciderEvents = yield* privilegedReducer(rx, events);
  yield* rx.set.decider_events(deciderEvents);
}

export function *adminReducer(rx: AdminRX, events: LibraryEvents[]): Reducer<void> {
  yield* privilegedReducer(rx, events);  // discard decider events
}
```

## Different Reducers for Different Components

The same event types are handled differently by each component:

- **Decider / Admin**: Full business logic via `privilegedReducer`. Validates holds/checkouts
  against all constraints, emits decision events (`new-vhold`, `vhold-rejected`, `end-vhold`,
  `new-vcheckout`).
- **User (patron client)**: Applies virtualized decisions. Doesn't see `try-hold` or `try-checkout`
  directly - instead sees `new-vhold` and `new-vcheckout` after the decider processes them. Returns
  a `markedSent` array to help the framework discard forecasts.
- **Relay**: Minimal read model. Only tracks existence of objects for reference validation and
  hold ownership for authorization checks.

## Unit Testing with ReducerTester

The code generators produce a `ReducerTester` subclass for each framework. It runs reducers
synchronously against `InMemStorage`, returning updated keys and markedSent:

```typescript
import { UserReducerTester } from './library.gen';
import { userMigrate, userReducer } from './reducers';

test("user reducer", () => {
  const t = new UserReducerTester(userMigrate, userReducer);
  t.run([
    { type: "add-edition", isbn: "isbn-1", title: "Title", timestamp: new Date() },
    { type: "add-book", id: "book-1", isbn: "isbn-1", restricted: false, timestamp: new Date() },
  ]);
  expect(t.data.editions()).toStrictEqual({"isbn-1": true});

  const result = t.run([
    { type: "new-vhold", id: "hold-1", patron: "p1", target: { edition: "isbn-1" },
      open: false, timestamp: new Date() },
  ]);
  expect(result.updates).toStrictEqual(["edition.isbn-1", "hold.hold-1", "patron.p1"]);
  expect(result.markedSent).toStrictEqual([{ type: "try-hold", id: "hold-1" }]);
});
```

The constructor accepts either a migrate function or an initial data object (a plain
`Record<string, any>`). The `t.data` accessor provides typed read access to the store via a
generated `TestData` class.
