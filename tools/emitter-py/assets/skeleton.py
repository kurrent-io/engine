import base64
import datetime
import json
import uuid
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Generator,
    List,
    Literal,
    NotRequired,
    Optional,
    Protocol,
    Tuple,
    TypedDict,
    TypeVar,
    cast,
)

import _quickjs


JSON = Dict[str, 'JSON'] | List['JSON'] | str | int | bool | None

T = TypeVar('T')
E = TypeVar('E')
C = TypeVar('C')
QX = TypeVar('QX')


class StorageValue(TypedDict):
    err: NotRequired[Any]
    value: NotRequired[Any]


class QueryQuestion(TypedDict):
    store: NotRequired[Dict[str, Literal[True]]]
    query: NotRequired[Dict[str, Literal[True]]]


class QueryAnswer(TypedDict):
    store: Dict[str, StorageValue]
    query: Dict[str, Tuple[Any, bool]]


class _QueryResult:
    def __init__(self, id: str) -> None:
        self._id = id

    def __await__(self) -> Generator[QueryQuestion, QueryAnswer, Any]:
        # ask the graph for the result of a query when it's ready
        ans = yield {"query": {self._id: True}}
        result, dirty = ans["query"][self._id]
        return result


class _StoreResult:
    def __init__(self, key: str) -> None:
        self._key = key

    def __await__(self) -> Generator[QueryQuestion, QueryAnswer, Any]:
        ans = (yield {"store": {self._key: True}})["store"][self._key]
        if "err" in ans:
            raise ValueError(ans["err"])
        return ans["value"]


# technically we have type information of what is yielded and sent, but async python wants Any,Any
QueryGenerator = Coroutine[Any, Any, T]
QueryFunction = Callable[[QX], QueryGenerator[T]]


class Query[T]:
    def __init__(self, _query: _quickjs.Value):
        self._query = _query

    @property
    def latest(self) -> T | None:
        return cast(T | None, self._query.latest)

    def subscribe(self, cb: Callable[[T], None]) -> Callable[[], None]:
        return cast(Callable[[], None], self._query.subscribe(cb))

    def close(self) -> None:
        self._query.close()

    async def result(self) -> T:
        return cast(T, await _QueryResult(self._query.id))


# TODO: only synchronous storage is currently supported, for two reasons:
#
#  - This strategy of catching an exception and converting it to a {err: "the exception"}
#    storage callback does not work if the operation doesn't complete within the txn method.
#    You can union every return type like `-> None | Awaitable[None]` to allow async
#    implementations of each protocol method, but _quickjs.make_storage() would need additional
#    work.  I suppose in that case, the setTimeout() definition should be written so that
#    callbacks are async as well.  Or maybe that could also be autodetected, if the callbacks
#    return coroutines instead of plain python values.
#
#  - The fx.wakeup() called within the storage callback must be followed by running the event
#    loop, but supporting that would require adding an additional run() closure variable to the
#    various glue functions behind _quickjs.make_storage(), since it must occur some time after
#    the Txn methods return.
#
# For now, we don't care because our only target storage mechanism is LMDB, which is synchronous
# anyway.
class Txn(Protocol):
    def commit(self) -> None: ...
    def abort(self) -> None: ...
    # get shall raise a KeyError if the key is not present
    def get(self, key: str) -> memoryview: ...
    def set(self, key: str, value: memoryview) -> None: ...
    def delete(self, key: str) -> None: ...


class ReconnectInfo[C](Protocol):
    checkpoint: int | None
    commands: List[C]


class Framework[QX, E, C]:
    def __init__(
        self,
        bundle: str,
        framework_cls: str,
        # if storage is None, InMemStorage (from typescript) is used
        storage: Callable[[bool], Txn] | None,
        qx: QX,
        migrate: str | None,
        reducer: str,
    ) -> None:
        self._js = _quickjs.QuickJS()

        # The Framework api is already callback-based, not async, so a very simple event loop is
        # enough to support setTimeout().  Support setTimeout() with non-zero delay is not needed.
        self._run = self._js.eval(
            '''// run a closure that returns a value, so we don't pollute global namespace
            (() => {
                const fns = [];

                // define a global setTimeout
                globalThis.setTimeout = (fn, timeout) => {
                    if (timeout !== undefined && timeout !== 0) {
                        throw new Error("setTimeout with nonzero timeout not supported");
                    }
                    fns.push(fn);
                };

                // return a run() function
                let running = false;
                return () => {
                    if (running) return;
                    running = true;
                    try {
                        let fn;
                        while((fn = fns.shift())){
                            fn();
                        }
                    } finally {
                        running = false;
                    }
                };
            })();''',
            file="Framework.run",
        )

        with open(bundle) as f:
            text = f.read()
        sourcemap_index = text.find("//# sourceMappingURL=")
        if sourcemap_index == -1:
            sourcemap = None
        else:
            b64 = text[sourcemap_index:].split(",", maxsplit=1)[1].split("\n", maxsplit=1)[0]
            sourcemap = json.loads(base64.b64decode(b64))

        flags = 1 | (1<<5) # JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY
        self.module = self._js.eval(text, file=bundle, sourcemap=sourcemap, flags=flags)

        storagejs = storage and _quickjs.make_storage(self._js, storage)

        callbacks: Dict[str, Any] = {
            "migrate": migrate and self.module[migrate],
            "reducer": self.module[reducer],
        }

        self._framework: _quickjs.Value = self._js.eval(
            "(cls, storage, callbacks, qx) => new cls(storage, callbacks, qx)",
        )(self.module[framework_cls], storagejs, callbacks, _quickjs.Opaque(qx))

    def new_query(self, generator: QueryFunction[QX, T]) -> Query[T]:
        # queryfunc will wrap the python generator in a javascript iterator
        def queryfunc(qx: QX) -> Any:
            g = generator(qx)
            first = True

            def nextfunc(val: Any = None) -> Any:
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
        _query = self._framework.newQuery(queryfunc, True)

        # wrap javascript query in python wrapper
        query: Query[T] = Query(_query)

        # now run the framework
        self._run()

        return query

    def recv_events(self, events: List[Any]) -> None:
        self._framework.recvEvents(events)
        self._run()

    def fell_behind(self) -> None:
        self._framework.fellBehind()
        self._run()

    def caught_up(self) -> None:
        self._framework.caughtUp()
        self._run()

    def reconnect(self) -> int | None:
        info: ReconnectInfo[C] | None = None

        def on_result(x: ReconnectInfo | None) -> None:
            nonlocal info
            info = x

        self._framework.reconnect(on_result)
        self._run()

        return info.checkpoint if info else None

    def simulate[T](
        self,
        fn: Callable[[Any, List[E]], T],
        undecoded_events: List[Event[Any]] | None = None,
    ) -> T:
        sentinel = object()
        result: Any = sentinel

        def on_result(r: Any | None) -> None:
            nonlocal result
            result = r

        self._framework.simulate(fn, on_result, undecoded_events)
        self._run()

        assert result is not sentinel
        return cast(T, result)

# helpers for dealing with metadata-wrapped event types

class Event[T](TypedDict):
    id: str
    data: T

def checkEvent(
    val: Any, subchecker: Callable[[Any, str], List[str]], path: str = "<root>",
) -> List[str]:
    if not isinstance(val, dict):
        return [path + f': is a {type(val).__name__}, not json object']
    problems = []
    if 'id' not in val:
        problems += [path + ': missing required key id']
    elif not isinstance((id := val['id']), str):
        problems += [path + f'.id: is a {type(id).__name__}, not a str']
    else:
        try:
            _ = uuid.UUID(id)
        except ValueError:
            problems += [path + '.id: invalid uuid']
    if 'data' not in val:
        problems += [path + ': missing required key data']
    else:
        problems += subchecker(val['data'], path + '.data')

    return problems
