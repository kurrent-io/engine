import abc
import os
import re


class Resolvable(metaclass=abc.ABCMeta):
    """
    Resolvable is an object that .resolve()'s into a Concrete type.

    Resolvable is useful for:
      - forward references
      - simple concrete types, to allow e.g. String instead of String() everywhere
      - composition types, which may contain resolvables
    """
    _resolvables = []
    def __new__(cls, *args, **kwargs):
        out = super().__new__(cls)
        Resolvable._resolvables.append(out)
        return out

    @abc.abstractmethod
    def resolve(self):
        pass

    def __iter__(self):
        """
        All types are iterable, but non-Union types yield only self.
        """
        yield self

    def __or__(self, other):
        """
        Implicit Union creation (Atype | Btype) is a pre-resolve feature.
        """
        return Union(*self, *other)

_all_concretes = []

class ConcreteMeta(type):
    """
    ConcreteMeta ensures that all instances of Concrete types are unique, and attempting to create
    an identical instance results in a new reference to the first.  This ensures that object
    equality is 1:1 with type equality for Concrete types.

    ConcreteMeta is itself Resolvable; so you can use e.g. String instead of String().
    """
    def __init__(self, name, supers, classdict):
        super().__init__(name, supers, classdict)
        # every combination of input args/kwargs will result in a stable, unique object
        self._instances = {}

    def __call__(self, *args, **kwargs):
        key = (args, tuple((k, v) for k, v in sorted(kwargs.items())))
        val = self._instances.get(key)
        if val is None:
            # first time seeing this args/kwargs combo
            val = self.__new__(self, *args, **kwargs)
            val.__init__(*args, **kwargs)
            _all_concretes.append(val)
            # if subclass does not implement resolve, inject one now
            if not hasattr(val, "resolve"):
                val.resolve = lambda: val
            self._instances[key] = val
        return self._instances[key]

    def resolve(self):
        """
        ConcreteMeta is a Resolvable, but will fail if the Concrete type needs parameters.

        So String is a valid Resolvable but ConcreteStruct is not.
        """
        return self()

    def __iter__(self):
        """
        It is only valid to iterate on a Concrete type that needs no paramters, so we resolve now.
        """
        yield self()

    def __or__(self, other):
        """
        Implicit Union creation (Atype | Btype) is a pre-resolve feature.
        """
        return Union(self(), *other)

class Concrete(metaclass=ConcreteMeta):
    def __new__(cls, *args, **kwargs):
        # make sure Concrete never sneaks into the list of all _all_concretes
        if cls is Concrete:
            raise TypeError("you cannot instantiate the Concrete class, only a subclass")
        out = super().__new__(cls)
        # every Concrete starts with an empty name
        out.name = None
        return out

    # This definition is injected by ConcreteMeta when the subclass is instantiated
    # but it isn't defined on Concrete so that ConcreteMeta.resolve() can be invoked when e.g.
    # String.resolve() is called.
    #
    # def resolve(self):
    #     """
    #     Concrete types .resolve() into themselves.
    #     """
    #     return self

    def __iter__(self):
        """
        All types are iterable, but non-Union types yield only self.
        """
        yield self

    def __or__(self, other):
        """
        Implicit Union creation (Atype | Btype) is a pre-resolve feature.
        """
        return Union(*self, *other)

# Simple types (always Concrete)

class Null(Concrete):
    json_type = "null"
    def __repr__(self):
        return "null"

class Int(Concrete):
    json_type = "int"
    def __repr__(self):
        return "int"

class String(Concrete):
    json_type = "string"
    def __repr__(self):
        return "str"

class Bool(Concrete):
    json_type = "boolean"
    def __repr__(self):
        return "bool"

class Literal(Concrete):
    def __init__(self, value, /):
        self.value = value
        # derive json_type from value
        for py_type, json_type in [
            (bool, "boolean"),
            (str, "string"),
            (int, "int"),
        ]:
            if isinstance(value, py_type):
                self.json_type = json_type
                break
        else:
            raise ValueError(f"illegal value for Literal({value})")

    def __repr__(self):
        if self.json_type == "boolean":
            return "true" if self.value else "false"
        if self.json_type == "string":
            return f'"{self.value}"'
        if self.json_type == "int":
            return str(self.value)

class Json(Concrete):
    json_type = "*"

    def __repr__(self):
        return "json"

# Compound and helper types (Resolvable and Concrete forms)

class Alias(Resolvable):
    def __init__(self, type):
        self.type = type

    def resolve(self):
        return self.type.resolve()


class Forward(Resolvable):
    def __init__(self):
        self.type = None

    def set(self, type):
        assert self.type is None, "multiple calls to .set()"
        self.type = type
        return type

    def resolve(self):
        assert self.type is not None, ".set() was never called"
        return self.type.resolve()


class Struct(Resolvable):
    def __init__(self, **fields):
        self.fields = fields

    def resolve(self):
        return ConcreteStruct(**{k: v.resolve() for k, v in self.fields.items()})

class ConcreteStruct(Concrete):
    json_type = "object"
    def __init__(self, **fields):
        # fields contains all fields, regardless of maybe status
        self.fields = {k: (v.type if isinstance(v, Maybe) else v) for k, v in fields.items()}
        # always contains only non-maybe fields
        self.always = {k: v for k, v in fields.items() if not isinstance(v, Maybe)}
        # maybes contains only maybe fields
        self.maybes = {k: v.type for k, v in fields.items() if isinstance(v, Maybe)}

    def __repr__(self):
        if self.name:
            return self.name
        def mkfield(k, v):
            question = "?" if k in self.maybes else ""
            return f"{k}{question}: {v}"
        return "{" + ", ".join(mkfield(k, v) for k, v in self.fields.items()) + "}"


# Maybe is a decorator around another type, for expressing that a key may not be present in a struct
#
# It is technically Resolvable but the resolved Maybe is consumed by the ConcreteStruct constructor.
class Maybe:
    # we have to be careful to never create duplicate maybes so the idempotency logic in
    # ConcreteMeta does not break, but we don't want this to show up as a concrete type in
    # _all_concretes, so we hande it here internally.
    # {resolved_type: resolved_maybe}
    _resolved = {}

    def __init__(self, type):
        self.type = type

    def resolve(self):
        rtype = self.type.resolve()
        if rtype not in Maybe._resolved:
            Maybe._resolved[rtype] = Maybe(rtype)
        return Maybe._resolved[rtype]

    def __repr__(self):
        return str(self.type)


class Object(Resolvable):
    def __init__(self, value_type):
        self.value_type = value_type

    def resolve(self):
        return ConcreteObject(self.value_type.resolve())


class ConcreteObject(Concrete):
    json_type = "object"

    def __init__(self, value_type, /):
        self.value_type = value_type

    def __repr__(self):
        return f"Object[{self.value_type}]"


class Array(Resolvable):
    def __init__(self, item_type):
        self.item_type = item_type

    def resolve(self):
        return ConcreteArray(self.item_type.resolve())

class ConcreteArray(Concrete):
    json_type = "array"

    def __init__(self, item_type, /):
        self.item_type = item_type

    def length_range(self):
        return 0, sys.maxsize

    def typeat(self, _):
        return self.item_type

    def __repr__(self):
        return f"Array[{self.item_type}]"


class Tuple(Resolvable):
    def __init__(self, *item_types):
        self.item_types = tuple(item_types)

    def resolve(self):
        return ConcreteTuple(*(t.resolve() for t in self.item_types))


class ConcreteTuple(Concrete):
    json_type = "array"

    def __init__(self, *item_types):
        self.item_types = tuple(item_types)

    def length_range(self):
        l = len(self.item_types)
        return l, l

    def typeat(self, i):
        return self.item_types[i]

    def __repr__(self):
        return "Tuple[" + ", ".join(str(t) for t in self.item_types) + "]"


class Union(Resolvable):
    def __init__(self, *types):
        self.types = list(types)
        self.iterated = False
        self.resolved = False

    def add(self, type):
        assert not self.resolved, "illegal mutation: called .add() after .resolve()"
        assert not self.iterated, "illegal mutation: called .add() after iteration"
        self.types.append(type)
        return type

    def __iter__(self):
        self.iterated = True
        yield from self.types

    def resolve(self):
        self.resolved = True
        assert self.types, "no types in union!"
        alltypes = frozenset(t.resolve() for t in self.types)
        if len(alltypes) == 1:
            return next(iter(alltypes))
        return ConcreteUnion(alltypes)

class ConcreteUnion(Concrete):
    def __init__(self, types, /):
        assert isinstance(types, frozenset)
        self.types = types

    def __iter__(self):
        yield from self.types

    def __repr__(self):
        return "|".join(sorted(str(t) for t in self.types))


## Solution types ##

class Match:
    """Match means there is only one option remaining."""
    def __init__(self, typ):
        self.typ = typ

class CheckJsonType:
    """CheckJsonType means check the json type and proceed with solution = options[json_type]."""
    def __init__(self, options):
        self.options = options

class CheckLiteral:
    """CheckLiteral means you should check the value and proceed with solution = options[value]."""
    def __init__(self, options):
        self.options = options

class CheckLength:
    """
    CheckLength means you should take the length of the array and proceed with
    solution = options.get(length, default).
    """
    def __init__(self, options, default=None):
        self.options = options
        self.default = default

class GetIndex:
    """GetIndex means you should select the index from the array and feed that to the solution."""
    def __init__(self, i, solution):
        self.i = i
        self.solution = solution

class GetField:
    """GetField means you should select the field from the struct and feed that to the solution."""
    def __init__(self, key, solution):
        self.key = key
        self.solution = solution

class HasField:
    """
    HasField means you should check for each field in order, and pick the corresponding solution.
    """
    def __init__(self, solutions):
        # [(key: solution), ...]
        self.solutions = solutions


## solvers


def solve_union(types):
    # outer layer: check json type
    jtypes = {}
    for t in types:
        jtypes.setdefault(t.json_type, []).append(t)

    out = {}
    for jt, matches in jtypes.items():
        if len(matches) == 1:
            # only one option for this json type
            out[jt] = Match(matches[0])
        elif jt in ["string", "boolean", "integer"]:
            # union of multiple literals
            # TODO: where is the check between a Literal string and plain String?
            #       That case should be rejected as unsafe to distinguish.
            out[jt] = solve_union_literals(matches)
        elif jt == "object":
            # union of multiple structs
            out[jt] = solve_union_structs(matches)
        elif jt == "array":
            # union of tuples, or maybe of non-empty arrays
            out[jt] = solve_union_arrays(matches)
        else:
            # null can't have union types because there's only one
            # float can't have union types because equality checks are flaky
            raise ValueError("union not allowed between multiple types that encode as " + jt)

    # Keep the CheckJsonType layer, even if there's only one type, because many languages will need
    # a type check up front to avoid type errors when processing other checks.
    ## if len(out) == 1:
    ##     return next(iter(out.values()))

    return CheckJsonType(out)


def solve_union_literals(types):
    out = {}
    for t in types:
        if not isintance(t, Literal):
            raise ValueError(f"unable to solve union between {types}")
        out[t.value] = Match(t)
    return CheckLiteral(out)


def solve_union_structs(types):
    if len(types) == 1:
        return Match(types[0])

    # There could be a lot of ways to distinguish different structs, but for now I think we will
    # only solve oneof unions, where there is only one key, and discriminated unions, where each
    # struct has e.g. a .type field.  Discriminated unions also need to support a subdiscriminator,
    # since we expect most types to have a .v field that distinguishes different event schema
    # versions.  As exceptions arise, we can write a more advanced solver.

    # first check for oneof unions, where each member has a single key and they're all different.
    if all(len(t.fields) == len(t.always) == 1 for t in types):
        solutions = {}
        seen = set()
        order = []
        for t in types:
            field = next(iter(t.fields))
            if field not in seen:
                order.append(field)
                seen.add(field)
                solutions[field] = [t]
            else:
                solutions[field].append(t)
        return HasField([(f, solve_union_structs(solutions[f])) for f in order])

    # then look for keys with literals that can distinguish our different elements (a "type" key)
    # {key: (count, set(values))}
    litkeys = {}
    for t in types:
        for k, f in t.fields.items():
            if isinstance(f, Literal):
                count, values = litkeys.get(k) or (0, set())
                count += 1
                values.add(f.value)
                litkeys[k] = (count, values)

    if not litkeys:
        raise ValueError(f"union without discriminator: {' | '.join(str(t) for t in types)}")

    # we expect a discriminator to exist which is common to all structs
    keys_on_all_types = {k: vals for k, (count, vals) in litkeys.items() if count == len(types)}
    if not keys_on_all_types:
        raise ValueError(f"union has no discriminator common to all structs: {types}")

    # check for a key that uniquely identifies all types
    perfect_keys = [k for k, vals in keys_on_all_types.items() if len(vals) == len(types)]
    if len(perfect_keys) > 0:
        # sort "v" to the end; if another discriminator is present we should never need it
        perfect_keys.sort(key=lambda k: k == "v")
        # multiple discriminators may mean the solver has done something weird, except the special
        # case where one is .v, because that could just mean a new union was created using two
        # event types where the second one is on v=2.
        if len(perfect_keys) - (perfect_keys[-1] == "v") > 1:
            raise ValueError(f"warning: multiple discriminators ({perfect_keys}): {types}")
        k = perfect_keys[0]
        out = {}
        for t in types:
            out[t.fields[k].value] = Match(t)
        return GetField(k, CheckLiteral(out))

    # if there was only one option, it should have uniquely identified all types
    if len(keys_on_all_types) == 1:
        raise ValueError(
            f"union's only discriminator ({k}) does not uniquely identify all options: {types}"
        )

    # at this point, we'll assume the only valid case is a set of discriminators like [.type, .v],
    # which is probably unnecessarily strict, but we'll allow more cases when we have a reason to
    keys = sorted(keys_on_all_types, key=lambda k: k == "v")
    if len(keys) != 2 or keys[-1] != "v":
        raise NotImplementedError(f"unexpected discriminators: ({keys} != [*, v]): {types}")

    # build a map of discriminator value to subtypes
    k = keys[0]
    value_to_subtypes = {}
    for t in types:
        value_to_subtypes.setdefault(t.fields[k].value, []).append(t)

    # build a CheckLiteral with subsolvers per value
    out = {}
    for v, subtypes in value_to_subtypes.items():
        out[v] = solve_union_structs(subtypes)
    return GetField(k, CheckLiteral(out))


def solve_union_arrays(types):
    out = {}

    # first handle empties; if more than one type can be empty we'll be unable to distinguish them
    empties = [t for t in types if t.length_range()[0] == 0]
    if len(empties) > 1:
        raise ValueError("unable to union multiple possibly-empty arrays")
    if len(empties) == 1:
        t = empties[0]
        out[0] = Match(empties[0])
        if t.length_range()[1] == 0:
            # t was the empty tuple; we've fully detected it now
            types = [t for t in types if t is not empties[0]]

    # length check for all fixed-length types
    fixies = set(m for m, M in (t.length_range() for t in types) if m == M)
    for n in fixies:
        matches = [t for t, m, M in ((t, *t.length_range()) for t in types) if m <= n <= M]
        if len(matches) == 1:
            out[n] = Match(matches[0])
            # done with this type
            types = [t for t in types if t is not matches[0]]
            continue
        # we have n entries for m matches; we need a matrix of checks: "how to distinguish each item
        # in one match from the same item in the other matches"; then we can select the checks that
        # uniquely identify each match from the others, starting with most uniqifying checks.
        #
        # Well, start with the easy cases: try a union_solve on each index and hope one uniquely
        # identifies all matches.  This will probably almost always be the case.
        for i in range(n):
            subtypes = [t.typeat(i) for t in matches]
            if detect_union_overlap(subtypes):
                continue
            try:
                union = Union.of(subtypes)
                solution = solve_union(union)
            except ValueError:
                continue
            else:
                # found a solution!
                break
        else:
            # ok, I'm actually not going to write a more advanced solver until I know I have to
            raise NotImplementedError("Not implemented: multi-step tuple distinguisher")
        # map subtype matches to our original types and prune the resulting decision tree
        solution = remap_and_prune(solution, subtypes, matches)
        out[n] = GetIndex(i, solution)
        # any type which is an exact length match is now fully matched
        types = [t for t, m, n in ((t, *t.length_range()) for t in types) if not (m == M == n)]

    # we may have zero or one types to distinguish at this point
    if len(types) < 2:
        default = Match(types[0]) if types else None
        return CheckLength(out, default)

    # all tuples should be distinguished, we should be left with only arrays; they must be solvable
    # according to their first element (and we already uniquely identified any incoming empty array)
    subtypes = [t.typeat(0) for t in types]
    union = Union.of(subtypes)
    solution = solve_union(union)
    remap_and_prune(solution, subtypes, types)
    return CheckLength(out, solution)


## sovler helpers

def detect_union_overlap(subtypes):
    """
    Return true if any of the maybe-unions in subtypes have any overlap with any of the others.
    """
    alltypes = set()
    for st in subtypes:
        for t in st:
            if t in alltypes:
                return True
            alltypes.add(t)
    return False


def remap_and_prune(solution, subtypes, matches):
    """
    After using a solve_union() on e.g. the first field of a tuple type, we need to take the tree of
    the solution, remap leaves from subtypes to matches, and prune any branches that all lead to the
    same final match.

    subtypes is a list of mabye-unions (which are known to have no overlap) and matches is a list of
    concrete types.
    """
    remap = {}
    for st, m in zip(subtypes, matches):
        for t in st:
            remap[t] = m

    # returns a new (solution, possible)
    def visit(solution):
        if isinstance(solution, Match):
            typ = remap[solution.typ]
            return Match(typ), [typ]
        # CheckJsonType and CheckLiteral happen to have identical logic
        if isinstance(solution, (CheckJsonType, CheckLiteral)):
            possible = set()
            out = {}
            for key, subsln in solution.options.items():
                newsubsln, subposs = visit(subsln)
                out[key] = newsubsln
                possible.update(subposs)
            if len(possible) == 1:
                return Match(*possible), possible
            return type(solution)(out), possible
        if isinstance(solution, CheckLength):
            possible = set()
            out = {}
            for length, subsln in solution.options.items():
                newsubsln, subposs = visit(subsln)
                out[length] = newsubsln
                possible.update(subposs)
            default = None
            if solution.default is not None:
                default, subposs = visit(solution.default)
                possible.update(subposs)
            if len(possible) == 1:
                return Match(*possible), possible
            return CheckLength(out, default), possible
        if isinstance(solution, GetIndex):
            subsln, possible = visit(solution.solution)
            if len(possible) == 1:
                return Match(*possible), possible
            return GetIndex(solution.i, subsln), possible
        if isinstance(solution, GetField):
            subsln, possible = visit(solution.solution)
            if len(possible) == 1:
                return Match(*possible), possible
            return GetField(solution.key, subsln), possible
        raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    return visit(solution)[0]


def print_solution(solution, file=None, indent=0):
    want_indent=False

    def visit(solution, indent):
        def dump(s):
            nonlocal want_indent
            if not s:
                # empty string
                return
            lines = s.split("\n")
            # handle first line
            if not lines[0]:
                # empty first line
                print("", file=file, end="")
            else:
                if want_indent:
                    print(" "*indent, file=file, end="")
                print(lines[0], file=file, end="")
            want_indent = False
            if len(lines) == 1:
                return
            else:
                # newline from first line
                print("", file=file)
            # handle middle lines
            for line in lines[1:-1]:
                if not line:
                    # empty line
                    print("", file=file)
                else:
                    print(" "*indent + line, file=file)
            # handle last line
            if len(lines) > 1:
                if not lines[-1]:
                    # last line ended in '\n'
                    want_indent = True
                else:
                    # last line isn't done yet
                    print(" "*indent + lines[-1], file=file, end="")

        if isinstance(solution, Match):
            dump(f"{solution.typ}!\n")
        elif isinstance(solution, CheckJsonType):
            dump(f"\ncheck_json_type:\n")
            for jt, sln in solution.options.items():
                dump(f"  {jt}: ")
                visit(sln, indent + 4)
        elif isinstance(solution, CheckLiteral):
            dump(f"\ncheck_literal:\n")
            for val, sln in solution.options.items():
                dump(f"  {val}: ")
                visit(sln, indent + 4)
        elif isinstance(solution, CheckLength):
            dump(f"\ncheck_length:\n")
            for length, sln in solution.options.items():
                dump(f"  {length}: ")
                visit(sln, indent + 4)
            if soultion.default:
                dump(f" default: ")
                visit(soultion.default, indent + 4)
        elif isinstance(solution, GetIndex):
            dump(f"\nget_index({solution.i}):")
            visit(solution.solution, indent + 2)
        elif isinstance(solution, GetField):
            dump(f"\nget_field({solution.key}):")
            visit(solution.solution, indent + 2)
        else:
            raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    visit(solution, 0)

# Prototyping a Store
#
# We want to allow untyped json storage, and we want to use our protos to generate a type-safe
# storage interface in front of the underlying storage.
#
# We model storage as key templates and the types stored at those keys.  The full storage may be
# composed of multiple modules, so long as there is no key overlap.
#
# Example:
#
#     topicStore = Store({
#         # every commment object
#         "comment.{comment_uuid}": Comment,
#         # every topic object
#         "topic.{topic_uuid}": Topic,
#         # a per-topic index of all comment objects within that topic
#         "topic_comments.{topic_uuid}": []Uuid,
#     })
#     reportStore = Store({
#         # every row object
#         "row.{row_uuid}": Row,
#         # every report object
#         "report.{report_uuid}": Report,
#         # a per-report index of all rows within that report
#         "report_rows.{report_uuid}": []Uuid,
#     })
#     myStore = Store(topicStore, reportStore)

class StoreItem:
    """
    A StoreItem is just a single key-value pair of a Store spec, e.g.

        "comment.{comment_uuid}": Comment,
    """

    _pattern = re.compile("{([^}]*)}")
    def __init__(self, tpl, type, origin, name, chunks, params):
        self.tpl = tpl
        self.type = type
        self.origin = origin
        self.name = name
        # there is always one more chunk than params
        self.chunks = chunks
        self.params = params

    @classmethod
    def from_spec(cls, tpl, type, origin):
        name = tpl.split(".")[0]
        assert "{" not in name, f"store key template '{tpl}' does not have a name before a '.'"
        chunks, params = cls.parse_tpl(tpl)
        return cls(tpl, type, origin, name, chunks, params)

    @classmethod
    def parse_tpl(cls, tpl):
        chunks = []
        params = []
        i = 0
        for m in cls._pattern.finditer(tpl):
            chunks.append(tpl[i:m.start()])
            i = m.end()
            params.append(m.groups()[0])
        chunks.append(tpl[i:])
        return chunks, params

    def resolve(self):
        # resolve our self.type in-place
        self.type = self.type.resolve()


_all_stores = []


class Store:
    # Store is a named container for a list of StoreItem objects (the items).
    #
    # Store may be composed of multiple user-provided {template: Type} specs and/or other Stores.
    def __init__(self, *inputs):
        assert inputs, "Store() requires at least one spec"
        self.name = None
        _all_stores.append(self)

        # gather all dict inputs into a single spec
        self.spec = dict(
            sorted(item for inpt in inputs if isinstance(inpt, dict) for item in inpt.items())
        )

        # also keep all Store inputs as dependent types
        self.deps = tuple(inpt for inpt in inputs if isinstance(inpt, Store))

        # generate a list of StoreItems, sorted by name
        items = []

        # {name: (StoreItem, spec_idx)}
        names = {}

        def add_item(si, i):
            if si.name in names:
                match_si, match_i = names[si.name]
                raise ValueError(
                    f"unable to add store template '{si.tpl}' in spec[{i}], which collides with "
                    f"template '{match_si.si.tpl}' from spec[{match_i}]"
                )
                if key in seen:
                    match_i, match_tpl = seen[key]
                    raise ValueError(
                        f"unable to add store template '{si.tpl}' in spec[{i}], which overlaps with "
                        f"template '{match_tpl}' from spec[{match_i}]"
                    )
            items.append(si)
            names[si.name] = (si, i)

        for i, inpt in enumerate(inputs):
            if isinstance(inpt, dict):
                # create a new StoreItem from a bare {template: Type} spec
                for tpl, type in inpt.items():
                    si = StoreItem.from_spec(tpl, type, self)
                    add_item(si, i)
            if isinstance(inpt, Store):
                # include all StoreItems contained within another Store
                for si in inpt.items:
                    add_item(si, i)

        items.sort(key=lambda si: si.name)
        # don't let the items be mutable
        self.items = tuple(items)

    def resolve(self):
        # resolve the types in our spec and also our StoreItems
        for k in list(self.spec.keys()):
            self.spec[k] = self.spec[k].resolve()
        for si in self.items:
            # StoreItems resolve in-place.
            si.resolve()
        return self


_all_frameworks = []


class Framework:
    """
    Framework is simply a collection of types to define a concrete Framework type.
    """
    def __init__(self, event_type, command_type, store):
        _all_frameworks.append(self)
        self.name = None
        self.event_type = event_type
        self.command_type = command_type
        self.store = store

    def resolve(self):
        self.event_type = self.event_type.resolve()
        self.command_type = self.command_type.resolve()
        self.store = self.store.resolve()
        return self


class Denter:
    """A helper class for writing generators."""
    def __init__(self, indent=""):
        self._indents = []
        self.idnt = indent
        self.chunks = [""]

    def indent(self, idnt):
        self._indents.append(idnt)
        self.idnt = "".join(self._indents)

    def dedent(self):
        self._indents.pop(-1)
        self.idnt = "".join(self._indents)

    def print(self, s):
        lines = s.split("\n")
        for i, line in enumerate(lines):
            idnt = self.idnt if (line and self.chunks[-1].endswith("\n")) else ""
            end = "\n" if i + 1 < len(lines) else ""
            chunk = idnt + line + end
            if chunk: self.chunks.append(chunk)

    def getvalue(self):
        return "".join(self.chunks)

    def child(self):
        return Denter(self.idnt)

# use a function to avoid populating globals with variables from main function
def _main():
    import argparse
    import importlib
    import sys

    # first separate any args destined for the generator
    args = sys.argv[1:]
    generator_args = []
    try:
        idx = args.index("--")
        generator_args = args[idx+1:]
        args = args[:idx]
    except ValueError:
        generator_args = []

    # then do the normal arg parse
    parser = argparse.ArgumentParser()
    parser.add_argument("generator")
    parser.add_argument("definition", nargs="+")
    parser.add_argument(
        "-i", action="append", dest="includes", metavar="DIR", help="include DIR on sys.path"
    )
    parser.add_argument(
        "-r",
        action="append",
        dest="roots",
        metavar="TypeName",
        help="a root type to generate code for",
    )
    args = parser.parse_args(args)

    # make ourselves available as an already-imported "protos" module
    sys.modules["protos"] = sys.modules["__main__"]

    # update sys.path with -I
    if args.includes:
        sys.path = [*(os.path.abspath(i) for i in args.includes), *sys.path]

    # import all type definitions and their names
    name_to_obj = {}
    obj_to_name = {}
    for d in args.definition:
        m = importlib.import_module(d)
        # extract type names from python variable names
        for name, obj in vars(m).items():
            # ignore random variables laying around
            if not hasattr(obj, "resolve"): continue
            # skip aliases entirely
            # Note: it would be nice to preserve aliases in the generated code but that turns out to
            # be difficult alongside the "identical types resolve to a single object" rule.  It
            # would require a substnatial rewrite that I'm not presently interested in.
            if isinstance(obj, Alias):
                continue
            if isinstance(obj, (Resolvable, Concrete, Store, Framework)):
                obj = obj.resolve()
            elif issubclass(obj, Concrete):
                # handle simple Concrete subclasses
                try:
                    obj = obj.resolve()
                except TypeError:
                    continue
            else:
                continue
            # make sure there are no type with duplicate names, or duplicate names in different
            # modules pointing to different types
            fresh = True
            if name in name_to_obj:
                old, src = name_to_obj[name]
                if old == obj:
                    fresh = False
                else:
                    raise ValueError(
                        f"found name {name} = {obj} in module {d} which overlaps "
                        f"{name} = {old} from module {src}"
                    )
            if obj in obj_to_name:
                old, src = obj_to_name[obj]
                if old == name:
                    fresh = False
                else:
                    raise ValueError(
                        f"found name {name} = {obj} in module {d} which overlaps "
                        f"{old} = {obj} from module {src}"
                    )
            if fresh:
                name_to_obj[name] = (obj, d)
                obj_to_name[obj] = (name, d)
    # now go through and assign names
    roots_available = {}
    stores_available = {}
    frameworks_available = {}
    for name, (obj, _) in name_to_obj.items():
        if isinstance(obj, Concrete):
            # assign name to Concrete
            obj.name = name
            roots_available[name] = obj
        elif isinstance(obj, Store):
            obj.name = name
            stores_available[name] = obj
        elif isinstance(obj, Framework):
            obj.name = name
            frameworks_available[name] = obj
        else:
            raise ValueError(f"weird: {obj}")

    # assign anon names to unnamed structs
    # TODO: is this even useful?
    anon = 0
    for c in _all_concretes:
        if isinstance(c, ConcreteStruct) and c.name is None:
            c._anon = anon
            anon += 1

    # map -r options to concrete objects
    if args.roots:
        roots = []
        stores = []
        frameworks = []
        for r in args.roots:
            if r in roots_available:
                roots.append(roots_available[r])
            elif r in stores_available:
                stores.append(stores_available[r])
            elif r in stores_available:
                frameworks.append(frameworks_available[r])
            else:
                raise ValueError(
                    f'requested root "{r}" not found as either a type, store, or framework',
                )
    else:
        roots = [c for c in _all_concretes if c.name]
        stores = list(_all_stores)
        frameworks = list(_all_frameworks)

    # now import the generator
    generator_module = importlib.import_module(args.generator)
    if not hasattr(generator_module, "generate"):
        raise ValueError(
            "unable to locate generate() function in generator module ({args.generator})"
       )

    # call the generator
    d = Denter()
    generator_module.generate(d, _all_concretes, roots, stores, frameworks, generator_args)
    print(d.getvalue())


if __name__ == "__main__":
    _main()
