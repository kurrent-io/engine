# Defining a Data Model

A demo's data model is defined in [TypeSpec](https://typespec.io) using the vocabulary from
`@kurrent/typespec-engine` (`tools/engine`).  The model file lives in the demo's model directory
next to the reducers (e.g. `model/library.tsp`, `todo/model/model.tsp`) and describes the domain
types, events, storage layout, and framework compositions.  Emitters then produce typed code for
TypeScript, Python, and Go.

## Type Primitives

| concept        | TypeSpec                                             |
|----------------|------------------------------------------------------|
| scalars        | `string`, `int32`, `boolean`, `null`                 |
| literal        | `"add-book"`, `true` (literal types)                 |
| optional       | `expires?: utcDateTime` (optional field)             |
| array          | `string[]`                                           |
| record         | `Record<T>` (`model Setx is Record<true>;` to name one) |
| struct         | `model X { a: string; b?: int32; }`                  |
| union          | `union X { A, B }` or `A \| B` expressions           |
| alias          | `alias Uuid = string;` (erased)                      |
| date           | `utcDateTime`                                        |
| storage layout | `interface S extends Store<{...}> {}`                |
| framework      | `interface F extends Framework<E, C, S> {}`          |

## Defining Structures

```typespec
model Book {
  id: Uuid;
  isbn: Isbn;
  restricted: boolean;
  status?: { hold: Uuid } | { checkout: Uuid };
}
```

Use `?` for optional fields.  Use `|` for inline unions (e.g. a status that is either a hold or a
checkout).

## Dates

`utcDateTime` maps to `Date` in TypeScript, `datetime.datetime` in Python, and `time.Time` in Go.
It serializes as an ISO 8601 string on the wire.  The QuickJS bindings (`relay/_quickjs.c`) handle
JS `Date` ↔ Python `datetime.datetime` conversion natively (UTC only).

```typespec
timestamp: utcDateTime;
expires?: utcDateTime;
```

## Defining Events

Events are discriminated unions of models.  The `type` field (a string literal) acts as the
discriminator.

```typespec
model AddEdition {
  type: "add-edition";
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

model RemoveBook {
  type: "remove-book";
  id: Uuid;
  timestamp: utcDateTime;
}

union BookEvents {
  AddEdition,
  RemoveBook,
}
```

Unions compose by naming other unions as members (they flatten):

```typespec
union LibraryEvents {
  BookEvents,
  PatronEvents,
  StatusEvents,
  DeciderEvents,
}
```

For string enums, a union of string literals works directly:

```typespec
union Role { "admin", "patron", "researcher" }
```

## Defining Storage

`Store` defines the key-value layout for materialized views.  Keys use `{param}` for parameterized
lookups, carried by the spec model's quoted property names.

```typespec
interface BookStore extends Store<{
  "edition.{edition_isbn}": Edition;
  "editions": Setx;
  "book.{book_uuid}": Book;
}> {}
```

Stores compose through the second template parameter, a tuple of dependency stores:

```typespec
interface DeciderStore extends Store<{
  "decider_events": DeciderEvents[];
}, [BookStore, PatronStore, StatusStore]> {}
```

Stores and frameworks are declared as interfaces (not models) on purpose: interfaces are not data
types, so they cannot leak into the model space.

The generated code produces typed `get`/`set`/`update`/`del` accessors for each key pattern.  For
example, `BookStore` generates:
- `rx.get.edition(isbn)` / `rx.set.edition(isbn, value)`
- `rx.get.editions()` / `rx.set.editions(value)`
- `rx.get.book(uuid)` / `rx.set.book(uuid, value)`

## Defining Frameworks

`Framework` ties together the event type (what comes in), the command type (what goes out), and
the store (what state is maintained).  The three template parameters are
`Framework<Events, Commands, Store>`.

A simple demo with no per-user variation needs only one framework:

```typespec
interface TodoFramework extends Framework<TodoEvents, TodoEvents, TodoStore> {}
```

A richer demo may define multiple frameworks — one per system component, with different store
shapes per component:

```typespec
// library demo, illustrative
interface UserFramework extends Framework<LibraryEvents, UserCommands, UserStore> {}
interface AdminFramework extends Framework<LibraryEvents, AdminCommands, AdminStore> {}
interface DeciderFramework extends Framework<LibraryEvents, LibraryEvents, DeciderStore> {}
interface RelayFramework extends Framework<LibraryEvents, RelayCommands, RelayStore> {}
```

Using a narrowed command type (e.g. `UserCommands` instead of all events) makes the `forecaster`
callback type-safe — it receives only the commands that component can actually send.

Different components may have different stores for the same domain.  E.g. a relay might track only
existence of objects (for validation), a decider tracks full state (for decisions), and per-user
clients see virtualized state.

## Code Generation

Each demo's model directory declares its emitters and output files in `tspconfig.yaml` (and
depends on the engine and emitter packages via `link:` entries in its package.json):

```yaml
emit:
  - "@kurrent/typespec-engine-ts"
  - "@kurrent/typespec-engine-go"
options:
  "@kurrent/typespec-engine-ts":
    out-file: "model.gen.ts"
  "@kurrent/typespec-engine-go":
    package: "model"
    out-file: "model.go"
```

`tsp compile .` in that directory emits everything under `tsp-output/@kurrent/`.  Demo makefiles
build the tooling, compile, and copy outputs into place — just run `make` in the demo directory to
regenerate everything.

Constraint decorators (`@minLength`, `@pattern`, ...) from the TypeSpec standard library are
JS-only and enforced at relay command ingress — write-time policy, not read-time type invariants.

## Event Metadata

All events are wrapped in metadata at the framework level:

- `Event<T> = {id: string, data: T}` - base wrapper for commands and forecasts
- `RealEvent<T> = Event<T> & {position: number}` - adds KurrentDB commit position

The framework handles wrapping/unwrapping internally.  When defining your data model, you only
define the inner `data` type.  The `id` is a UUID assigned by the framework (for outgoing commands)
or by KurrentDB (for incoming events).
