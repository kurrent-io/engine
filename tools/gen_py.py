from protos import *
import gen_ts

preamble = r"""
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
""".lstrip()

def generate_annotations(d, annos, t):
    def visit(t, path):
        # visit each type only once
        if t in annos: return
        # handle type aliases for builtin types
        for (cls, jsname) in [
            (String, "str"),
            (Int, "int"),
            (Bool, "bool"),
            (Json, "JSON"),
            (Null, "None"),
        ]:
            if isinstance(t, cls):
                if type(t) is cls:
                    # an actual builtin
                    annos[t] = jsname
                else:
                    # a subclass of a builtin, like class Uuid(String)
                    assert t.name, "unsure why we wouldn't have a name right now"
                    d.print(f"\n{t.name} = {jsname}\n")
                    annos[t] = t.name
                return
        # handle literals, which never need a type definition
        if isinstance(t, Literal):
            if t.value is None:
                annos[t] = "None"
            elif isinstance(t.value, str):
                annos[t] = f'Literal["{t.value}"]'
            elif isinstance(t.value, bool):
                annos[t] = "Literal[True]" if t.value else "Literal[False]"
            elif isinstance(t.value, int):
                annos[t] = f"Literal[{t.value}]"
            else:
                raise ValueError(f"unhandled literal value: {t.value}")
            return
        if hasattr(t, "py_generate_annotation"):
            anno = t.py_generate_annotation(d, annos, visit, path)
        elif isinstance(t, ConcreteArray):
            visit(t.item_type, path)
            anno = f"List[{annos[t.item_type]}]"
        elif isinstance(t, ConcreteTuple):
            for it in t.item_types:
                visit(it, path)
            anno = "Tuple[" + ", ".join(annos[it] for it in t.item_types) + "]"
        elif isinstance(t, ConcreteUnion):
            for i, ut in enumerate(t.types):
                visit(ut, path + str(i))
            anno = " | ".join(annos[ut] for ut in t.types)
        elif isinstance(t, ConcreteStruct):
            for fn, ft in t.fields.items():
                visit(ft, path + "_" + fn)
        elif isinstance(t, ConcreteObject):
            visit(t.value_type, path)
            anno = f"Dict[str, {annos[t.value_type]}]"
        else:
            raise ValueError(f"unhandled type in generate_annotations: {type(t).__name__}")

        if isinstance(t, ConcreteStruct):
            # define a class based on typing.Protocol
            class_name = t.name or path
            annos[t] = class_name
            d.print(f"class {class_name}(Protocol):\n")
            d.indent("    ")
            for k, v in t.fields.items():
                d.print(f"{k}: {annos[v]}\n")
            d.dedent()
            d.print("\n")
        elif t.name:
            d.print(f"{t.name} = {anno}\n\n")
            annos[t] = t.name
        else:
            annos[t] = anno

    visit(t, t.name or "")


def noop_checker(val):
    return ""

_anon = 0

pytyps = {
    "string": "str",
    "boolean": "bool",
    "integer": "int",
    "object": "dict",
    "array": "(list, tuple)",
}

def check_solution(d, annos, checkers, solution):
    d.print("problems = []\n")
    d.print("x = val\n")
    d.print("xpath = path\n")

    def visit(solution):
        if isinstance(solution, Match):
            d.print(checkers[solution.typ]("val", "path"))
            d.print("return problems\n")
        elif isinstance(solution, CheckJsonType):
            for jtyp, subsln in solution.options.items():
                if jtyp == "null":
                    d.print(f"if x is None:\n")
                else:
                    d.print(f"if isinstance(x, {pytyps[jtyp]}):\n")
                d.indent("    ")
                visit(subsln)
                d.dedent()
            # handle no match
            d.print("problems += [f'{xpath}: type {type(x).__name__} not allowed here']\n")
            d.print("return problems\n")
        elif isinstance(solution, CheckLiteral):
            for lit, subsln in solution.options.items():
                if lit is None:
                    d.print(f'if x is None:\n')
                if isinstance(lit, str):
                    d.print(f'if x == "{lit}":\n')
                elif isinstance(lit, (bool, int)):
                    d.print(f"if x == {lit}:\n")
                else:
                    raise ValueError("unexepected Literal type")
                d.indent("    ")
                visit(subsln)
                d.dedent()
            # handle no match
            d.print("problems += [f'{xpath}: unexpected value']\n")
            d.print("return problems\n")
        elif isinstance(solution, CheckLength):
            for length, subsln in solution.options.items():
                d.print(f"if len(x) == {length}:\n")
                d.indent("    ")
                visit(subsln)
                d.dedent()
            # default
            visit(solution.default)
        elif isinstance(solution, GetIndex):
            # CheckLength should already protect us; no need to re-check
            d.print(f"x = x[{solution.i}]\n")
            d.print(f"xpath += '[{solution.i}]'\n")
            visit(solution.solution)
        elif isinstance(solution, GetField):
            d.print(f"if '{solution.key}' not in x:\n")
            d.print(f"    problems += [xpath + f': missing discriminator \"{solution.key}\"']\n")
            d.print(f"    return problems\n")
            d.print(f'x = x["{solution.key}"]\n')
            d.print(f'xpath += ".{solution.key}"\n')
            visit(solution.solution)
        elif isinstance(solution, HasField):
            for field, subsln in solution.solutions:
                d.print(f'if "{field}" in x:\n')
                d.indent("    ")
                visit(subsln)
                d.dedent()
            d.print("problems += [f'{xpath}: no matching keys found']\n")
            d.print("return problems\n")
        else:
            raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    visit(solution)


def generate_checkers(d, annos, checkers, t):
    """
    def checkPatronEvent(val, path: str = "<root>"):
        problems = []
        if not isinstance(val, dict):
            return problems + [path + " is not a json object"]
        if not "id" in dict:
            problems += [path + " is missing id"]
        else:
            problems += checkUuid(val["id"], path + ".id")
        ...
        return problems
    """
    def visit(t):
        global _anon
        if t in checkers: return

        if isinstance(t, Json):
            checkers[t] = noop_checker
            return
        if isinstance(t, String):
            checkers[t] = lambda val, path: (
                f"if not isinstance({val}, str):\n"
                f"    problems += [{path} + f': is of type {{type({val}).__name__}}, not string']\n"
            )
            return
        if isinstance(t, Int):
            checkers[t] = lambda val, path: (
                f"if not isinstance({val}, int):\n"
                f"    problems += [{path} + f': is of type {{type({val}).__name__}}, not int']\n"
            )
            return
        if isinstance(t, Bool):
            checkers[t] = lambda val, path: (
                f"if not isinstance({val}, bool):\n"
                f"    problems += [{path} + f': is of type {{type({val}).__name__}}, not bool']\n"
            )
            return
        if isinstance(t, Null) or (isinstance(t, Literal) and t.value is None):
            checkers[t] = lambda val, path: (
                f"if {val} is not None:\n"
                f"    problems += [{path} + f': is of type {{type({val}).__name__}}, not null']\n"
            )
            return
        if isinstance(t, Literal):
            if isinstance(t.value, str):
                checkers[t] = lambda val, path: (
                    f"if {val} != '{t.value}':\n"
                    f"    problems += [{path} + f': is not \"{t.value}\"']\n"
                )
            elif isinstance(t.value, (int, bool)):
                checkers[t] = lambda val, path: (
                    f"if {val} != {t.value}:\n"
                    f"    problems += [{path} + f': is not {t.value}']\n"
                )
            else:
                raise ValueError(f"unhandled literal value: {t.value}")
            return

        if hasattr(t, "py_generate_checker"):
            # handle custom types
            checker = t.py_generate_checker(d, annos, checkers, visit)
        elif isinstance(t, ConcreteUnion):
            for ut in t.types:
                visit(ut)
            solution = solve_union(t)
            if t.name:
                name = f"check{t.name}"
            else:
                anon = _anon
                _anon += 1
                name = f"_checkAnon{anon}"
            d.print(f"\ndef {name}(val: Any, path: str = '<root>') -> List[str]:\n")
            d.indent("    ")
            check_solution(d, annos, checkers, solution)
            d.dedent()
            checker = lambda val, path: f"problems += {name}({val}, {path})\n"
        elif isinstance(t, ConcreteArray):
            visit(t.item_type)

            def checker(val, path):
                d = Denter()
                d.print(
                    f"if not isinstance({val}, (list, tuple)):\n"
                    f"    problems += [{path} + f': is a {{type({val}).__name}}, not json array']\n"
                )
                if checkers[t.item_type] == noop_checker:
                    return d.getvalue()
                d.print("else:\n")
                d.indent("    ")
                d.print("for i, x in enumerate({val}):\n")
                d.indent("    ")
                d.print(f"xpath = {path} + f'[{{i}}]")
                d.print(checkers[t.item_type]("x", "xpath"))
                return d.getvalue()

        elif isinstance(t, ConcreteStruct):
            for ft in t.fields.values():
                visit(ft)

            if t.name:
                keys = f"_{t.name}_ALLOWED_KEYS"
                func = f"check{t.name}"
            else:
                anon = _anon
                _anon += 1
                keys = f"_ANON_{anon}_ALLOWED_KEYS"
                func = f"_checkAnon{anon}"

            # write a singleton of allowed keys
            keyset = "{" + ", ".join(f'"{fn}"' for fn in t.fields.keys()) + "}"
            d.print(f"\n{keys} = {keyset}\n")

            # write a function
            d.print(f"\ndef {func}(val: Any, path: str = '<root>') -> List[str]:\n")
            d.indent("    ")
            d.print("if not isinstance(val, dict):\n")
            d.print("    return [path + f': is a {type(val).__name}, not json object']\n")
            d.print("problems = []\n")
            # check every field
            for fn, ft in t.fields.items():
                d.print(f"if '{fn}' in val:\n")
                d.indent("    ")
                d.print(f"x = val['{fn}']\n")
                d.print(f"xpath = path + '.{fn}'\n")
                d.print(checkers[ft]("x", "xpath"))
                d.dedent()
                if fn not in t.maybes:
                    d.print("else:\n")
                    d.print(f"    problems += [path + ': missing required key {fn}']\n")
            # check for extra fields
            d.print(f"if {keys}.difference({keys}):\n")
            d.print(f"    problems += [path + ': contains extra keys']\n")
            d.print("return problems\n")
            d.dedent()
            d.print(f"\n")

            checker = lambda val, path: f"problems += {func}({val}, {path})\n"

        elif isinstance(t, ConcreteObject):
            visit(t.value_type)

            def checker(val, path):
                d = Denter()
                d.print(
                    f"if not isinstance({val}, dict):\n"
                    f"    problems += [{path} + f': is a {{type({val}).__name}}, not json object']\n"
                )
                if checkers[t.value_type] == noop_checker:
                    return d.getvalue()
                d.print("else:\n")
                d.indent("    ")
                d.print(f"for k, v in {val}.items():\n")
                d.indent("    ")
                d.print(f"xpath = {path} + f'.{{k}}'\n")
                d.print(checkers[t.value_type]("v", "xpath"))
                return d.getvalue()

        else:
            raise ValueError(f"unhandled type in generate_checkers: {t}")

        # named types without a function already defined get a wrapper now
        if t.name and not isinstance(t, (ConcreteUnion, ConcreteStruct)):
            d.print(f"\ndef check{t.name}(val: Any, path: str = '<root>') -> List[str]:\n")
            d.indent("    ")
            d.print("problems = []\n")
            d.print(checker("val", "path"))
            d.print("return problems\n")
            d.dedent()
        checkers[t] = checker

    visit(t)


def generate_store(d, annos, store):
    # pick super classes
    if not store.deps:
        supers = ""
    else:
        supers = "(" + ", ".join(f"{dep.name}QueryContext" for dep in store.deps) +  ")"
    # Generate the QueryContext class.
    d.print(f"\nclass {store.name}QueryContext{supers}:\n")
    d.indent("    ")
    # generate getters like:
    #
    #     @staticmethod
    #     def topic(topic_uuid: string) -> Awaitable[Topic]:
    #         return yield from _StoreResult(f"topic.{topic_uuid}"))
    original_items = [si for si in store.items if si.origin == store]
    for i, si in enumerate(original_items):
        if i: d.print("\n")
        d.print("@staticmethod\n")
        d.print(f"def {si.name}(")
        d.print(", ".join(p + ": str" for p in si.params))
        d.print(f") -> Awaitable[{annos[si.type]}]:\n")
        d.indent("    ")
        d.print(f"return _StoreResult(" + ("f'" if si.params else "'"))
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "{" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"')\n")
        d.dedent()
    if not original_items:
        d.print("pass\n")
    d.dedent()


def generate_framework(d, annos, f):
    """
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
    """
    QX = f"{f.store.name}QueryContext"
    PX = f"{f.store.name}ProjectorContext"
    E = annos[f.event_type]
    C = annos[f.event_type]
    d.print("\n")
    d.print("\n")
    d.print(f"class {f.name}[P](BaseFramework[\n")
    d.print(f"    {QX},  # python query context, enabling python queries\n")
    d.print(f"    _quickjs.Value,  # projector context assumes we're using javascript projectors\n")
    d.print(f"    {E},  # event type from server\n")
    d.print(f"    {C},  # command type to server\n")
    d.print(f"    P,  # checkpoint type, configured by user\n")
    d.print(f"]):\n")
    d.print(f"    def __init__(\n")
    d.print(f"        self,\n")
    d.print(f"        bundle: str,\n")
    d.print(f"        storage: Callable[[bool], Txn] | str,\n")
    d.print(f"        shaper: Callable[[List[{E}]], ShaperOutput[{E}, P]] | str,\n")
    d.print(f"        projector: str,\n")
    d.print(f"    ):\n")
    d.print(f"        super().__init__(\n")
    d.print(f"            bundle,\n")
    d.print(f"            storage=storage,\n")
    d.print(f"            shaper=shaper,\n")
    d.print(f"            projector=projector,\n")
    d.print(f"            decoder='Decode{f.event_type.name}',\n")
    d.print(f"            px='{PX}',\n")
    d.print(f"            qx={QX}(),\n")
    d.print(f"        )\n")


# entrypoint for protos.py
def generate(d, concretes, roots, stores, frameworks, args):
    assert roots, "must supply roots with -r"

    d.print(preamble)

    types_to_visit = (
        [r for r in roots]
        + [si.type for s in stores for si in s.items]
        + [si.type for f in frameworks for si in f.store.items]
    )

    # Define types and decide on type annotations.
    annos = {}
    for t in types_to_visit:
        generate_annotations(d, annos, t)

    # Generate json checkers, for receiving incoming json.
    # checkers shall contain snippets of code that append problems to a `problems` variable
    checkers = {}
    for t in types_to_visit:
        generate_checkers(d, annos, checkers, t)

    # generate query contexts from stores
    for s in stores:
        generate_store(d, annos, s)

    # generate frameworks
    for f in frameworks:
        generate_framework(d, annos, f)
