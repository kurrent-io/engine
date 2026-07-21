import os

from protos import *
import gen_ts


_anon = 0

def get_anon():
    global _anon
    _anon += 1
    return f"anon{_anon}"


def Pascal(s):
    # for now, just captialize first letter
    return s[:1].upper() + s[1:]

def camel(s):
    # for now, just uncaptialize first letter
    return s[:1].lower() + s[1:]


# map protos.py json type to a reflect type returned by Value.ExportType()
json_type_to_reflect_type = {
    "string": "reflectTypeString",
    "boolean": "reflectTypeBool",
    "int": "reflectTypeInt",
    "object": "reflectTypeMap",
    "array": "reflectTypeArray",
}

def convert_union(d, name, t, annos, converters):
    d.print(f"\nfunc To{name}(vm *goja.Runtime, value goja.Value) {name} {{\n")
    d.indent('\t')
    d.print(f"x := value\n")

    # first find out what declarations we need by walking the whole solution tree
    decls = set()
    def declare(code):
        if code in decls: return
        decls.add(code)
        d.print(code + "\n")

    def visit_decls(solution):
        if isinstance(solution, Match): pass
        elif isinstance(solution, CheckJsonType):
            for sln in solution.options.values():
                visit_decls(sln)
        elif isinstance(solution, CheckLiteral):
            for sln in solution.options.values():
                visit_decls(sln)
        elif isinstance(solution, CheckLength):
            declare("var fn func(this goja.Value, args ...Value) (goja.Value, error)")
            declare("var ok bool")
            declare("var length goja.Value")
            declare("var err error")
            for sln in solution.options.values():
                visit_decls(sln)
            if solution.default is not None:
                visit_decls(solution.default)
        elif isinstance(solution, GetIndex):
            visit_decls(solution.solution)
        elif isinstance(solution, GetField):
            visit_decls(solution.solution)
        elif isinstance(solution, HasField):
            declare("var obj *goja.Object")
            for _, sln in solution.solutions:
                visit_decls(sln)
        else:
            raise ValueError(f"unexpected solution {solution} of type: {type(solution).__name}")

    def visit(solution):
        if isinstance(solution, Match):
            d.print(f"out := {converters[solution.typ]('value')}\n")
            d.print(f"return out\n")
        elif isinstance(solution, CheckJsonType):
            d.print(f"switch x.ExportType() {{\n")
            for jtyp, sln in sorted(solution.options.items()):
                d.print(f"case {json_type_to_reflect_type[jtyp]}:\n")
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f"default:\n")
            d.indent("\t")
            d.print(f'panic(fmt.Sprintf("unexpected export type: %v", x.ExportType()))\n')
            d.dedent()
            d.print(f"}}\n")
        elif isinstance(solution, CheckLiteral):
            typeset = set(type(v) for v in solution.options)
            if typeset == {bool}:
                # only bool literals; use an if statement
                assert set(solution.options) == {True, False}, "non-exhaustive bool CheckLiteral"
                d.print(f'if x.Export().(bool) {{\n')
                d.indent('\t')
                visit(solution.options[True])
                d.dedent()
                d.print(f'}} else {{\n')
                d.indent('\t')
                visit(solution.options[False])
                d.dedent()
                d.print(f'}}\n')
            elif typeset == {str}:
                d.print(f'switch x.Export().(string) {{\n')
                for value, sln in sorted(solution.options.items()):
                    d.print(f'case "{value}":\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'panic(fmt.Sprintf("unexpected literal: %v", x))\n')
                d.dedent()
                d.print(f'}}\n')
            elif typeset == {int}:
                d.print(f'switch x.Export().(int64) {{\n')
                for value, sln in sorted(solution.options.items()):
                    d.print(f'case {value}:\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'panic(fmt.Sprintf("unexpected literal: %v", x))\n')
                d.dedent()
                d.print(f'}}\n')
            else:
                # mixed literals; use a universal switch statement (less efficient)
                d.print(f'switch true {{\n')
                for value, sln in sorted(solution.options.items()):
                    if isinstance(value, str):
                        govalue = f'"{value}"'
                    elif isinstance(value, bool):
                        govalue = str(value).lower()
                    elif isinstance(value, int):
                        govalue = f'"int64({value})"'
                    else:
                        raise ValueError(f"unexpected literal: {value} of type {type(value).__name__}")
                    d.print(f'case x.StrictEquals(vm.ToValue({govalue})):\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'panic(fmt.Sprintf("unexpected literal: %v", x))\n')
                d.dedent()
                d.print(f'}}\n')
        elif isinstance(solution, CheckLength):
            d.print(f'fn, ok = goja.AssertFunction(x.(*goja.Object).Get("length"))\n')
            d.print(f'if !ok {{\n')
            d.indent("\t")
            d.print(f'panic(fmt.Sprintf(".length is not a function of value %v", x))\n')
            d.dedent()
            d.print(f'}}\n')
            d.print(f'length, err = fn(x)\n')
            d.print(f'if err != nil {{\n')
            d.indent("\t")
            d.print(f'panic(fmt.Sprintf(".length() of %v failed: %v", x, err))\n')
            d.dedent()
            d.print(f'}}\n')
            d.print(f'switch length.Export().(int64) {{\n')
            for l, sln in sorted(solution.options.items()):
                d.print(f'case {l}:\n')
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f"default:\n")
            d.indent("\t")
            if solution.default is not None:
                visit(solution.default)
            else:
                d.print(f'panic(fmt.Sprintf("unexpected length: %v", length))\n')
            d.dedent()
            d.print(f'}}\n')
        elif isinstance(solution, GetIndex):
            d.print(f'x = x.(*goja.Object).Get("{solution.i}")\n')
            visit(solution.solution)
        elif isinstance(solution, GetField):
            d.print(f'x = x.(*goja.Object).Get("{solution.key}")\n')
            visit(solution.solution)
        elif isinstance(solution, HasField):
            d.print(f'obj = x.(*goja.Object)\n')
            d.print(f'switch true {{\n')
            for key, sln in solution.solutions:
                d.print(f'case obj.Get("{key}") != nil:\n')
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f"default:\n")
            d.indent("\t")
            d.print(f'panic(fmt.Sprintf("no matching fields: %v", x))\n')
            d.dedent()
            d.print(f'}}\n')
        else:
            raise ValueError(f"unexpected solution {solution} of type: {type(solution).__name}")

    solution = solve_union(t)
    visit_decls(solution)
    visit(solution)

    d.dedent()
    d.print(f"}}\n")
    return lambda var: f"To{name}(vm, {var})"


# Define go types (annos and converters) for all of our proto types.
#
# The general idea is to use the underlying goja.Value as storage with typed accessors, as library
# types are meant to be primarily accessed from JavaScript, and only really from Go in query
# functions, which run embedded in a javascript environment anyway.
#
# annos is a dict like {typename: typeanno}
# converters is a dict like {typename: lambda var: converter_expr}, it assumes `vm` also available
def generate_types(d, imports, annos, converters, t):
    def visit(t, path):
        # visit each type only once
        if t in annos: return
        # skip Null type; it should affect nullability, but not be used alone
        if isinstance(t, Null): return
        # handle type aliases for builtin types
        for (cls, goname) in [
            (String, "string"),
            (Int, "int64"),
            (Bool, "bool"),
            (Json, "goja.Value"),
        ]:
            if isinstance(t, cls):
                if type(t) is cls:
                    # an actual builtin
                    anno = goname
                else:
                    # a subclass of a builtin, like class Uuid(String)
                    assert t.name, "unsure why we wouldn't have a name right now"
                    d.print(f"\ntype {t.name} = {goname}\n")
                    anno = t.name
                if isinstance(t, Json):
                    converter = lambda var: var
                else:
                    converter = lambda var: f"{var}.Export().({anno})"
                annos[t] = anno
                converters[t] = converter
                return
        if isinstance(t, Date):
            imports["time"] = None
            annos[t] = "time.Time"
            d.print("\nfunc ToDate(value goja.Value) time.Time {\n")
            d.indent("\t")
            d.print('strtime := value.Export().(string)\n')
            d.print('out, err := time.Parse("2006-01-02T15:04:05Z", strtime)\n')
            d.print('if err != nil {\n')
            d.indent("\t")
            d.print('panic(fmt.Sprintf("invalid timestamp (%v): %v", strtime, err))\n')
            d.dedent()
            d.print('}\n')
            d.print('return out\n')
            d.dedent()
            d.print("}\n")
            converters[t] = lambda var: f"ToDate({var})"
            return
        # handle literals, which never need a type definition
        if isinstance(t, Literal):
            if isinstance(t.value, str):
                anno = f"string/*{t.value}*/"
            elif isinstance(t.value, bool):
                anno = f"bool/*{str(t.value).lower()}*/"
            elif isinstance(t.value, int):
                anno = f"int64/*{t.value}*/"
            else:
                raise ValueError(f"unhandled literal value: {t.value}")
            converter = lambda var: f"{var}.Export().({anno})"
        elif hasattr(t, "go_generate_type"):
            anno, converter = t.go_generate_type(d, imports, annos, converters, visit, path)
        elif isinstance(t, ConcreteArray):
            visit(t.item_type, path)
            anno = f"[]{annos[t.item_type]}"
            # create a converter
            name = Pascal(
                t.name or (t.item_type.name and f"sliceOf{t.item_type.name}") or get_anon()
            )
            d.print(f"\nfunc to{name}(vm *goja.Runtime, value goja.Value) {anno} {{\n")
            d.indent("\t")
            d.print("if value == nil || goja.IsUndefined(value) { return nil }\n")
            d.print(f"var out {anno}\n")
            d.print(f"vm.ForOf(value, func(i goja.Value) bool {{\n")
            d.indent("\t")
            d.print(f"item := {converters[t.item_type]('i')}\n")
            d.print(f"out = append(out, item)\n")
            d.print(f"return true\n")
            d.dedent()
            d.print(f"}})\n")
            d.print(f"return out\n")
            d.dedent()
            d.print(f"}}\n")
            converter = lambda var: f"to{name}(vm, {var})"
        elif isinstance(t, ConcreteObject):
            visit(t.value_type, path)
            anno = f"map[string]{annos[t.value_type]}"
            # create a converter
            name = Pascal(
                t.name or (t.value_type.name and f"recordOf{t.value_type.name}") or get_anon()
            )
            d.print(f"\nfunc to{name}(vm *goja.Runtime, value goja.Value) {anno} {{\n")
            d.indent("\t")
            d.print("if value == nil || goja.IsUndefined(value) { return nil }\n")
            d.print(f"obj := value.(*goja.Object)\n")
            d.print(f"out := {anno}{{}}\n")
            d.print(f"for _, key := range obj.Keys() {{\n")
            d.indent("\t")
            d.print(f"vin := obj.Get(key)\n")
            d.print(f"vout := {converters[t.value_type]('vin')}\n")
            d.print(f"out[key] = vout\n")
            d.dedent()
            d.print(f"}}\n")
            d.print(f"return out\n")
            d.dedent()
            d.print(f"}}\n")
            converter = lambda var: f"to{name}(vm, {var})"
        elif isinstance(t, ConcreteUnion):
            for i, ut in enumerate(t.types):
                visit(ut, path + str(i))
            # define the interface
            name = Pascal(t.name or path)
            d.print(f"\ntype {name} interface {{\n")
            d.indent("\t")
            d.print(f"json.Marshaler\n")
            d.print(f"json.Unmarshaler\n")
            d.print(f"Is{name}()\n")
            d.dedent()
            d.print(f"}}\n")
            # create a union converter, using the union solver
            converter = convert_union(d, name, t, annos, converters)
            # implement the interface for all member types
            d.print("\n")
            for ut in t.types:
                # interfaces are always nullable
                if ut is Null: continue
                # TODO: we should handle non-struct member types too, when we encounter them
                d.print(f"func (x {annos[ut]}) Is{name}() {{}}\n")
            anno = name
        elif isinstance(t, ConcreteStruct):
            for fn, ft in t.fields.items():
                visit(ft, path + Pascal(fn))
            name = Pascal(t.name or path)
            # define the type as a wrapper around goja.Object
            d.print(f"\ntype {name} goja.Object\n")
            # define the json.Marshaler and Unmarshaler interface
            d.print(f"\nfunc (x *{name}) MarshalJSON() ([]byte, error) {{\n")
            d.indent("\t")
            d.print(f"return (*goja.Object)(x).MarshalJSON()")
            d.dedent()
            d.print(f"}}\n")
            d.print(f"\nfunc (x *{name}) UnmarshalJSON(data []byte) error {{\n")
            d.indent("\t")
            d.print(f"return nil // this is as pointless as the goja unmarshaler is\n")
            d.dedent()
            d.print(f"}}\n")
            # define the converter
            d.print(f"\nfunc To{name}(vm *goja.Runtime, value goja.Value) *{name} {{\n")
            d.indent("\t")
            d.print(f"out := value.(*goja.Object)\n")
            d.print(f"return (*{name})(out)\n")
            d.dedent()
            d.print(f"}}\n")
            converter = lambda var: f"To{name}(vm, {var})"
            # define each field getter
            for fn, ft in t.fields.items():
                d.print(f"\nfunc (x *{name}) {Pascal(fn)}(vm *goja.Runtime) {annos[ft]} {{\n")
                d.indent("\t")
                d.print(f'value := (*goja.Object)(x).Get("{fn}")\n')
                d.print(f"out := {converters[ft]('value')}\n")
                d.print(f"return out\n")
                d.dedent()
                d.print(f"}}\n")
            anno = f'*{name}'
        elif isinstance(t, ConcreteTuple):
            # treat Tuple like Struct, except we'll defined index getters instead of field getters
            for i, it in enumerate(t.item_types):
                visit(it, path + str(i))
            name = Pascal(t.name or path)
            # like struct, define the type as a wrapper around goja.Object
            d.print(f"\ntype {name} goja.Object\n")
            # define the converter, same as struct
            d.print(f"\nfunc To{name}(vm *goja.Runtime, value goja.Value) *{name} {{\n")
            d.indent("\t")
            d.print(f"out := value.(*goja.Object)\n")
            d.print(f"return (*{name})(out)\n")
            d.dedent()
            d.print(f"}}\n")
            converter = lambda var: f"To{name}(vm, {var})"
            # define each indexed getter
            for i, it in enumerate(t.item_types):
                d.print(f"\nfunc (x *{name}) Item{i}(vm *goja.Runtime) {annos[it]} {{\n")
                d.indent("\t")
                d.print(f'value := (*goja.Object)(x).Get("{i}")\n')
                d.print(f"out := {converters[it]('value')}\n")
                d.print(f"return out\n")
                d.dedent()
                d.print(f"}}\n")
            anno = f"*{name}"
        else:
            raise ValueError(f"unhandled type in generate_types: {type(t).__name__}")

        annos[t] = anno
        converters[t] = converter

    visit(t, t.name or "")


def noop_checker(val):
    return ""

json_type_to_reflect_type = {
    "string": "reflectTypeString",
    "boolean": "reflectTypeBool",
    "int": "reflectTypeInt",
    "object": "reflectTypeMap",
    "array": "reflectTypeArray",
}

def check_solution(d, annos, checkers, solution):
    d.print("x := value\n")
    d.print("xpath := path\n")

    # first find out what declarations we need by walking the whole solution tree
    decls = set()
    def declare(code):
        if code in decls: return
        decls.add(code)
        d.print(code + "\n")

    def visit_decls(solution):
        if isinstance(solution, Match): pass
        elif isinstance(solution, CheckJsonType):
            for sln in solution.options.values():
                visit_decls(sln)
        elif isinstance(solution, CheckLiteral):
            typeset = set(type(v) for v in solution.options)
            if typeset == {bool}:
                declare('var ok bool')
                declare('var b bool')
            elif typeset == {str}:
                declare('var ok bool')
                declare('var s string')
            elif typeset == {int}:
                declare('var ok bool')
                declare('var n int64')
            for sln in solution.options.values():
                visit_decls(sln)
        elif isinstance(solution, CheckLength):
            declare("var obj *goja.Object")
            declare("var ok bool")
            declare("var fn func(this goja.Value, args ...Value) (goja.Value, error)")
            for sln in solution.options.values():
                visit_decls(sln)
            if solution.default is not None:
                visit_decls(solution.default)
        elif isinstance(solution, GetIndex):
            visit_decls(solution.solution)
        elif isinstance(solution, GetField):
            visit_decls(solution.solution)
        elif isinstance(solution, HasField):
            declare("var obj *goja.Object")
            declare("var ok bool")
            for _, sln in solution.solutions:
                visit_decls(sln)
        else:
            raise ValueError(f"unexpected solution {solution} of type: {type(solution).__name}")

    def visit(solution):
        if isinstance(solution, Match):
            d.print(checkers[solution.typ]("value", "path"))
            d.print('return errs\n')
        elif isinstance(solution, CheckJsonType):
            d.print(f"switch x.ExportType() {{\n")
            for jtyp, sln in sorted(solution.options.items()):
                d.print(f"case {json_type_to_reflect_type[jtyp]}:\n")
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f'default:\n')
            d.indent('\t')
            d.print(f'errs = append(errs, fmt.Errorf("unexpected export type: %v", x.ExportType()))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
        elif isinstance(solution, CheckLiteral):
            typeset = set(type(v) for v in solution.options)
            if typeset == {bool}:
                # only bool literals; use an if statement
                assert set(solution.options) == {True, False}, "non-exhaustive bool CheckLiteral"
                d.print(f'b, ok = x.Export().(bool)\n')
                d.print(f'if !ok {{\n')
                d.indent('\t')
                d.print(f'errs = append(errs, fmt.Errorf("%v: not a bool", xpath))\n')
                d.print(f'return errs\n')
                d.dedent()
                d.print(f'}} else if b {{\n')
                d.indent('\t')
                visit(solution.options[True])
                d.dedent()
                d.print(f'}} else {{\n')
                d.indent('\t')
                visit(solution.options[False])
                d.dedent()
                d.print(f'}}\n')
            elif typeset == {str}:
                d.print(f's, ok = x.Export().(string)\n')
                d.print(f'if !ok {{\n')
                d.indent('\t')
                d.print(f'errs = append(errs, fmt.Errorf("%v: not a string", xpath))\n')
                d.print(f'return errs\n')
                d.dedent()
                d.print(f'}}\n')
                d.print(f'switch s {{\n')
                for value, sln in sorted(solution.options.items()):
                    d.print(f'case "{value}":\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'errs = append(errs, fmt.Errorf("%v: unexpected literal", xpath))\n')
                d.print(f'return errs\n')
                d.dedent()
                d.print(f'}}\n')
            elif typeset == {int}:
                d.print(f'n, ok = x.Export().(int64)\n')
                d.print(f'if !ok {{\n')
                d.indent('\t')
                d.print(f'errs = append(errs, fmt.Errorf("%v: not an int", xpath))\n')
                d.print(f'return errs\n')
                d.dedent()
                d.print(f'}}\n')
                d.print(f'switch n {{\n')
                for value, sln in sorted(solution.options.items()):
                    d.print(f'case {value}:\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'errs = append(errs, fmt.Errorf("%v: unexpected literal", xpath))\n')
                d.print(f'return errs\n')
                d.dedent()
                d.print(f'}}\n')
            else:
                # mixed literals; use a universal switch statement (less efficient)
                d.print(f'switch true {{\n')
                for value, sln in sorted(solution.options.items()):
                    if isinstance(value, str):
                        govalue = f'"{value}"'
                    elif isinstance(value, bool):
                        govalue = str(value).lower()
                    elif isinstance(value, int):
                        govalue = f'"int64({value})"'
                    else:
                        raise ValueError(f"unexpected literal: {value} if type {type(value).__name__}")
                    d.print(f'case x.StrictEquals(vm.ToValue({govalue})):\n')
                    d.indent("\t")
                    visit(sln)
                    d.dedent()
                d.print(f"default:\n")
                d.indent("\t")
                d.print(f'panic(fmt.Sprintf("unexpected literal: %v", x))\n')
                d.dedent()
                d.print(f'}}\n')
        elif isinstance(solution, CheckLength):
            # make sure it's an array
            d.print(f'obj, ok := x.(*goja.Object)\n')
            d.print(f'if !ok {{\n')
            d.indent('\t')
            d.print(f'errs = append(errs, fmt.Errorf("%v: not an array", xpath))\n')
            d.print(f'return errs\n')
            d.dedent()
            # get its .length method
            d.print(f'}}\n')
            d.print(f'fn, ok = goja.AssertFunction(obj.Get("length"))\n')
            d.print(f'if !ok {{\n')
            d.indent("\t")
            d.print(f'errs = append(errs, fmt.Errorf("%v: no .length() method", xpath))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
            # call .length
            d.print(f'length, err = fn(x)\n')
            d.print(f'if err != nil {{\n')
            d.indent("\t")
            d.print(f'errs = append(errs, fmt.Errorf("%v: .length(): %w", xpath, err))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
            # do the check
            d.print(f'switch length.Export().(int64) {{\n')
            for l, sln in sorted(solution.options.items()):
                d.print(f'case {l}:\n')
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f"default:\n")
            d.indent("\t")
            if solution.default is not None:
                visit(solution.default)
            else:
                d.print(f'errs = append(errs, fmt.Errorf("%v: unexpected length", xpath))\n')
                d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
        elif isinstance(solution, GetIndex):
            # CheckLength should already protect us; no need to re-check
            d.print(f'x = x.(*goja.Object).Get("{solution.i}")\n')
            d.print(f'xpath += "[{solution.i}]"\n')
            visit(solution.solution)
        elif isinstance(solution, GetField):
            d.print(f'x = x.(*goja.Object).Get("{solution.key}")\n')
            d.print(f'xpath += ".{solution.key}"\n')
            d.print(f'if x == nil {{\n')
            d.indent('\t')
            d.print(f'errs = append(errs, fmt.Errorf("%v: missing discriminator \\"{solution.key}\\"", xpath))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
            visit(solution.solution)
        elif isinstance(solution, HasField):
            d.print(f'obj, ok = x.(*goja.Object)\n')
            d.print(f'if !ok {{\n')
            d.indent('\t')
            d.print(f'errs = append(errs, fmt.Errorf("%v: not an object", xpath))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
            d.print(f'switch true {{\n')
            for key, sln in solution.solutions:
                d.print(f'case obj.Get("{key}") != nil:\n')
                d.indent("\t")
                visit(sln)
                d.dedent()
            d.print(f"default:\n")
            d.indent("\t")
            d.print(f'errs = append(errs, fmt.Errorf("%v: no matching fields", xpath))\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
        else:
            raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    visit_decls(solution)
    visit(solution)


def generate_checkers(d, annos, checkers, t):
    """
    func CheckAddPatron(vm *goja.Runtime, value goja.Value, path string) error {
        var errs []error
        obj, ok := value.(*goja.Object)
        if !ok {
            errs = append(errs, fmt.Errorf("%v: not a json object", path))
            return errors.Join(errs...)
        }
        if field := obj.Get("id"); field != nil {
            errs = append(errs, checkUuid(field, path + ".id")...)
        } else {
            errs = append(errs, fmt.Errorf("%v: missing required field .id", path))
        }
        ...
        return errors.Join(errs...)
    }
    """
    def visit(t):
        if t in checkers: return

        if isinstance(t, Json):
            raise ValueError(f"XXX: {t}")
            return
        if isinstance(t, String):
            checkers[t] = lambda var, path: (
                f'if typ := {var}.ExportType(); typ != reflectTypeString {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: is of type %v, not string", {path}, typ))\n'
                f'}}\n'
            )
            return
        if isinstance(t, Int):
            checkers[t] = lambda var, path: (
                f'if typ := {var}.ExportType(); typ != reflectTypeInt {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: is of type %v, not int", {path}, typ))\n'
                f'}}\n'
            )
            return
        if isinstance(t, Bool):
            checkers[t] = lambda var, path: (
                f'if typ := {var}.ExportType(); typ != reflectTypeBool {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: is of type %v, not bool", {path}, typ))\n'
                f'}}\n'
            )
            return
        if isinstance(t, Null) or (isinstance(t, Literal) and t.value is None):
            checkers[t] = lambda var, path: (
                f'if typ := {var}.ExportType(); typ != reflectTypeNil {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: is of type %v, not bool", {path}, typ))\n'
                f'}}\n'
            )
            return
        if isinstance(t, Date):
            checkers[t] = lambda var, path: (
                f'if strtime, ok := {var}.Export().(string); !ok {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: not a string", {path}))\n'
                f'}} else if _, err := time.Parse("2006-01-02T15:04:05Z", strtime); err != nil {{\n'
                f'\terrs = append(errs, fmt.Errorf("%v: not a valid timestamp: %w", {path}, err))\n'
                f'}}\n'
            )
            return
        if isinstance(t, Literal):
            if isinstance(t.value, str):
                checkers[t] = lambda var, path: (
                    f'if lit, ok := {var}.Export().(string); !ok || lit != "{t.value}" {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is not \\"{t.value}\\"", {path}))\n'
                    f'}}\n'
                )
            elif isinstance(t.value, bool):
                goval = str(t.value).lower()
                checkers[t] = lambda var, path: (
                    f'if lit, ok := {var}.Export().(bool); !ok || lit != {goval} {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is not {goval}", {path}))\n'
                    f'}}\n'
                )
            elif isinstance(t.value, int):
                checkers[t] = lambda var, path: (
                    f'if lit, ok := {var}.Export().(int); !ok || lit != {t.value} {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is not {t.value}", {path}))\n'
                    f'}}\n'
                )
            else:
                raise ValueError(f"unhandled literal value: {t.value}")
            return

        if hasattr(t, "go_generate_checker"):
            # handle custom types
            checker = t.go_generate_checker(d, annos, checkers, visit)
        elif isinstance(t, ConcreteArray):
            visit(t.item_type)

            def checker(var, path):
                d = Denter()
                d.print(
                    f'if typ := {var}.ExportType(); typ != reflectTypeArray {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is a %v, not json array", {path}, typ))\n'
                )
                if checkers[t.item_type] != noop_checker:
                    d.print(f"}} else {{\n")
                    d.indent("\t")
                    d.print(f"i := 0\n")
                    d.print(f"err := vm.Try(func(){{vm.ForOf({var}, func(item goja.Value) bool {{\n")
                    d.indent("\t")
                    d.print(f'xpath := fmt.Sprintf("%s[%d]", {path}, i)\n')
                    d.print(f'i++\n')
                    d.print(checkers[t.item_type]("item", "xpath"))
                    d.print(f'return true\n')
                    d.dedent()
                    d.print(f"}})}})\n")
                    d.print(f'if err != nil {{\n')
                    d.print(f'\terrs = append(errs, fmt.Errorf("%v: ForOf: %w", {path}, err))\n')
                    d.print(f'}}\n')
                    d.dedent()
                d.print(f'}}\n')
                return d.getvalue()

        elif isinstance(t, ConcreteTuple):
            for it in t.item_types:
                visit(it)

            def checker(var, path):
                d = Denter()
                n = len(t.item_types)
                d.print(
                    f'if typ := {var}.ExportType(); typ != reflectTypeArray {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is a %v, not json array", {path}, typ))\n'
                )
                d.print(f'}} else {{\n')
                d.indent("\t")
                # a distinct name from the struct checker's `obj`, so an inlined tuple field
                # does not shadow it
                d.print(f'arr := {var}.(*goja.Object)\n')
                d.print(f'if length := arr.Get("length").ToInteger(); length != {n} {{\n')
                d.print(f'\terrs = append(errs, fmt.Errorf("%v: expected {n} items, not %v", {path}, length))\n')
                d.print(f'}} else {{\n')
                d.indent("\t")
                # Go block scoping gives each element a fresh item/xpath, so nested tuples and
                # arrays can't shadow each other's variables
                for i, it in enumerate(t.item_types):
                    d.print("{\n")
                    d.indent("\t")
                    d.print(f'item := arr.Get("{i}")\n')
                    d.print(f'xpath := {path} + "[{i}]"\n')
                    d.print(checkers[it]("item", "xpath"))
                    d.dedent()
                    d.print("}\n")
                d.dedent()
                d.print(f'}}\n')
                d.dedent()
                d.print(f'}}\n')
                return d.getvalue()

        elif isinstance(t, ConcreteObject):
            visit(t.value_type)

            def checker(var, path):
                d = Denter()
                d.print(
                    f'if typ := {var}.ExportType(); typ != reflectTypeMap {{\n'
                    f'\terrs = append(errs, fmt.Errorf("%v: is a %v, not json object", {path}, typ))\n'
                )
                if checkers[t.value_type] != noop_checker:
                    d.print(f'}} else {{\n')
                    d.indent('\t')
                    d.print(f'obj := {var}.(*goja.Object)\n')
                    d.print(f'for _, key := range obj.Keys() {{\n')
                    d.indent('\t')
                    d.print(f'val := obj.Get(key)\n')
                    d.print(f'xpath := {path} + "." + key\n')
                    d.print(checkers[t.value_type]("val", "xpath"))
                    d.dedent()
                    d.print(f'}}\n')
                    d.dedent()
                d.print(f'}}\n')
                return d.getvalue()
        elif isinstance(t, ConcreteUnion):
            for ut in t.types:
                visit(ut)
            solution = solve_union(t)
            if t.name:
                name = f"check{t.name}"
            else:
                name = f"check{get_anon()}"
            d.print(f"\nfunc {name}(vm *goja.Runtime, value goja.Value, path string) []error {{\n")
            d.indent("\t")
            d.print(f'var errs []error\n')
            check_solution(d, annos, checkers, solution)
            d.dedent()
            d.print(f"}}\n")
            checker = lambda var, path: f"errs = append(errs, {name}(vm, {var}, {path})...)\n"

        elif isinstance(t, ConcreteStruct):
            for ft in t.fields.values():
                visit(ft)

            if t.name:
                keys = f"_{t.name}_ALLOWED_KEYS"
                func = f"check{t.name}"
            else:
                anon = get_anon()
                keys = f"_{anon.upper()}_ALLOWED_KEYS"
                func = f"check{anon}"

            # write a singleton of allowed keys
            d.print(f'\nvar {keys} = map[string]bool{{\n')
            d.indent('\t')
            for fn in t.fields:
                d.print(f'"{fn}": true,\n')
            d.dedent()
            d.print(f'}}\n')

            # write a function
            d.print(f'\nfunc {func}(vm *goja.Runtime, value goja.Value, path string) []error {{\n')
            d.indent('\t')
            d.print(f'var errs []error\n')
            d.print(f'obj, ok := value.(*goja.Object)\n')
            d.print(f'if !ok {{\n')
            d.indent('\t')
            d.print(
                f'errs = append(errs,'
                f' fmt.Errorf("%v: is a %v, not a json object", path, value.ExportType())'
                f')\n'
            )
            d.print(f'return errs\n')
            d.dedent()
            d.print(f'}}\n')
            # check every field
            for fn, ft in t.fields.items():
                d.print(f'if field := obj.Get("{fn}"); field != nil {{\n')
                d.indent('\t')
                d.print(f'xpath := path + ".{fn}"\n')
                d.print(checkers[ft]("field", "xpath"))
                d.dedent()
                if fn in t.maybes:
                    d.print(f'}}\n')
                else:
                    d.print(f'}} else {{\n')
                    d.indent('\t')
                    d.print(
                        f'errs = append(errs, fmt.Errorf("%v: missing required field", path))\n'
                    )
                    d.dedent()
                    d.print(f'}}\n')
            # check for extra fields
            d.print(f'for _, key := range obj.Keys() {{\n')
            d.indent('\t')
            d.print(f'if {keys}[key] {{ continue }}\n')
            d.print(f'\n')
            d.print(f'errs = append(errs, fmt.Errorf("%v: contains extra keys", path))\n')
            d.dedent()
            d.print(f'}}\n')
            d.print(f'return errs\n')
            d.dedent()
            d.print(f"}}\n")

            checker = lambda var, path: f"errs = append(errs, {func}(vm, {var}, {path})...)\n"

        else:
            raise ValueError(f"unhandled type in generate_checkers: {t}")

        # named types get a wrapper function that calls errors.Join() on the list of errors
        if t.name:
            d.print(f'\nfunc Check{t.name}(vm *goja.Runtime, value goja.Value, path string) error {{\n')
            d.indent('\t')
            d.print(f'var errs []error\n')
            d.print(checker("value", "path"))
            d.print(f'return errors.Join(errs...)\n')
            d.dedent()
            d.print(f'}}\n')

        checkers[t] = checker

    visit(t)


def context_name(name):
    return Pascal(name[:-5] if name.endswith("Store") else name)


def generate_store(d, annos, converters, store):
    iface = context_name(store.name) + 'QueryContext'
    impl = camel(iface)

    # define the interface, so query contexts are decomposable
    d.print(f'\ntype {iface} interface {{\n')
    d.indent('\t')
    d.print(f'QueryContext\n')
    for dep in store.deps:
        d.print(f'{context_name(dep.name)}QueryContext\n')
    original_items = [si for si in store.items if si.origin == store]
    for si in sorted(original_items, key=lambda si: si.name):
        d.print(f'{Pascal(si.name)}(')
        if si.params:
            d.print(', '.join(p for p in si.params) + ' string')
        d.print(f') {annos[si.type]}\n')
    d.dedent()
    d.print(f'}}\n')

    # define the implementing type
    d.print(f'\ntype {impl} struct {{\n')
    d.indent('\t')
    d.print(f'vm  *goja.Runtime\n')
    d.print(f'ask Ask\n')
    d.dedent()
    d.print(f'}}\n')

    # define a New function
    d.print(f'\nfunc New{iface}(vm *goja.Runtime, ask Ask) {iface} {{\n')
    d.indent('\t')
    d.print(f'return &{impl}{{vm, ask}}\n')
    d.dedent()
    d.print(f'}}\n')

    # define each method
    d.print(f'\nfunc (qx *{impl}) Ask(question goja.Value) goja.Value {{\n')
    d.indent('\t')
    d.print(f'return qx.ask(question)\n')
    d.dedent()
    d.print(f'}}\n')

    for si in sorted(store.items, key=lambda si: si.name):
        d.print(f'\nfunc (qx *{impl}) {Pascal(si.name)}(')
        if si.params:
            d.print(', '.join(p for p in si.params) + ' string')
        d.print(f') {annos[si.type]} {{\n')
        d.indent('\t')
        d.print(f'vm := qx.vm\n')
        d.print(f'value := queryAsk(vm, qx.ask, "{"%s".join(si.chunks)}"')
        for param in si.params:
            d.print(f', {param}')
        d.print(')\n')
        d.print(f'out := {converters[si.type]("value")}\n')
        d.print(f'return out\n')
        d.dedent()
        d.print(f'}}\n')


def framework_name(name):
    return Pascal(name if name.endswith("Framework") else (name + 'Framework'))


def generate_framework(d, annos, f):
    """
    type MyFramework = Framework[MyQX, MyE, MyC]

    func NewMyFramework(
        source Source,
        storage Storage,
        migrate string,
        reducer string,
    ) (*MyFramework, error) {
        return NewFramework[MyQX, MyE, MyC](
            source,
            "MyFramework",
            storage,
            migrate,
            reducer,
            NewMyQX,
        )
    """
    name = framework_name(f.name)
    QX = context_name(f.store.name) + 'QueryContext'
    E = annos[f.event_type]
    C = annos[f.command_type]

    d.print(f'\ntype {name} = Framework[{QX}, {E}, {C}]\n')
    d.print(f'\nfunc New{name}(\n')
    d.indent('\t')
    d.print(f'script string,\n')
    d.print(f'storage Storage,\n')
    d.print(f'migrate string,\n')
    d.print(f'reducer string,\n')
    d.dedent()
    d.print(f') (*{name}, error) {{\n')
    d.indent('\t')
    d.print(f'return NewFramework[{QX}, {E}, {C}](\n')
    d.indent('\t')
    d.print(f'NewStringSource("bundle.js", script),\n')
    d.print(f'"{name}",\n')
    d.print(f'storage,\n')
    d.print(f'migrate,\n')
    d.print(f'reducer,\n')
    d.print(f'New{QX},\n')
    d.dedent()
    d.print(f')\n')
    d.dedent()
    d.print(f'}}\n')


# entrypoint for protos.py
def generate(d, concretes, roots, stores, frameworks, args):
    assert roots, "must supply roots with -r"
    assert len(args) == 1, "must supply package name as arg"

    # we collect imports as we go, accumulating code in a sub-Denter
    imports = {
        "crypto/rand": None,
        "encoding/json": None,
        "errors": None,
        "fmt": None,
        "iter": None,
        "os": None,
        "reflect": None,
        "slices": None,
        "strconv": None,
        "strings": None,
        "unsafe": None,
        "github.com/dop251/goja": None,
        "github.com/romshark/jscan": None,
    }
    sub = Denter()

    types_to_visit = (
        [r for r in roots]
        + [si.type for s in stores for si in s.items]
        + [si.type for f in frameworks for si in f.store.items]
    )

    # Define types, both their annotations and goja.Value converters.
    annos = {}
    converters = {}
    for t in types_to_visit:
        generate_types(sub, imports, annos, converters, t)

    # Generate json checkers, for receiving incoming json.
    # checkers shall contain snippets of code that append errors to an `errs` variable
    checkers = {}
    for t in types_to_visit:
        generate_checkers(sub, annos, checkers, t)

    # generate query contexts from stores
    for s in stores:
        generate_store(sub, annos, converters, s)

    # generate frameworks
    for f in frameworks:
        generate_framework(sub, annos, f)

    d.print(f"// Code generated by gen_go.py. DO NOT EDIT.\n")
    d.print(f"\n")
    d.print(f"package {args[0]}\n")
    d.print("\nimport (\n")
    d.indent("\t")
    # stdlib imports
    for imprt, name in sorted((i, n) for i, n in imports.items() if not "." in i):
        if name is None:
            d.print(f'"{imprt}"\n')
        else:
            d.print(f'{name} "{imprt}"\n')
    d.print("\n")
    # 3rd party imports
    for imprt, name in sorted((i, n) for i, n in imports.items() if "." in i):
        if name is None:
            d.print(f'"{imprt}"\n')
        else:
            d.print(f'{name} "{imprt}"\n')
    d.dedent()
    d.print(")\n")
    d.print("var (\n")
    d.indent("\t")
    d.print('reflectTypeInt      = reflect.TypeOf(int64(0))\n')
    d.print('reflectTypeBool     = reflect.TypeOf(false)\n')
    d.print('reflectTypeMap      = reflect.TypeOf(map[string]interface{}{})\n')
    d.print('reflectTypeArray    = reflect.TypeOf([]interface{}{})\n')
    d.print('reflectTypeString   = reflect.TypeOf("")\n')
    d.print('reflectTypeNil      = reflect.TypeOf(nil)\n')
    d.print('reflectTypeFloat    = reflect.TypeOf(float64(0))\n')
    d.print('\n')
    d.print('// return types we do not expect to appear in a valid protos-based type:\n')
    d.print('// reflectTypeArrayPtr = reflect.TypeOf((*[]interface{})(nil))\n')
    d.print('// reflectTypeFunc     = reflect.TypeOf((func(FunctionCall) Value)(nil))\n')
    d.print('// reflectTypeCtor     = reflect.TypeOf((func(ConstructorCall) *Object)(nil))\n')
    d.print('// reflectTypeError    = reflect.TypeOf((*error)(nil)).Elem()\n')
    d.dedent()
    d.print(")\n")
    d.print("\n")

    # include skeleton code
    with open(os.path.join(os.path.dirname(__file__), "skeleton.go"), "r") as f:
        d.print(f.read())

    # include generated code
    d.print(sub.getvalue())
