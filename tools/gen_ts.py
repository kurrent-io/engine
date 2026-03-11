from protos import *


def generate_annotations(d, annos, t):
    def visit(t):
        # visit each type only once
        if t in annos: return
        # handle type aliases for builtin types
        for (cls, jsname) in [
            (String, "string"),
            (Int, "number"),
            (Bool, "boolean"),
            (Json, "unknown"),
            (Null, "null"),
        ]:
            if isinstance(t, cls):
                if type(t) is cls:
                    # an actual builtin
                    annos[t] = jsname
                else:
                    # a subclass of a builtin, like class Uuid(String)
                    assert t.name, "unsure why we wouldn't have a name right now"
                    d.print(f"\nexport type {t.name} = {jsname};\n")
                    annos[t] = t.name
                return
        # handle literals, which never need a type definition
        if isinstance(t, Literal):
            if t.value is None:
                annos[t] = "null"
            elif isinstance(t.value, str):
                annos[t] = f'"{t.value}"'
            elif isinstance(t.value, bool):
                annos[t] = "true" if t.value else "false"
            elif isinstance(t.value, int):
                annos[t] = str(t.value)
            else:
                raise ValueError(f"unhandled literal value: {t.value}")
            return
        if hasattr(t, "ts_generate_annotation"):
            anno = t.ts_generate_annotation(d, annos, visit)
        elif isinstance(t, ConcreteArray):
            visit(t.item_type)
            anno = annos[t.item_type] + "[]"
        elif isinstance(t, ConcreteTuple):
            for it in t.item_types:
                visit(it)
            anno = "[" + ", ".join(annos[it] for it in t.item_types) + "]"
        elif isinstance(t, ConcreteUnion):
            for ut in t.types:
                visit(ut)
            anno = " | ".join(annos[ut] for ut in t.types)
        elif isinstance(t, ConcreteStruct):
            for ft in t.fields.values():
                visit(ft)
            def mkfield(k, v):
                return k + ("?" if k in t.maybes else "") + ": " + annos[v]
            anno = "{" + ", ".join(mkfield(k, v) for k, v in t.fields.items()) + "}"
        elif isinstance(t, ConcreteObject):
            visit(t.value_type)
            anno = "Record<string, " + annos[t.value_type] + ">"
        else:
            raise ValueError(f"unhandled type in generate_annotations: {type(t).__name__}")

        if t.name:
            d.print(f"\nexport type {t.name} = {anno};\n")
            annos[t] = t.name
        else:
            annos[t] = anno

    visit(t)


def identity_decoder(val):
    return val

_anon = 0

def decode_solution(d, annos, decoders, solution):
    # TODO: this could potentially save some pointless code, but it isn't correct
    #       as-written, and it seems like a rather unimportant optimization...
    # first: prune any branches that lead to identity decoders, by reappropriating remap_and_prune
    sentinel = object()
    # remap = ((t, sentinel if d is identity_decoder else t) for t, d in decoders.items())
    # solution = remap_and_prune(solution, *zip(*remap))

    d.print("let x = val;\n")

    # now we can generate the whole solution without any backtracking
    def visit(solution):
        if isinstance(solution, Match):
            if solution.typ is sentinel:
                d.print("return val;\n")
            else:
                d.print("return " + decoders[solution.typ]("val") + ";\n")
        elif isinstance(solution, CheckJsonType):
            if len(solution.options) == 1:
                return visit(next(iter(solution.options.values())))
            d.print("switch(typeof(x)){\n")
            d.indent("  ")
            for jtyp, subsln in solution.options.items():
                d.print(f'case "{jtyp}":\n');
                d.indent("  ")
                visit(subsln)
                d.dedent()
            d.dedent()
            d.print("}\n")
        elif isinstance(solution, CheckLiteral):
            if len(solution.options) == 1:
                return visit(next(iter(solution.options.values())))
            d.print("switch(x){\n")
            d.indent("  ")
            for lit, subsln in solution.options.items():
                if isinstance(lit, str):
                    d.print(f'case "{lit}":\n');
                else:
                    d.print(f"case {lit}:\n");
                d.indent("  ")
                visit(subsln)
                d.dedent()
            d.print("default: throw new Error(`unexpected value: ${val}`);\n")
            d.dedent()
            d.print("}\n")
        elif isinstance(solution, CheckLength):
            if len(solution.options) == 1:
                return visit(next(iter(solution.options.values())))
            d.print("switch(x.length){\n")
            d.indent("  ")
            for length, subsln in solution.options.items():
                d.print(f"case {length}:\n");
                d.indent("  ")
                visit(subsln)
                d.dedent()
            # default
            d.print(f"default:\n");
            d.indent("  ")
            visit(solution.default)
            d.dedent()
            d.dedent()
            d.print("}\n")
        elif isinstance(solution, GetIndex):
            d.print(f"x = x[{solution.i}];\n")
            visit(solution.solution)
        elif isinstance(solution, GetField):
            d.print(f"x = x.{solution.key};\n")
            visit(solution.solution)
        else:
            raise ValueError(f"unrecognized solution type: {type(solution).__name__}")

    visit(solution)


def generate_decoders(d, annos, decoders, t):
    def visit(t):
        global _anon
        if t in decoders: return

        if isinstance(t, (String, Int, Bool, Null, Literal, Json)):
            decoders[t] = identity_decoder
            # bulitin types and their aliases need no Decode{t.name}() function
            return

        if hasattr(t, "ts_generate_decoder"):
            # handle custom types
            decoder = t.ts_generate_decoder(d, annos, decoders, visit)
        elif isinstance(t, ConcreteUnion):
            for ut in t.types:
                visit(ut)
            if all(decoders[ut] == identity_decoder for ut in t.types):
                decoder = identity_decoder
            else:
                # non-identity union; this requires a union solution
                solution = solve_union(t)
                name = t.name
                if not t.name:
                    anon = _anon
                    _anon += 1
                    name = f"Anon{anon}"
                d.print(f"\nfunction decode{name}(val: any): {annos[t]} {{\n")
                d.indent("  ")
                decode_solution(d, annos, decoders, solution)
                d.dedent()
                d.print(f"}}\n")
                decoder = lambda val: f"decode{name}({val})"

        elif isinstance(t, ConcreteArray):
            visit(t.item_type)
            # calculate the decoding expression
            if decoders[t.item_type] == identity_decoder:
                decoder = identity_decoder
            else:
                decode_item_x = decoders[t.item_type]("x")
                decoder = lambda val: f"{val}.map((x) => {decode_item_x})"

        elif isinstance(t, ConcreteTuple):
            for it in t.item_types:
                visit(it)
            if all(decoders[it] == identity_decoder for it in t.item_types):
                decoder = identity_decoder
            else:
                decoder = lambda val: "[" + ", ".join(
                    decoders[it](f"{val}[{i}]") for i, it in enumerate(t.item_types)
                ) + "]"

        elif isinstance(t, ConcreteStruct):
            for ft in t.fields.values():
                visit(ft)
            if all(decoders[ft] == identity_decoder for ft in t.fields.values()):
                # all decoders are identity; identity decoder works for the whole struct
                decoder = identity_decoder
            elif all(decoders[ft] == identity_decoder for ft in t.maybes.values()):
                # all maybe decoders are identity; can be inlined with spread operator
                decoder = lambda val: "{ " + ", ".join([
                    f"...{val}",
                    *(
                        fn + ": " + decoders[ft](f"{val}.{fn}")
                        for fn, ft in t.always.items()
                        if decoders[ft] != identity_decoder
                    )
                ]) + " }"
            else:
                # non-identity maybes are present; inlining not possible
                anon = _anon
                _anon += 1
                d.print(f"\nfunction decodeAnon{anon}(val: any): {annos[t]} {{\n")
                d.indent("  ")
                d.print("const out = { ...val };\n")
                for fn, ft in t.fields.items():
                    if decoders[ft] == identity_decoder:
                        continue
                    decoded_field = decoders[ft](f"val.{fn}")
                    if fn in t.maybes:
                        d.print(f"if(val.{fn}) out.{fn} = {decoded_field};\n")
                    else:
                        d.print(f"out.{fn} = {decoded_field};\n")
                d.print(f"return out as {annos[t]};\n")
                d.dedent()
                d.print(f"}}\n")
                decoder = lambda val: f"decodeAnon{anon}({val})"

        elif isinstance(t, ConcreteObject):
            visit(t.value_type)
            if decoders[t.value_type] == identity_decoder:
                decoder = identity_decoder
            else:
                # non-identity values; inlining not possible
                anon = _anon
                _anon += 1
                d.print(f"\nfunction decodeAnon{anon}(val) {{\n")
                d.indent("  ")
                d.print("return Object.fromEntries(Object.entries(val).map(")
                d.print(f'([k, v]) => [k, {decoders[t.value_type]("v")}]')
                d.print(");")
                d.dedent()
                d.print(f"}}\n")
                decoder = lambda val: f"decodeAnon{anon}({val})"

        else:
            raise ValueError(f"unhandled type in generate_decoders: {t}")

        # either define a named decoder or inline it
        if t.name:
            # we always export a named decoder...
            decode_val = decoder("val")
            d.print(f"\nexport function Decode{t.name}(val: any): {annos[t]} {{\n")
            d.print(f"  return {decode_val} as {annos[t]};\n")
            d.print("}\n")
            # ... but if the decoder is the identity_decoder, we don't use it ourselves
            if decoder == identity_decoder:
                decoders[t] = decoder
            else:
                decoders[t] = lambda val: f"Decode{t.name}({val})"
        else:
            decoders[t] = decoder

    visit(t)


def generate_store_prereqs(d):
    d.print("\n")
    d.print("function *queryGet<T>(key: string): QueryGenerator<T> {\n")
    d.print("  const ans = yield {'store': {[key]: true}};\n")
    d.print("  const sv = ans.store[key];\n")
    d.print("  if ('err' in sv) throw sv.err;\n");
    d.print("  return sv.value as T\n")
    d.print("};\n")
    d.print("\n")
    d.print("function *projectorOld<T>(key: string): ProjectorGenerator<T> {\n")
    d.print("  const ans = yield {'old': {[key]: true}};\n")
    d.print("  const sv = ans.old[key];\n")
    d.print("  if ('err' in sv) throw sv.err;\n");
    d.print("  return sv.value as T\n")
    d.print("};\n")
    d.print("\n")
    d.print("function *projectorGet<T>(key: string): ProjectorGenerator<T> {\n")
    d.print("  const ans = yield {'get': {[key]: true}};\n")
    d.print("  const sv = ans.get[key];\n")
    d.print("  if ('err' in sv) throw sv.err;\n");
    d.print("  return sv.value as T\n")
    d.print("};\n")
    d.print("\n")
    d.print("function *projectorSet<T>(key: string, value: T): ProjectorGenerator<void> {\n")
    d.print("  const ans = yield {'set': {[key]: value}};\n")
    d.print("  const sv = ans.set[key];\n")
    d.print("  if ('err' in sv) throw sv.err;\n");
    d.print("};\n")
    d.print("function *projectorDel(key: string): ProjectorGenerator<void> {\n")
    d.print("  const ans = yield {'del': {[key]: true}};\n")
    d.print("  const sv = ans.del[key];\n")
    d.print("  if ('err' in sv) throw sv.err;\n");
    d.print("};\n")


def context_name(name):
    return name[:-5] if name.endswith("Store") else name


def generate_store(d, annos, store):
    # Generate the QueryContext singleton.
    d.print(f"\nexport const {context_name(store.name)}QueryContext = {{\n")
    d.indent("  ")
    # generate getters like:
    # topic: (topic_uuid: Uuid) => queryGet<Topic>(`topic.${topic_uuid}`)
    d.print("get: {\n")
    d.indent("  ")
    original_items = [si for si in store.items if si.origin == store]
    for si in original_items:
        d.print(f"{si.name}: (")
        d.print(", ".join(p + ": string" for p in si.params))
        d.print(f") => queryGet<{annos[si.type]}>(`")
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "${" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"`),\n")
    # also use the spread operator to reuse definitions from our deps
    for dep in store.deps:
        d.print(f"...{context_name(dep.name)}QueryContext.get,\n")
    d.dedent()
    d.print("},\n")
    d.dedent()
    d.print(f"}};\n")
    d.print("\n")

    # Generate the ProjectorContext singleton.
    d.print(f"export const {context_name(store.name)}ProjectorContext = {{\n")
    d.indent("  ")

    # generate old getters like:
    # topic: (topic_uuid: Uuid) => projectorGetter<Topic>(`topic.${topic_uuid}`)
    d.print("old: {\n")
    d.indent("  ")
    for si in original_items:
        d.print(f"{si.name}: (")
        d.print(", ".join(p + ": string" for p in si.params))
        d.print(f") => projectorOld<{annos[si.type]}>(`")
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "${" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"`),\n")
    # also use the spread operator to reuse definitions from our deps
    for dep in store.deps:
        d.print(f"...{context_name(dep.name)}ProjectorContext.old,\n")
    d.dedent()
    d.print("},\n")

    # generate getters like:
    # topic: (topic_uuid: Uuid) => projectorGetter<Topic>(`topic.${topic_uuid}`)
    d.print("get: {\n")
    d.indent("  ")
    for si in original_items:
        d.print(f"{si.name}: (")
        d.print(", ".join(p + ": string" for p in si.params))
        d.print(f") => projectorGet<{annos[si.type]}>(`")
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "${" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"`),\n")
    # also use the spread operator to reuse definitions from our deps
    for dep in store.deps:
        d.print(f"...{context_name(dep.name)}ProjectorContext.get,\n")
    d.dedent()
    d.print("},\n")

    # generate setters like:
    # topic: (topic_uuid: Uuid, value: Topic) => projectorSetter(`topic.${topic_uuid}`, value)
    d.print("set: {\n")
    d.indent("  ")
    for si in original_items:
        d.print(f"{si.name}: (")
        d.print(", ".join(
            [*(p + f": string" for p in si.params), f"value: {annos[si.type]}"]
        ))
        d.print(") => projectorSet(`")
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "${" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"`, value),\n")
    # also use the spread operator to reuse definitions from our deps
    for dep in store.deps:
        d.print(f"...{context_name(dep.name)}ProjectorContext.set,\n")
    d.dedent()
    d.print("},\n")

    # generate deleters like:
    # topic: (topic_uuid: Uuid) => projectorDeleter(`topic.${topic_uuid}`)
    d.print("del: {\n")
    d.indent("  ")
    for si in original_items:
        # no point in adding deleters for indices (when there isn't a param)
        if not si.params: continue
        d.print(f"{si.name}: (")
        d.print(", ".join(p + f": string" for p in si.params))
        d.print(") => projectorDel(`")
        for chunk, param in zip(si.chunks[:-1], si.params):
            d.print(chunk + "${" + param + "}")
        d.print(si.chunks[-1])
        d.print(f"`),\n")
    # also use the spread operator to reuse definitions from our deps
    for dep in store.deps:
        d.print(f"...{context_name(dep.name)}ProjectorContext.del,\n")
    d.dedent()
    d.print("},\n")

    d.dedent()
    d.print(f"}};\n")

def generate_framework(d, annos, f):
    event_type = annos[f.event_type]
    command_type = annos[f.command_type]
    px = f"{context_name(f.store.name)}ProjectorContext"
    qx = f"{context_name(f.store.name)}QueryContext"
    px_type = "typeof " + px
    qx_type = "typeof " + qx

    d.print(f"""
export class {f.name}<P> extends Framework<{qx_type}, {px_type}, {event_type}, {command_type}, P> {{
  constructor(
    storage: Storage,
    callbacks: {{
      // required: new events from the wire may be batched, and a checkpoint is produced
      shaper: (events: {event_type}[]) => {{events: {event_type}[], checkpoint: P}},
      // required: project a batch of events into the read model
      projector: (px: {px_type}, events: {event_type}[]) => ProjectorGenerator<void>,
      // optional: forecast the events a server will send for a command
      forecaster?: (commands: {command_type}[]) => {event_type}[],
      // required if using forecaster: create a unique forecast key for an event; used to create a
      // map of forecast events and to invalidate the forecasted event when the real event arrives
      forecastKey?: (event: {event_type}) => string,
      // required if using sendCommands: receive events to send on the wire and a callback to signal
      // when that succeeded
      onCommands?: (commands: {command_type}[], onSent: ()=> void)=> void,
    }},
  ) {{
    super({qx}, {px}, storage, callbacks);
  }}
}}
""")


# entrypoint for protos.py
def generate(d, concretes, roots, stores, frameworks, args):
    assert roots, "must supply roots with -r"

    # Start with the skeleton
    with open(os.path.join(os.path.dirname(__file__), "skeleton.ts"), "r") as f:
        d.print(f.read())

    types_to_visit = (
        [r for r in roots]
        + [si.type for s in stores for si in s.items]
        + [si.type for f in frameworks for si in f.store.items]
    )

    # Define types and decide on type annotations.
    annos = {}
    for t in types_to_visit:
        generate_annotations(d, annos, t)

    # Generate decoders and pick decoding expressions.
    decoders = {}
    for t in types_to_visit:
        generate_decoders(d, annos, decoders, t)

    # Generate stores
    if stores:
        generate_store_prereqs(d)
    for s in stores:
        generate_store(d, annos, s)

    # Generate frameworks
    for f in frameworks:
        generate_framework(d, annos, f)
