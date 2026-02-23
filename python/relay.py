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
    query: Dict[str, Tuple[Any, bool]]


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

QX = TypeVar("QX")

QueryFunction = Callable[[QX], QueryGenerator[T]]


@framework.new_query
def book_list(qx: QX, _: Any, _: Any) -> List[Book]:
    editions = yield from qx.get.editions() or {}
    return [
        Book(title=edition.title, copies=len(edition.books))
        for edition in (yield from qx.get.edition(isbn) for isbn in editions)
    ]


class Framework[QX]:
    def __init__(qx, storage):
        self._qx = qx
        self._storage = storage
        self._js = _quickjs.QuickJS()
        self._framework = self._js.eval("(qx) => new Framework(qx)")(
            _quickjs.Opaque(self._qx),
        )

    def new_query(generator: QueryFunction[QX, T]) -> Query[T]:
        # queryfunc will wrap the python generator in a javascript iterator
        def queryfunc(_: any, prev: T | None, isValid: bool) -> Callable[[Any], Tuple[bool, Any]]:
            g = generator(self._qx, prev, isValid)
            first = True

            def nextfunc(val=None):
                nonlocal first
                if first:
                    first = False
                    val = None
                try:
                    return {"value": g.send(val), "done": False}
                except StopIteration as e:
                    # javascript will not access our return value
                    # and we will receive it in callbacks totally unmodified
                    return {"value": _quickjs.Opaque(e.value), "done": True}

            return {"next": nextfunc}

        # call javascript framework.newQuery() to get javascript _Query
        _query = self._framework.newQuery(queryfunc)

        # wrap _Query in a suitable python interface
        return Query(_query)

    def make_storage(self, txn_factory):
        return _quickjs.make_storage(self._js, txn_factory)


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
