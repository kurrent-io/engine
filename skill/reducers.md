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

Reducers can return values. This is useful for reducers that make decisions:

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

When a reducer needs read access to a store it doesn't own, use `NoSet<T>` to strip the `set` and
`del` operations:

```typescript
function *reduceAssignPatron(
  rx: PatronRX & BookRX & NoSet<StatusRX|VStatusRX>, e: AssignPatron,
): Reducer<string[]> {
  // can read from StatusRX (holds) but can't write to it
  const hold = yield* rx.get.hold(hold_uuid);
  // ...
}
```

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

## Different Reducers for Different Components

The same event types are handled differently by each component:

- **Decider**: Full business logic. Validates holds/checkouts against all constraints, emits
  decision events (`new-vhold`, `vhold-rejected`, `new-vcheckout`).
- **User (client)**: Applies virtualized decisions. Doesn't see `try-hold` or `try-checkout`
  directly - instead sees `new-vhold` and `new-vcheckout` after the decider processes them.
- **Relay**: Minimal read model. Only tracks existence of objects for reference validation and
  hold ownership for authorization checks.
