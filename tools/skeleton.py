import base64
import datetime
import json
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
P = TypeVar('P')
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
QueryFunction = Callable[[QX, T | None, bool], QueryGenerator[T]]


class Query[T]:
    def __init__(self, _query: _quickjs.Value):
        self._query = _query

    async def result(self) -> T:
        return cast(T, await _QueryResult(self._query.id))

    def subscribe(self, cb: Callable[[T], None]) -> Callable[[], None]:
        return cast(Callable[[], None], self._query.subscribe(cb))

    def close(self) -> None:
        self._query.close()


class ShaperOutput[E, P](TypedDict):
    events: List[E]
    checkpoint: P


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


class BaseFramework[QX, PX, E, C, P]:
    '''
    BaseFramework chooses not to make assumptions about how you implement:
      - projectors can be written in python, if you want.
      - you can use a javascript query context with python query functions.  Weird, but ok.
      - all this at the cost of way too many type parameters.

    More likely, you should use a generated subclass that guides you through these choices.  But the
    BaseFramework is availalble if you wanna do something crazy.
    '''
    def __init__(
        self,
        bundle: str,
        *,
        decoder: Callable[[Any], E] | str,
        storage: Callable[[bool], Txn] | str,
        qx: QX | str,
        px: PX | str,
        shaper: Callable[[List[E]], ShaperOutput] | str,
        projector: Callable[[PX, List[E]], None] | str,
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

        flags = 1 | (1<<5) # JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILIE_ONLY
        m = self._js.eval(text, file=bundle, sourcemap=sourcemap, flags=flags)

        if isinstance(decoder, str):
            decoder = m[decoder]
        # wrap decoder function, probably from javascript, in a closure that maps it against an
        # entire list of events before returning, to prevent bouncing between python and js too much
        self._decoder = self._js.eval("(decoder) => ((events) => events.map(decoder))")(decoder)

        if isinstance(storage, str):
            # storage is from javascript, maybe InMemTxn
            if hasattr(m, storage):
                storage = self._js.eval("(cls) => new cls()")(m[storage])
            else:
                raise ValueError("unsure how to instantiate storage")
        else:
            # storage is a callable that produces a Txn
            storage = _quickjs.make_storage(self._js, storage)

        if isinstance(qx, str):
            qx = m[qx]
            qxjs = qx
        else:
            qxjs = _quickjs.Opaque(qx)

        if isinstance(px, str):
            px = m[px]
            pxjs = px
        else:
            pxjs = _quickjs.Opaque(px)

        if isinstance(shaper, str):
            shaper = self._js.eval(shaper)

        if isinstance(projector, str):
            projector = m[projector]

        self._framework: _quickjs.Value = self._js.eval(
            "(cls, px, qx, storage, callbacks) => new cls(px, qx, storage, callbacks)",
        )(m["Framework"], pxjs, qxjs, storage, {
            "shaper": shaper,
            "projector": projector
        })

    def new_query(self, generator: QueryFunction[QX, T]) -> Query[T]:
        # queryfunc will wrap the python generator in a javascript iterator
        def queryfunc(qx: QX, prev: T | None, isValid: bool) -> Any:
            g = generator(qx, prev, isValid)
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
        _query = self._framework.newQuery(queryfunc)

        # wrap _Query in a suitable python interface
        return Query(_query)

    def recv_events(self, raw_events: List[Any]) -> None:
        events = self._decoder(raw_events)
        self._framework.recvEvents(events)

    def run(self) -> None:
        self._run()
