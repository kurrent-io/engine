from protos import *
import gen_ts

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
            (Date, "datetime.datetime"),
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
                if k in t.always:
                    d.print(f"{k}: {annos[v]}\n")
                else:
                    d.print(f"{k}: Optional[{annos[v]}]\n")
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

_loopvar = 0
def get_loopvar():
    # a unique loop variable name, so nested array checkers don't shadow each other's index
    global _loopvar
    v = f"i{_loopvar}"
    _loopvar += 1
    return v

pytyps = {
    "string": "str",
    "boolean": "bool",
    "int": "int",
    "object": "dict",
    "array": "(list, tuple)",
}

def check_solution(d, annos, checkers, solution):
    d.print("problems = []\n")
    d.print("x0 = val\n")
    d.print("xpath0 = path\n")

    # `obj` names the value/path currently being navigated; `subj` names the value/path the
    # enclosing check tests.  GetField mints a fresh, uniquely-numbered subject variable from
    # `obj` but leaves `obj` unchanged, so sibling discriminators like [type, v] both read from
    # the same object rather than from a previously extracted field.  Only GetIndex descends
    # `obj` (into an array element).
    counter = [1]

    def visit(solution, obj, subj):
        objvar, objpath = obj
        subjvar, subjpath = subj
        if isinstance(solution, Match):
            d.print(checkers[solution.typ]("val", "path"))
            d.print("return problems\n")
        elif isinstance(solution, CheckJsonType):
            for jtyp, subsln in solution.options.items():
                if jtyp == "null":
                    d.print(f"if {subjvar} is None:\n")
                else:
                    d.print(f"if isinstance({subjvar}, {pytyps[jtyp]}):\n")
                d.indent("    ")
                visit(subsln, obj, obj)
                d.dedent()
            # handle no match
            d.print(f"problems += [f'{{{subjpath}}}: type {{type({subjvar}).__name__}} not allowed here']\n")
            d.print("return problems\n")
        elif isinstance(solution, CheckLiteral):
            for lit, subsln in solution.options.items():
                if lit is None:
                    d.print(f'if {subjvar} is None:\n')
                if isinstance(lit, str):
                    d.print(f'if {subjvar} == "{lit}":\n')
                elif isinstance(lit, (bool, int)):
                    d.print(f"if {subjvar} == {lit}:\n")
                else:
                    raise ValueError("unexepected Literal type")
                d.indent("    ")
                visit(subsln, obj, obj)
                d.dedent()
            # handle no match
            d.print(f"problems += [f'{{{subjpath}}}: unexpected value']\n")
            d.print("return problems\n")
        elif isinstance(solution, CheckLength):
            for length, subsln in solution.options.items():
                d.print(f"if len({subjvar}) == {length}:\n")
                d.indent("    ")
                visit(subsln, obj, obj)
                d.dedent()
            # default
            if solution.default is not None:
                visit(solution.default, obj, obj)
        elif isinstance(solution, GetIndex):
            # CheckLength should already protect us; no need to re-check
            i = counter[0]; counter[0] += 1
            d.print(f"x{i} = {objvar}[{solution.i}]\n")
            d.print(f"xpath{i} = {objpath} + '[{solution.i}]'\n")
            nxt = (f"x{i}", f"xpath{i}")
            visit(solution.solution, nxt, nxt)
        elif isinstance(solution, GetField):
            i = counter[0]; counter[0] += 1
            d.print(f"if '{solution.key}' not in {objvar}:\n")
            d.print(f"    problems += [{objpath} + f': missing discriminator \"{solution.key}\"']\n")
            d.print(f"    return problems\n")
            d.print(f'x{i} = {objvar}["{solution.key}"]\n')
            d.print(f'xpath{i} = {objpath} + ".{solution.key}"\n')
            visit(solution.solution, obj, (f"x{i}", f"xpath{i}"))
        elif isinstance(solution, HasField):
            for field, subsln in solution.solutions:
                d.print(f'if "{field}" in {objvar}:\n')
                d.indent("    ")
                visit(subsln, obj, obj)
                d.dedent()
            d.print(f"problems += [f'{{{subjpath}}}: no matching keys found']\n")
            d.print("return problems\n")
        else:
            raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    visit(solution, ("x0", "xpath0"), ("x0", "xpath0"))


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
        if isinstance(t, Date):
            checkers[t] = lambda val, path: (
                "try:\n"
                f"    datetime.datetime.strptime({val}, '%Y-%m-%dT%H:%M:%SZ')\n"
                "except ValueError:\n"
                "    try:\n"
                f"        datetime.datetime.strptime({val}, '%Y-%m-%dT%H:%M:%S.%fZ')\n"
                "    except ValueError:\n"
                f"        problems += [{path} + ': invalid timestamp']\n"
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
                    f"    problems += [{path} + f': is a {{type({val}).__name__}}, not json array']\n"
                )
                if checkers[t.item_type] == noop_checker:
                    return d.getvalue()
                d.print("else:\n")
                d.indent("    ")
                iv = get_loopvar()
                d.print(f"for {iv} in range(len({val})):\n")
                d.indent("    ")
                # index the element and build its path off the original expressions, so nothing
                # is clobbered when this checker is inlined inside another
                d.print(checkers[t.item_type](f"({val})[{iv}]", f"{path} + f'[{{{iv}}}]'"))
                return d.getvalue()

        elif isinstance(t, ConcreteTuple):
            for it in t.item_types:
                visit(it)

            def checker(val, path):
                d = Denter()
                n = len(t.item_types)
                d.print(
                    f"if not isinstance({val}, (list, tuple)):\n"
                    f"    problems += [{path} + f': is a {{type({val}).__name__}}, not json array']\n"
                )
                d.print(f"elif len({val}) != {n}:\n")
                d.print(f"    problems += [{path} + f': expected {n} items, not {{len({val})}}']\n")
                # index each element off the original value/path expressions, so nothing is
                # clobbered even when this checker is inlined inside another (e.g. a struct field)
                parts = [
                    checkers[it](f"({val})[{i}]", f"{path} + '[{i}]'")
                    for i, it in enumerate(t.item_types)
                ]
                parts = [p for p in parts if p]
                if parts:
                    d.print("else:\n")
                    d.indent("    ")
                    for p in parts:
                        d.print(p)
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
            d.print("    return [path + f': is a {type(val).__name__}, not json object']\n")
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
            d.print(f"if set(val).difference({keys}):\n")
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
                    f"    problems += [{path} + f': is a {{type({val}).__name__}}, not json object']\n"
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


def context_name(name):
    return name[:-5] if name.endswith("Store") else name


def generate_store(d, annos, store):
    # pick super classes
    if not store.deps:
        supers = ""
    else:
        supers = "(" + ", ".join(f"{context_name(dep.name)}QueryContext" for dep in store.deps) +  ")"
    # Generate the QueryContext class.
    d.print(f"\nclass {context_name(store.name)}QueryContext{supers}:\n")
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


def framework_name(name):
    return name if name.endswith("Framework") else (name + 'Framework')


def generate_framework(d, annos, f):
    """
    class DeciderFramework(Framework[
        DeciderStoreQueryContext,  # QX: a python object, enabling python queries
        LibraryEvents,  # E: events from the server
        LibraryEvents,  # C: commands to the server
    ]):
        def __init__(
            self,
            bundle: str,
            storage: Callable[[bool], Txn] | None,
            migrate: str | None,
            reducer: str,
        ) -> None:
            super().__init__(
                bundle=bundle,
                framework_cls="DeciderFramework",
                storage=storage,
                qx=DeciderStoreQueryContext(),
                migrate=migrate,
                reducer=reducer,
            )
    """
    QX = f"{context_name(f.store.name)}QueryContext"
    E = annos[f.event_type]
    C = annos[f.command_type]
    d.print("\n")
    d.print("\n")
    d.print(f"class {framework_name(f.name)}(Framework[\n")
    d.print(f"    {QX},  # python query context, enabling python queries\n")
    d.print(f"    {E},  # event type from server\n")
    d.print(f"    {C},  # command type to server\n")
    d.print(f"]):\n")
    d.print(f"    def __init__(\n")
    d.print(f"        self,\n")
    d.print(f"        bundle: str,\n")
    d.print(f"        storage: Callable[[bool], Txn] | None,\n")
    d.print(f"        migrate: str | None,\n")
    d.print(f"        reducer: str,\n")
    d.print(f"    ):\n")
    d.print(f"        super().__init__(\n")
    d.print(f"            bundle=bundle,\n")
    d.print(f"            framework_cls='{framework_name(f.name)}',\n")
    d.print(f"            storage=storage,\n")
    d.print(f"            qx={QX}(),\n")
    d.print(f"            migrate=migrate,\n")
    d.print(f"            reducer=reducer,\n")
    d.print(f"        )\n")


# entrypoint for protos.py
def generate(d, concretes, roots, stores, frameworks, args):
    assert roots, "must supply roots with -r"

    # include skeleton code
    with open(os.path.join(os.path.dirname(__file__), "skeleton.py"), "r") as f:
        d.print(f.read())
    d.print("\n\n")

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
