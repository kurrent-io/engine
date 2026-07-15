/**
 * TypeScript code generator: emits type aliases, decoders, typed store contexts, and Framework
 * classes from the lowered IR.
 */

import {
  KArray,
  KBool,
  KDate,
  KInt,
  KJson,
  KLiteral,
  KNull,
  KObject,
  KString,
  KStruct,
  KTuple,
  KType,
  KUnion,
  CheckJsonType,
  CheckLength,
  CheckLiteral,
  Denter,
  KFramework,
  GetField,
  GetIndex,
  HasField,
  LoweredProgram,
  Match,
  Solution,
  KStore,
  KTypeRegistry,
  solveUnion,
} from "@kurrent/typespec-engine";

type Annos = Map<KType, string>;
/** a decoder maps a value expression to a decoding expression; null is the identity decoder */
type Decoder = ((val: string) => string) | null;
type Decoders = Map<KType, Decoder>;

function generateAnnotations(d: Denter, annos: Annos, t: KType): void {
  const visit = (t: KType): void => {
    // visit each type only once
    if (annos.has(t)) return;
    // handle builtin types
    const builtin =
      t instanceof KDate ? "Date"
      : t instanceof KString ? "string"
      : t instanceof KInt ? "number"
      : t instanceof KBool ? "boolean"
      : t instanceof KJson ? "unknown"
      : t instanceof KNull ? "null"
      : null;
    if (builtin !== null) {
      annos.set(t, builtin);
      return;
    }
    // handle literals, which never need a type definition
    if (t instanceof KLiteral) {
      if (typeof t.value === "string") annos.set(t, `"${t.value}"`);
      else if (typeof t.value === "boolean") annos.set(t, t.value ? "true" : "false");
      else annos.set(t, String(t.value));
      return;
    }
    let anno: string;
    if (t instanceof KArray) {
      visit(t.itemType);
      anno = annos.get(t.itemType)! + "[]";
    } else if (t instanceof KTuple) {
      for (const it of t.itemTypes) visit(it);
      anno = "[" + t.itemTypes.map((it) => annos.get(it)!).join(", ") + "]";
    } else if (t instanceof KUnion) {
      for (const ut of t.types) visit(ut);
      anno = t.types.map((ut) => annos.get(ut)!).join(" | ");
    } else if (t instanceof KStruct) {
      for (const ft of t.fields.values()) visit(ft);
      const mkfield = (k: string, v: KType) =>
        k + (t.maybes.has(k) ? "?" : "") + ": " + annos.get(v)!;
      anno = "{" + [...t.fields].map(([k, v]) => mkfield(k, v)).join(", ") + "}";
    } else if (t instanceof KObject) {
      visit(t.valueType);
      anno = "Record<string, " + annos.get(t.valueType)! + ">";
    } else {
      throw new Error(`unhandled type in generateAnnotations: ${t.constructor.name}`);
    }

    if (t.name) {
      d.print(`\nexport type ${t.name} = ${anno};\n`);
      annos.set(t, t.name);
    } else {
      annos.set(t, anno);
    }
  };
  visit(t);
}

function decodeSolution(d: Denter, decoders: Decoders, solution: Solution): void {
  d.print("let x = val;\n");

  // now we can generate the whole solution without any backtracking
  const visit = (solution: Solution): void => {
    if (solution instanceof Match) {
      const decoder = decoders.get(solution.typ) ?? null;
      d.print("return " + (decoder === null ? "val" : decoder("val")) + ";\n");
    } else if (solution instanceof CheckJsonType) {
      if (solution.options.size === 1) {
        visit(solution.options.values().next().value!);
        return;
      }
      // note that typeof() has some weird behaviors:
      // - typeof([]) = "object"
      // - typeof(null) = "object"
      // so we use a custom helper function specific to handling decoded json
      d.print("switch(json_typeof(x)){\n");
      d.indent("  ");
      for (const [jtyp, subsln] of solution.options) {
        d.print(`case "${jtyp}":\n`);
        d.indent("  ");
        visit(subsln);
        d.dedent();
      }
      d.dedent();
      d.print("}\n");
    } else if (solution instanceof CheckLiteral) {
      if (solution.options.size === 1) {
        visit(solution.options.values().next().value!);
        return;
      }
      d.print("switch(x){\n");
      d.indent("  ");
      for (const [lit, subsln] of solution.options) {
        if (typeof lit === "string") {
          d.print(`case "${lit}":\n`);
        } else {
          d.print(`case ${lit}:\n`);
        }
        d.indent("  ");
        visit(subsln);
        d.dedent();
      }
      d.print("default: throw new Error(`unexpected value: ${val}`);\n");
      d.dedent();
      d.print("}\n");
    } else if (solution instanceof CheckLength) {
      if (solution.options.size === 1 && solution.default === null) {
        visit(solution.options.values().next().value!);
        return;
      }
      d.print("switch(x.length){\n");
      d.indent("  ");
      for (const [length, subsln] of solution.options) {
        d.print(`case ${length}:\n`);
        d.indent("  ");
        visit(subsln);
        d.dedent();
      }
      if (solution.default !== null) {
        d.print(`default:\n`);
        d.indent("  ");
        visit(solution.default);
        d.dedent();
      }
      d.dedent();
      d.print("}\n");
    } else if (solution instanceof GetIndex) {
      d.print(`x = x[${solution.i}];\n`);
      visit(solution.solution);
    } else if (solution instanceof GetField) {
      d.print(`x = x.${solution.key};\n`);
      visit(solution.solution);
    } else {
      throw new Error(`unrecognized solution type: ${solution.constructor.name}`);
    }
  };

  visit(solution);
}

function generateDecoders(
  d: Denter,
  registry: KTypeRegistry,
  annos: Annos,
  decoders: Decoders,
  t: KType,
  anon: { n: number },
): void {
  const visit = (t: KType): void => {
    if (decoders.has(t)) return;

    if (
      t instanceof KString || t instanceof KInt || t instanceof KBool ||
      t instanceof KNull || t instanceof KLiteral || t instanceof KJson
    ) {
      decoders.set(t, null);
      // builtin types and their aliases need no Decode{name}() function
      return;
    }

    if (t instanceof KDate) {
      decoders.set(t, (val) => `new Date(${val} as string)`);
      // no Decode{name}() needed
      return;
    }

    let decoder: Decoder;
    if (t instanceof KUnion) {
      for (const ut of t.types) visit(ut);
      if (t.types.every((ut) => decoders.get(ut) === null)) {
        decoder = null;
      } else {
        // non-identity union; this requires a union solution
        const solution = solveUnion(registry, t.types);
        let name = t.name;
        if (!name) {
          name = `Anon${anon.n}`;
          anon.n += 1;
        }
        d.print(`\nfunction decode${name}(val: any): ${annos.get(t)} {\n`);
        d.indent("  ");
        decodeSolution(d, decoders, solution);
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decode${name}(${val})`;
      }
    } else if (t instanceof KArray) {
      visit(t.itemType);
      // calculate the decoding expression
      const itemDecoder = decoders.get(t.itemType)!;
      if (itemDecoder === null) {
        decoder = null;
      } else {
        const decodeItemX = itemDecoder("x");
        decoder = (val) => `${val}.map((x) => ${decodeItemX})`;
      }
    } else if (t instanceof KTuple) {
      for (const it of t.itemTypes) visit(it);
      if (t.itemTypes.every((it) => decoders.get(it) === null)) {
        decoder = null;
      } else {
        decoder = (val) =>
          "[" +
          t.itemTypes
            .map((it, i) => {
              const itd = decoders.get(it);
              return itd === null ? `${val}[${i}]` : itd!(`${val}[${i}]`);
            })
            .join(", ") +
          "]";
      }
    } else if (t instanceof KStruct) {
      for (const ft of t.fields.values()) visit(ft);
      if ([...t.fields.values()].every((ft) => decoders.get(ft) === null)) {
        // all decoders are identity; identity decoder works for the whole struct
        decoder = null;
      } else if ([...t.maybes.values()].every((ft) => decoders.get(ft) === null)) {
        // all maybe decoders are identity; can be inlined with spread operator
        decoder = (val) =>
          "{ " +
          [
            `...${val}`,
            ...[...t.always]
              .filter(([, ft]) => decoders.get(ft) !== null)
              .map(([fn, ft]) => fn + ": " + decoders.get(ft)!(`${val}.${fn}`)),
          ].join(", ") +
          " }";
      } else {
        // non-identity maybes are present; inlining not possible
        const n = anon.n;
        anon.n += 1;
        d.print(`\nfunction decodeAnon${n}(val: any): ${annos.get(t)} {\n`);
        d.indent("  ");
        d.print("const out = { ...val };\n");
        for (const [fn, ft] of t.fields) {
          const fd = decoders.get(ft)!;
          if (fd === null) continue;
          const decodedField = fd(`val.${fn}`);
          if (t.maybes.has(fn)) {
            d.print(`if(val.${fn}) out.${fn} = ${decodedField};\n`);
          } else {
            d.print(`out.${fn} = ${decodedField};\n`);
          }
        }
        d.print(`return out as ${annos.get(t)};\n`);
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decodeAnon${n}(${val})`;
      }
    } else if (t instanceof KObject) {
      visit(t.valueType);
      const vd = decoders.get(t.valueType)!;
      if (vd === null) {
        decoder = null;
      } else {
        // non-identity values; inlining not possible
        const n = anon.n;
        anon.n += 1;
        d.print(`\nfunction decodeAnon${n}(val: any): ${annos.get(t)} {\n`);
        d.indent("  ");
        d.print("return Object.fromEntries(Object.entries(val).map(");
        d.print(`([k, v]) => [k, ${vd("v")}]`);
        d.print(");");
        d.dedent();
        d.print(`}\n`);
        decoder = (val) => `decodeAnon${n}(${val})`;
      }
    } else {
      throw new Error(`unhandled type in generateDecoders: ${t}`);
    }

    // either define a named decoder or inline it
    if (t.name) {
      // we always export a named decoder...
      const decodeVal = decoder === null ? "val" : decoder("val");
      d.print(`\nexport function Decode${t.name}(val: any): ${annos.get(t)} {\n`);
      d.print(`  return ${decodeVal} as ${annos.get(t)};\n`);
      d.print("}\n");
      // ... but if the decoder is the identity_decoder, we don't use it ourselves
      if (decoder === null) {
        decoders.set(t, null);
      } else {
        const nm = t.name;
        decoders.set(t, (val) => `Decode${nm}(${val})`);
      }
    } else {
      decoders.set(t, decoder);
    }
  };

  visit(t);
}

function generateStorePrereqs(d: Denter): void {
  d.print("\n");
  d.print("function *queryGet<T>(key: string): QueryGenerator<T> {\n");
  d.print("  const ans = yield {'store': {[key]: true}};\n");
  d.print("  const sv = ans.store[key];\n");
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print("  return readOnly(sv.value) as T\n");
  d.print("}\n");
  d.print("\n");
  d.print("function *reducerOld<T>(key: string): Reducer<T> {\n");
  d.print("  const ans = yield {'old': {[key]: true}};\n");
  d.print("  const sv = ans.old[key];\n");
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print("  return copyOnWrite(sv.value) as T\n");
  d.print("}\n");
  d.print("\n");
  d.print("function *reducerGet<T>(key: string): Reducer<T> {\n");
  d.print("  const ans = yield {'get': {[key]: true}};\n");
  d.print("  const sv = ans.get[key];\n");
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print("  return copyOnWrite(sv.value) as T\n");
  d.print("}\n");
  d.print("\n");
  d.print("function *reducerSet<T>(key: string, value: T): Reducer<void> {\n");
  d.print("  const ans = yield {'set': {[key]: value}};\n");
  d.print("  const sv = ans.set[key];\n");
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print("}\n");
  d.print("function *reducerDel(key: string): Reducer<void> {\n");
  d.print("  const ans = yield {'del': {[key]: true}};\n");
  d.print("  const sv = ans.del[key];\n");
  d.print("  if ('err' in sv) throw sv.err;\n");
  d.print("}\n");
  d.print("function *reducerUpdate<T, R>(key: string, fn: (t: T) => R): Reducer<R> {\n");
  d.print("  const obj = yield* reducerGet<T>(key);\n");
  d.print("  const out = fn(obj);\n");
  d.print("  yield* reducerSet(key, obj);\n");
  d.print("  return out;\n");
  d.print("}\n");
  d.print("export type NoSet<T extends {\n");
  d.print('  "get": unknown, "old": unknown, "del": unknown, "update": unknown\n');
  d.print('}> = Pick<T, "get"|"old"|"del"|"update">;\n');
}

function contextName(name: string): string {
  return name.endsWith("Store") ? name.slice(0, -5) : name;
}

/**
 * isUpdatable returns if a type is suitable for an rx.update member.
 *
 * The rx.update pattern is to accept a mutator function which updates-in-place its parameter.
 * This is for two reasons:
 * - ergonomically, it means many updates are one-liners
 * - it makes it possible to write a type-safe updater that works against many variants of a store
 *
 * Therefore we can only create updaters for certain kinds of types.
 */
function isUpdatable(t: KType): boolean {
  if (t instanceof KArray || t instanceof KTuple || t instanceof KStruct || t instanceof KObject) {
    return true;
  }
  if (t instanceof KUnion) return t.types.every(isUpdatable);
  return false;
}

function printTemplate(d: Denter, si: { chunks: readonly string[]; params: readonly string[] }): void {
  for (let i = 0; i < si.params.length; i++) {
    d.print(si.chunks[i] + "${" + si.params[i] + "}");
  }
  d.print(si.chunks[si.chunks.length - 1]);
}

function generateStore(d: Denter, annos: Annos, store: KStore): void {
  const ctxName = contextName(store.name!);
  // Generate the QueryContext singleton.
  d.print(`\nexport const ${ctxName}QueryContext = {\n`);
  d.indent("  ");
  // generate getters like:
  // topic: (topic_uuid: Uuid) => queryGet<Topic>(`topic.${topic_uuid}`)
  d.print("get: {\n");
  d.indent("  ");
  const originalItems = store.originalItems;
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ": string").join(", "));
    d.print(`) => queryGet<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print("`),\n");
  }
  // also use the spread operator to reuse definitions from our deps
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}QueryContext.get,\n`);
  }
  d.dedent();
  d.print("},\n");
  d.dedent();
  d.print(`};\n`);
  d.print("\n");
  // also create typeof shorthand
  d.print(`\nexport type ${ctxName}QX = typeof ${ctxName}QueryContext;\n`);

  // Generate the ReducerContext singleton.
  d.print(`export const ${ctxName}ReducerContext = {\n`);
  d.indent("  ");

  // generate old getters like:
  // topic: (topic_uuid: Uuid) => reducerOld<Topic>(`topic.${topic_uuid}`)
  d.print("old: {\n");
  d.indent("  ");
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ": string").join(", "));
    d.print(`) => reducerOld<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print("`),\n");
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.old,\n`);
  }
  d.dedent();
  d.print("},\n");

  // generate getters like:
  // topic: (topic_uuid: Uuid) => reducerGet<Topic>(`topic.${topic_uuid}`)
  d.print("get: {\n");
  d.indent("  ");
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ": string").join(", "));
    d.print(`) => reducerGet<${annos.get(si.type)}>(\``);
    printTemplate(d, si);
    d.print("`),\n");
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.get,\n`);
  }
  d.dedent();
  d.print("},\n");

  // generate setters like:
  // topic: (topic_uuid: Uuid, value: Topic) => reducerSetter(`topic.${topic_uuid}`, value)
  d.print("set: {\n");
  d.indent("  ");
  for (const si of originalItems) {
    d.print(`${si.name}: (`);
    d.print(
      [...si.params.map((p) => p + ": string"), `value: ${annos.get(si.type)}`].join(", "),
    );
    d.print(") => reducerSet(`");
    printTemplate(d, si);
    d.print("`, value),\n");
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.set,\n`);
  }
  d.dedent();
  d.print("},\n");

  // generate deleters like:
  // topic: (topic_uuid: Uuid) => reducerDeleter(`topic.${topic_uuid}`)
  d.print("del: {\n");
  d.indent("  ");
  for (const si of originalItems) {
    // no point in adding deleters for indices (when there isn't a param)
    if (!si.params.length) continue;
    d.print(`${si.name}: (`);
    d.print(si.params.map((p) => p + ": string").join(", "));
    d.print(") => reducerDel(`");
    printTemplate(d, si);
    d.print("`),\n");
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.del,\n`);
  }
  d.dedent();
  d.print("},\n");

  // compound types (objects and arrays) also get updaters
  d.print("update: {\n");
  d.indent("  ");
  for (const si of originalItems) {
    if (!isUpdatable(si.type)) continue;
    d.print(`${si.name}: <R>(`);
    d.print(si.params.map((p) => p + ": string, ").join(""));
    d.print(`fn: (value: ${annos.get(si.type)}) => R`);
    d.print(") => reducerUpdate(`");
    printTemplate(d, si);
    d.print("`, fn),\n");
  }
  for (const dep of store.deps) {
    d.print(`...${contextName(dep.name!)}ReducerContext.update,\n`);
  }
  d.dedent();
  d.print("},\n");

  d.dedent();
  d.print(`};\n`);
  // also create typeof shorthand
  d.print(`\nexport type ${ctxName}RX = typeof ${ctxName}ReducerContext;\n`);
}

function generateFramework(d: Denter, annos: Annos, f: KFramework): void {
  const eventType = annos.get(f.eventType)!;
  const commandType = annos.get(f.commandType)!;
  const ctxName = contextName(f.store.name!);
  const rx = `${ctxName}ReducerContext`;
  const qx = `${ctxName}QueryContext`;
  const RX = `${ctxName}RX`;
  const QX = `${ctxName}QX`;
  const decodeEvent = `Decode${f.eventType.name}`;
  const decodeCommand = `Decode${f.commandType.name}`;

  d.print(`
export class ${f.name} extends Framework<${QX}, ${RX}, ${eventType}, ${commandType}> {
  constructor(
    storage: Storage,
    callbacks: {
      // optional: configure storage before any events arrive
      migrate?: (rx: ${RX}) => Reducer<void>,
      // required: reduce a batch of events into the read model
      reducer: (rx: ${RX}, events: ${eventType}[]) => Reducer<void | any[]>,
      // optional: forecast the events a server will send for a command
      forecaster?: (commands: ${commandType}) => ${eventType}[],
      // required if using sendCommands: receive events to send on the wire
      onCommands?: (commands: Event<any>[])=> void,
    },
    // used in cross-language support: inject an arbitrary object as the QueryContext
    qx?: any,
  ) {
    super(qx ?? ${qx}, ${rx}, storage, {
        ...callbacks,
        decodeEvent: ${decodeEvent},
        decodeCommand: ${decodeCommand},
    });
  }
}
`);

  // Then generate a TestData helper.  This could use typescript's "constrained mixins", but why
  // complicate code that's only used for testing?
  d.print(`\nexport class ${ctxName}TestData {\n`);
  d.indent("  ");
  d.print(`data: Record<string, any>;\n`);
  d.print(`\n`);
  d.print(`constructor(data: Record<string, any>){\n`);
  d.indent("  ");
  d.print(`this.data = data;\n`);
  d.dedent();
  d.print(`}\n`);

  for (const si of f.store.items) {
    d.print(`\n${si.name}(`);
    d.print(si.params.map((p) => p + ": string").join(", "));
    d.print(`): ${annos.get(si.type)} {\n`);
    d.indent("  ");
    d.print("return this.data[`");
    printTemplate(d, si);
    d.print(`\`] as ${annos.get(si.type)}\n`);
    d.dedent();
    d.print(`}\n`);
  }

  d.dedent();
  d.print(`}\n`);

  // Then generate a ReducerTester matching this Framework
  d.print(`
export class ${ctxName}ReducerTester extends ReducerTester<${RX}, ${eventType}, ${ctxName}TestData> {
  constructor(
    migrateOrInitialData: ((rx: ${RX}) => Reducer<void>) | Record<string, any>,
    reducer: (rx: ${RX}, events: ${eventType}[]) => Reducer<void | any[]>,
  ) {
    let migrate: null | ((rx: ${RX}) => Reducer<void>);
    let data: Record<string, any>;
    if (migrateOrInitialData instanceof Function) {
        migrate = migrateOrInitialData;
        data = {};
    } else {
        migrate = null;
        data = migrateOrInitialData;
    }
    super(${rx}, migrate, reducer, new InMemStorage(data), new ${ctxName}TestData(data));
  }
}
`);
}

/** entrypoint: assemble the complete generated module */
export function generateTs(lowered: LoweredProgram, skeleton: string): string {
  const { registry, roots, stores, frameworks } = lowered;
  if (!roots.length) throw new Error("no named types found to generate code for");

  const d = new Denter();

  // Start with the skeleton
  d.print(skeleton);

  const typesToVisit = [
    ...roots,
    ...stores.flatMap((s) => s.items.map((si) => si.type)),
    ...frameworks.flatMap((f) => f.store.items.map((si) => si.type)),
  ];

  // Define types and decide on type annotations.
  const annos: Annos = new Map();
  for (const t of typesToVisit) generateAnnotations(d, annos, t);

  // Generate decoders and pick decoding expressions.
  const decoders: Decoders = new Map();
  const anon = { n: 0 };
  for (const t of typesToVisit) generateDecoders(d, registry, annos, decoders, t, anon);

  // Generate stores
  if (stores.length) generateStorePrereqs(d);
  for (const s of stores) generateStore(d, annos, s);

  // Generate frameworks
  for (const f of frameworks) generateFramework(d, annos, f);

  // the generated file ends with a trailing newline
  return d.getvalue() + "\n";
}
