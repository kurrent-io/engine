# Defining a Data Model

A demo's data model is defined in Python using the type DSL from `tools/protos.py`.  The model
file (e.g. `<demo>/model/<demo>.py`) describes the domain types, events, storage layout, and
framework compositions.  Code generators then produce typed code for TypeScript, Python, and Go.

## Type Primitives

```python
from protos import (
    String, Int, Bool, Null,  # scalar types
    Literal,                   # literal value, e.g. Literal("add-book")
    Maybe,                     # optional: Maybe(String) -> string | undefined
    Array,                     # Array(String) -> string[]
    Object,                    # Object(ValueType) -> Record<string, ValueType>
    Struct,                    # named product type with fields
    Union,                     # discriminated union
    Alias,                     # type alias (for readability)
    Store,                     # key-value storage layout
    Framework,                 # ties events, commands, and stores together
)
```

## Defining Structures

```python
# A struct is a product type with named fields
Book = Struct(
    id=String,
    isbn=String,
    restricted=Bool,
    status=Maybe(Struct(hold=String) | Struct(checkout=String)),
)
```

Use `Maybe(T)` for optional fields. Use `|` to create inline unions (e.g. a status that is either
a hold or a checkout).

## Built-in Date Type

`Date` is a built-in type that maps to `Date` in TypeScript, `datetime.datetime` in Python, and
`time.Time` in Go. It serializes as an ISO 8601 string on the wire. The QuickJS bindings
(`_quickjs.c`) handle JS `Date` ↔ Python `datetime.datetime` conversion natively (UTC only).

```python
expires = Maybe(Date),
timestamp = Date,
```

## Custom Concrete Types

For types that need custom encoding/decoding across languages, subclass `Concrete` and implement
static methods for each target language. (The built-in `Date` type used to be implemented this way
as `Timestamp` but was promoted to a first-class type.)

## Defining Events

Events use discriminated unions. Create a `Union()` and call `.add()` to register each variant.
The `type` field (a `Literal`) acts as the discriminator.

```python
BookEvents = Union()

AddEdition = BookEvents.add(Struct(
    type=Literal("add-edition"),
    isbn=String,
    title=String,
    timestamp=Timestamp,
))

RemoveBook = BookEvents.add(Struct(
    type=Literal("remove-book"),
    id=String,
    timestamp=Timestamp,
))
```

You can combine unions with `|`:

```python
LibraryEvents = BookEvents | PatronEvents | StatusEvents | DeciderEvents
```

## Enum Helper

For string enums, use a helper:

```python
def Enum(*strings):
    return Union(*(Literal(s) for s in strings))

Role = Enum("admin", "patron", "researcher")
```

## Defining Storage

`Store` defines the key-value layout for materialized views. Keys use `{param}` for parameterized
lookups.

```python
BookStore = Store({
    "edition.{edition_isbn}": Edition,
    "editions": Setx,          # Setx = Object(Literal(True)), i.e. Record<string, true>
    "book.{book_uuid}": Book,
})
```

Stores compose by passing multiple stores or dicts:

```python
DeciderStore = Store(
    BookStore,
    PatronStore,
    StatusStore,
    {"decider_events": Array(DeciderEvents)},
)
```

The generated code produces typed `get`/`set`/`update`/`del` accessors for each key pattern. For
example, `BookStore` generates:
- `rx.get.edition(isbn)` / `rx.set.edition(isbn, value)`
- `rx.get.editions()` / `rx.set.editions(value)`
- `rx.get.book(uuid)` / `rx.set.book(uuid, value)`

## Defining Frameworks

`Framework` ties together the event type (what comes in), the command type (what goes out), and the
store (what state is maintained).  The three parameters are `(event_type, command_type, store)`.

A simple demo with no per-user variation needs only one framework:

```python
TodoFramework = Framework(TodoEvents, TodoEvents, TodoStore)
```

A richer demo may define multiple frameworks — one per system component, with different store
shapes per component:

```python
# library demo, illustrative
UserFramework    = Framework(LibraryEvents, UserCommands,    UserStore)
AdminFramework   = Framework(LibraryEvents, AdminCommands,   AdminStore)
DeciderFramework = Framework(LibraryEvents, LibraryEvents,   DeciderStore)
RelayFramework   = Framework(LibraryEvents, RelayCommands,   RelayStore)
```

Using a narrowed command type (e.g. `UserCommands` instead of all events) makes the `forecaster`
callback type-safe — it receives only the commands that component can actually send.

Different components may have different stores for the same domain.  E.g. a relay might track only
existence of objects (for validation), a decider tracks full state (for decisions), and per-user
clients see virtualized state.

Every `Store` and `Framework` must be assigned to a module-level variable (e.g.
`MyStore = Store(...)`) so the code generators can discover its name.  Unnamed stores or
frameworks raise an error at generation time.

## Code Generation

Generate typed outputs with:

```bash
# TypeScript
python tools/protos.py -i tools -i <demo>/model gen_ts <demo> > <demo>/model/<demo>.gen.ts

# Python (for a Python relay)
python tools/protos.py -i tools -i <demo>/model gen_py <demo> > <demo>/relay/model.py

# Go (for a Go relay or decider)
python tools/protos.py -i tools -i <demo>/model gen_go <demo> -- model > <demo>/relay/model/model.go
```

Or just run `make` in the demo directory to regenerate everything.

## Event Metadata

All events are wrapped in metadata at the framework level:

- `Event<T> = {id: string, data: T}` - base wrapper for commands and forecasts
- `RealEvent<T> = Event<T> & {position: number}` - adds KurrentDB commit position

The framework handles wrapping/unwrapping internally. When defining your data model, you only
define the inner `data` type. The `id` is a UUID assigned by the framework (for outgoing commands)
or by KurrentDB (for incoming events).
