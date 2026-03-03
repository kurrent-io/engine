from typing import TypeVar, Callable, cast, TypedDict, List, Any, Tuple, Protocol, reveal_type
import json
import base64
import dataclasses

from library_gen import QueryGenerator, QueryFunction, DeciderStoreQueryContext, LibraryEvents, checkLibraryEvents

import _quickjs


T = TypeVar('T')
E = TypeVar('E')
C = TypeVar('C')
P = TypeVar('P')
QX = TypeVar('QX')

class Query[T]:
    def __init__(self, _query: _quickjs.Value):
        self._query = _query

    def awaitResult(self) -> QueryGenerator[T]:
        # ask the graph for the result of this query when it's ready
        ans = yield {"query": {self._query.id: True}}
        result, dirty = ans["query"][self._query.id]
        return cast(T, result)

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
    """
    BaseFramework chooses not to make assumptions about how you implement:
      - projectors can be written in python, if you want.
      - you can use a javascript query context with python query functions.  Weird, but ok.
      - all this at the cost of way too many type parameters.

    More likely, you should use a generated subclass that guides you through these choices.  But the
    BaseFramework is availalble if you wanna do something crazy.
    """
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
            """// run a closure that returns a value, so we don't pollute global namespace
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
            })();""",
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

    def make_storage(self, txn_factory: Callable[[bool], Txn]) -> _quickjs.Value:
        return _quickjs.make_storage(self._js, txn_factory)

    def recv_events(self, raw_events: List[Any]) -> None:
        events = self._decoder(raw_events)
        self._framework.recvEvents(events)
        self._run()


class DeciderFramework[P](BaseFramework[
    DeciderStoreQueryContext,  # QX: a python object, enabling python queries
    _quickjs.Value,  # PX: a javascript object, because projectors come from javascript
    LibraryEvents,  # E: events from the server
    LibraryEvents,  # C: commands to the server
    P,  # P: checkpoint type, configured by user
]):
    def __init__(
        self,
        bundle: str,
        storage: Callable[[bool], Txn] | str,
        shaper: Callable[[List[LibraryEvents]], ShaperOutput[LibraryEvents, P]] | str,
    ) -> None:
        super().__init__(
            bundle,
            storage=storage,
            decoder="DecodeLibraryEvents",
            px="DeciderStoreProjectorContext",
            qx=DeciderStoreQueryContext(),
            shaper=shaper,
            projector="deciderProjector",
        )

fw = DeciderFramework[Any](
    "relay.js",
    "InMemStorage",
    lambda events: {"events": events, "checkpoint": None},
)

event = {
    "type": "add-edition",
    "isbn": "my-isbn",
    "title": "cheech-and-chong-learn-event-sourcing",
    "timestamp": "2025-01-24T15:54:32Z",
}
assert not (errors := checkLibraryEvents(event)), "errors:\n  - " + "\n  - ".join(errors)

@dataclasses.dataclass
class Book:
    title: str
    copies: int

@fw.new_query
def book_list(qx: DeciderStoreQueryContext, *_: Any) -> QueryGenerator[List[Book]]:
    editions = []
    for isbn in ((yield from qx.editions()) or {}):
        editions.append((yield from qx.edition(isbn)))
    return [
        Book(title=edition.title, copies=len(edition.books)) for edition in editions
    ]

book_list.subscribe(lambda bl: print("book list is:", bl))

fw.recv_events([event])
