# Defining a Data Model

The data model is defined in Python using the type DSL from `tools/protos.py`. This file describes
the domain types, events, storage layout, and framework compositions. Code generators then produce
typed code for TypeScript, Python, and Go.

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

## Custom Concrete Types

For types that need custom encoding/decoding across languages (like timestamps), subclass
`Concrete` and implement static methods for each target language:

```python
class Timestamp(Concrete):
    json_type = "string"

    @staticmethod
    def ts_generate_annotation(d, annos, visit):
        return "Date"

    @staticmethod
    def ts_generate_decoder(d, annos, decoders, visit):
        return lambda val: f"new Date({val} as string)"

    # similarly for py_generate_* and go_generate_*
```

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
store (what state is maintained):

```python
UserFramework = Framework(LibraryEvents, LibraryEvents, UserStore)
DeciderFramework = Framework(LibraryEvents, LibraryEvents, DeciderStore)
RelayFramework = Framework(LibraryEvents, RelayCommands, RelayStore)
```

The three parameters are: `(event_type, command_type, store)`.

Different components may have different stores for the same domain. For example, the relay only
tracks existence of objects (for validation), while the decider tracks full state (for decisions).

## Code Generation

Generate typed outputs with:

```bash
# TypeScript
python tools/protos.py -i tools -i model gen_ts library > model/library.gen.ts

# Python
python tools/protos.py -i tools -i model gen_py library > relay/model.py

# Go
python tools/protos.py -i tools -i model gen_go library -- model > decider/model/model.go
```

Or just run `make` to regenerate everything.

## Event Metadata

All events are wrapped in metadata at the framework level:

- `Event<T> = {id: string, data: T}` - base wrapper for commands and forecasts
- `RealEvent<T> = Event<T> & {position: number}` - adds KurrentDB commit position

The framework handles wrapping/unwrapping internally. When defining your data model, you only
define the inner `data` type. The `id` is a UUID assigned by the framework (for outgoing commands)
or by KurrentDB (for incoming events).
