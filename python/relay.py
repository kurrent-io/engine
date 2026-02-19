"""
What if:
- storage was only accessible to javascript
- quickjs was used to serialize and deserialize js objects to storage
- quickjs could also be used to serialize and deserialize json off the wire
- python only needs to be able to create read-only objects that come out of queries
- we need a wrapper so we can embed python functions into the query graph.
    - they interact through getters with proto-defined types
    - they need to somehow pass opaque objects through
"""

#############################################################

# query to track all patrons
"""
function*(qx) {
    const patron_uuids = yield* qx.get.patrons();
    const patrons = {};
    for (const patron_uuid of Object.keys(patron_uuids)) {
        patrons[patron_uuid] = yield* qx.get.patron(patron_uuid);
    }
    return patrons;
}
"""

# But I don't really want that in javascript, do I.  I really want that in python.

async def get_patrons(qx):
    patron_uuids = yield from qx.get.patrons()
    patrons: Dict[str, Patron] = {}
    return {patron_uuid: yield from qx.get.patron(patron_uuid) for patron_uuid in patron_uuids}

# challenges of this are:
# - query graph needs to be written in python too
# - if there was a javascript cache, it needs to be made available to python too
# - I suppose this doubles the cache size.   Before, you had a cache in typescript, but you can
#   reuse all those objects in typescript.  Now, all the objects in typescript need to be copied
#   over into python.
#
# - what if I ran actual python functions in the javascript query graph?


patrons = None

async def get_patrons(qx):
    patron_uuids = yield from qx.get.patrons()
    patrons: Dict[str, Patron] = {}
    return {patron_uuid: yield from qx.get.patron(patron_uuid) for patron_uuid in patron_uuids}

def hook(result):
    nonlocal patrons = result

framework.new_query(get_patrons, hook)

class Framwork:
    def __init__(self, _framework):
        self._framework = _framework

    def new_query(func):
        self._framework.add_query()

class GeneratorWrapper:
    def __init__(g):
        self.g = g
        self.first = True

    def next(val=None):
        if self.first:
            # first value to python generator must always be None
            self.first = False
            val = None
        try:
            return {"value": g.send(val), "done": False}
        except StopIteration as e:
            return {"value": e.value, "done": True}

@dataclasses.dataclass
class BookStatusCheckout:
    checkout: string

@dataclasses.dataclass
class BookStatusHold:
    hold: string

@dataclasses.dataclass
class Book:
    id: str
    isbn: str
    restricted: bool
    status: None | BookStatusCheckout | BookStatusHold;

class StorageValueErr(TypedDict):
    err: Any

class StorageValueValue(TypedDict):
    value: Any

StorageValue = StorageValueErr | StorageValueValue;

class QueryQuestion(TypedDict):
    store: Dict[str, True]
    query: Dict[str, True]

class QueryAnswer(TypedDict):
    store: Dict[str, StorageValue]
    query: Dict[str, Tuple[any, bool]]


T = TypeVar('T')
QueryGenerator = Generator[QueryQuestion, QueryAnswer, T]


def _queryGetter(key) -> QueryGenerator[Any]:
    ans = (yield {"store": {key: True}})["store"][key]
    if "err" in ans:
        raise ValueError(ans["err"])
    return ans["value"]


# Generator[yield_type, send_type, return_type]
class BookStoreQueryContext:
    @staticmethod
    def book(book_uuid: string) -> QueryGenerator[Book]:
        return decodeBook(yield from _queryGetter(f"book.{book_uuid}"))

    @staticmethod
    def edition(edition_isbn: string) -> QueryGenerator[Edition]:
        return decodeEdition(yield from _queryGetter(f"edition.{edition_isbn}"))

    @staticmethod
    def editions() -> QueryGenerator[Set[str]]:
        return decodeSet(yield from _queryGetter("editions"))


class RelayQueryContext(BookStoreQueryContext, PatronQueryContext):
    pass


class Framework:
    def __init__(qx):
        self._qx = qx
        self._framework = ...

    def new_query(generator) -> Query:
        return Query


    def __init__():
        sel

QX = TypeVar("QX")

QueryFunction = Callable[[QX], QueryGenerator[T]]

class Query(Generic[QX, T]):
    def __init__(self, qx: QX, generator: QueryFunction[QX, T]):
        self._generator = generator
        self._qx = qx
        self._result: T | None = None

        self._subs: List[Callable[[T], None]] = []

    def call():
        # return a next function
        g = self._generator(qx)
        first = True

        def next(val=None):
            if first:
                first = False
                val = None
            else:
                val = js2py(val)  # we would need some metadata here to know how to deserialize val
                                  # or we could watch what keys we asked for
                                  # or we could look at what keys were being returned
                                  # or I guess we need a python QX object that handles this.  Duh.
                                  # Well, but the python qx object is going to depend on
            try:
                return {"value": g.send(val), "done": False}
            except StopIteration as e:
                # capture the real return value in python; it's opaque to javascript anyway
                result = e.value
                try:
                    if e.value == self._result:
                        # preserve old value
                        result = self._result
                except Exception:
                    pass
                self._result = result
                # what we return will work with javascript's Query's dirty check
                return {"value": id(result), "done": True}

        return next

    def subscribe(cb: Callable[[T], None]):
        self._subs.append(cb)
        return lambda: self._subs = [s for s in self._subs if s != cb]


def wrap_generator(g):
    first = True

    def next(val=None):
        if first:
            first = False
            val = None
        else:
            val = js2py(val)
        try:
            return {"value": g.send(val), "done": False}
        except StopIteration as e:
            # TODO: return a js-safe reference to a pure python value
            return {"value": e.value, "done": True}

    return next

"""
  // subscribe to list of books from our store
  const booksLookup = useCallback(function*(qx: QX): QueryGenerator<Book[]> {
    // get the set of all editions
    const editions = (yield* qx.get.editions()) ?? {};
    // for each edition, get the title and number of copies
    const out: Book[] = [];
    for (const isbn of Object.keys(editions)) {
      const edition = yield* qx.get.edition(isbn);
      out.push({title: edition.title, copies: Object.keys(edition.books).length});
    }
    return out;
  }, []);
  const [, getBooks] = useQuery(fw, booksLookup);
"""

@framework.new_query
def book_list(qx: QX, _: Any, _: Any) -> List[Book]:
    editions = yield from qx.get.editions() or {}
    return [
        Book(title=edition.title, copies=len(edition.books))
        for edition in (yield from qx.get.edition(isbn) for isbn in editions)
    ]

class Framework[QX]:
    def __init__(qx):
        self._qx = qx
        self._framework = ...

    def new_query(generator: QueryFunction[QX, T]) -> Query[T]:
        # queryfunc() is a python function that returns a C-wrappable next() function
        def queryfunc(prev: T | None, isValid: bool) -> Callable[[Any], Tuple[bool, Any]]:
            g = generator(self._qx, prev, isValid)
            first = True

            def next(val=None):
                nonlocal first
                if first:
                    first = False
                    val = None
                try:
                    return g.send(val)
                except StopIteration as e:
                    return True, e.value

            return next

        # pass queryfunc() to C code to finish the wrapping, and recieve a javascript _Query object
        _query = _quickjs._new_query(self._framework, self._qx, queryfunc)

        # that gets wrapped with a suitable python interface
        return Query(_query)

class Query[T]:
    def __init__(self, _query):
        self._query = _query

    def awaitResult(self):
        # ask the graph for the result of this query when it's ready
        ans = yield {"query": {self._query.id: True}}
        result, dirty = ans["query"][self._query.id]
        return result

    def subscribe(self, cb):
        return self._query.subscribe(cb)

    def close(self):
        self._query.close()
