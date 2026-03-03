from protos import *
import gen_ts

preamble = """
import datetime
from typing import (
    Any,
    Callable,
    Dict,
    Generator,
    List,
    Literal,
    NotRequired,
    Protocol,
    Tuple,
    TypedDict,
    TypeVar,
)
import _quickjs


JSON = Dict[str, 'JSON'] | List['JSON'] | str | int | bool | None
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


def generate_store_prereqs(d):
    d.print("\n")
    d.print("\n")
    d.print("class StorageValue(TypedDict):\n")
    d.print("    err: NotRequired[Any]\n")
    d.print("    value: NotRequired[Any]\n")
    d.print("\n")
    d.print("\n")
    d.print("class QueryQuestion(TypedDict):\n")
    d.print("    store: NotRequired[Dict[str, Literal[True]]]\n")
    d.print("    query: NotRequired[Dict[str, Literal[True]]]\n")
    d.print("\n")
    d.print("\n")
    d.print("class QueryAnswer(TypedDict):\n")
    d.print("    store: Dict[str, StorageValue]\n")
    d.print("    query: Dict[str, Tuple[Any, bool]]\n")
    d.print("\n")
    d.print("\n")
    d.print("T = TypeVar('T')\n")
    d.print("QueryGenerator = Generator[QueryQuestion, QueryAnswer, T]\n")
    d.print("\n")
    d.print("\n")
    d.print("QX = TypeVar('QX')\n")
    d.print("QueryFunction = Callable[[QX, T | None, bool], QueryGenerator[T]]\n")
    d.print("\n")
    d.print("\n")
    # d.print("class Query[T]:\n")
    # d.print("    def __init__(self, _query):\n")
    # d.print("        self._query = _query\n")
    # d.print("\n")
    # d.print("    def awaitResult(self) -> QueryGenerator[T]:\n")
    # d.print("        # ask the graph for the result of this query when it's ready\n")
    # d.print("        ans = yield {'query': {self._query.id: True}}\n")
    # d.print("        result, dirty = ans['query'][self._query.id]\n")
    # d.print("        return result\n")
    # d.print("\n")
    # d.print("    def subscribe(self, cb: Callable[[T], None]) -> Callable[[], None]:\n")
    # d.print("        return self._query.subscribe(cb)\n")
    # d.print("\n")
    # d.print("    def close(self) -> None:\n")
    # d.print("        self._query.close()\n")
    # d.print("\n")
    # d.print("\n")
    d.print("def _query_getter(key: str) -> QueryGenerator[Any]:\n")
    d.print("    ans = (yield {'store': {key: True}})['store'][key]\n")
    d.print("    if 'err' in ans:\n")
    d.print("        raise ValueError(ans['err'])\n")
    d.print("    return ans['value']\n")


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
    #     def topic(topic_uuid: string) -> QueryGenerator[Topic]:
    #         return yield from _query_getter(f"topic.{topic_uuid}"))
    original_items = [si for si in store.items if si.origin == store]
    for i, si in enumerate(original_items):
        if i: d.print("\n")
        d.print("@staticmethod\n")
        d.print(f"def {si.name}(")
        d.print(", ".join(p + ": str" for p in si.params))
        d.print(f") -> QueryGenerator[{annos[si.type]}]:\n")
        d.indent("    ")
        d.print(f"return _query_getter(" + ("f'" if si.params else "'"))
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "{" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"')\n")
        d.dedent()
    if not original_items:
        d.print("pass\n")
    d.dedent()


def generate_framework_prereqs(d):
    d.print("\n")
    d.print("\n")
    d.print("class Framework[QX]:\n")
    d.print("    def __init__(qx, storage):\n")
    d.print("        self._qx = qx\n")
    d.print("        self._storage = storage\n")
    d.print("        self._js = _quickjs.QuickJS()\n")
    d.print("        self._framework = self._js.eval('(qx) => new Framework(qx)')(\n")
    d.print("            _quickjs.Opaque(self._qx),\n")
    d.print("        )\n")
    d.print("\n")
    d.print("    def new_query(generator: QueryFunction[QX, T]) -> Query[T]:\n")
    d.print("        # queryfunc will wrap the python generator in a javascript iterator\n")
    d.print("        def queryfunc(_: any, prev: T | None, isValid: bool) -> Callable[[Any], Tuple[bool, Any]]:\n")
    d.print("            g = generator(self._qx, prev, isValid)\n")
    d.print("            first = True\n")
    d.print("\n")
    d.print("            def nextfunc(val=None):\n")
    d.print("                nonlocal first\n")
    d.print("                if first:\n")
    d.print("                    first = False\n")
    d.print("                    val = None\n")
    d.print("                try:\n")
    d.print("                    return {'value': g.send(val), 'done': False}\n")
    d.print("                except StopIteration as e:\n")
    d.print("                    # javascript will not access our return value\n")
    d.print("                    # and we will receive it in callbacks totally unmodified\n")
    d.print("                    return {'value': _quickjs.Opaque(e.value), 'done': True}\n")
    d.print("\n")
    d.print("            return {'next': nextfunc}\n")
    d.print("\n")
    d.print("        # call javascript framework.newQuery() to get javascript _Query\n")
    d.print("        _query = self._framework.newQuery(queryfunc)\n")
    d.print("\n")
    d.print("        # wrap _Query in a suitable python interface\n")
    d.print("        return Query(_query)\n")
    d.print("\n")
    d.print("    def make_storage(self, txn_factory):\n")
    d.print("        return _quickjs.make_storage(self._js, txn_factory)\n")


def generate_framework(d, annos, f):
    pass


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
    if stores:
        generate_store_prereqs(d)
    for s in stores:
        generate_store(d, annos, s)

    # # generate frameworks
    # if frameworks:
    #     generate_framework_prereqs(d)
    # for f in frameworks:
    #     generate_framework(d, annos, f)
