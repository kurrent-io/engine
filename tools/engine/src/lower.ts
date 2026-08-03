/**
 * Lowering: TypeSpec Program → Kurrent Engine IR.
 *
 * Lowering consumes the checker's fully resolved type graph and translates it into the interned
 * IR, plus:
 *   - names: top-level declarations name the IR types they lower to (first name wins; a second
 *     declaration that resolves to the same structural type is a diagnostic)
 *   - stores: interfaces extending `KurrentEngine.Store<Spec, Deps>` become KStore; the Spec
 *     model's property names are the key templates, Deps is a tuple of other Store interfaces
 *   - frameworks: interfaces extending `KurrentEngine.Framework<Events, Commands, S>` become
 *     KFramework
 *   - queries: interfaces extending `KurrentEngine.Queries` become KQueries; each operation
 *     becomes a KQuery carrying its name, arguments, and result type
 *
 * Interfaces are deliberately the carrier for stores, frameworks, and queries: they are not
 * data types, so they can't leak into the model space the way decorated models could.
 *
 * Ordering: `roots` follows IR creation order, which is a depth-first walk of declarations in
 * source order — children precede parents (e.g. union members appear before the union itself).
 */

import {
  getNamespaceFullName,
  getSourceLocation,
  isArrayModelType,
  isRecordModelType,
  isStdNamespace,
  isTemplateDeclaration,
  walkPropertiesInherited,
} from "@typespec/compiler";
import type {
  Entity,
  Enum,
  Interface,
  Model,
  Program,
  Scalar,
  Tuple,
  Type,
  Union,
} from "@typespec/compiler";
import { reportDiagnostic } from "./lib.js";
import { KField, KType, KFramework, KQueries, KQuery, KStore, KTypeRegistry } from "./ktypes.js";

export interface LoweredProgram {
  registry: KTypeRegistry;
  /** all named data types, in creation (resolution) order */
  roots: KType[];
  /** all stores, in declaration order */
  stores: KStore[];
  /** all frameworks, in declaration order */
  frameworks: KFramework[];
  /** all queries interfaces, in declaration order */
  queries: KQueries[];
  /** the first TypeSpec type that lowered to each IR type, for diagnostic targeting */
  targets: Map<KType, Type>;
}

/**
 * A template argument may arrive as an IndeterminateEntity (an entity the checker hasn't
 * committed to being a type or a value, e.g. a model expression or tuple literal); unwrap to the
 * underlying type.
 */
function argType(arg: Entity | undefined): Type | undefined {
  if (arg === undefined) return undefined;
  if (arg.entityKind === "Indeterminate") return arg.type;
  if (arg.entityKind === "Type") return arg;
  return undefined; // a Value; callers diagnose
}

/**
 * Find KurrentEngine.<name> among an interface's extends list — the template instantiation for
 * templates (Store, Framework), or the interface itself for plain ones (Queries).
 */
function engineSource(iface: Interface, name: string): Interface | undefined {
  for (const src of iface.sourceInterfaces) {
    if (
      src.name === name &&
      src.namespace !== undefined &&
      getNamespaceFullName(src.namespace) === "KurrentEngine"
    ) {
      return src;
    }
  }
  return undefined;
}

export function lowerProgram(program: Program): LoweredProgram {
  const registry = new KTypeRegistry();
  const typeCache = new Map<Type, KType>();
  const storeCache = new Map<Interface, KStore>();
  const targets = new Map<KType, Type>();

  function unsupported(target: Type, message: string): KType {
    reportDiagnostic(program, {
      code: "unsupported-type",
      format: { message },
      target,
    });
    return registry.json();
  }

  function invalidArgs(target: Type, message: string): void {
    reportDiagnostic(program, {
      code: "invalid-template-args",
      format: { message },
      target,
    });
  }

  function lowerScalar(scalar: Scalar): KType {
    // walk the extends chain up to a TypeSpec standard scalar
    for (let s: Scalar | undefined = scalar; s !== undefined; s = s.baseScalar) {
      if (s.namespace === undefined || !isStdNamespace(s.namespace)) continue;
      switch (s.name) {
        case "string":
        case "url":
          return registry.string();
        case "boolean":
          return registry.bool();
        case "integer":
        case "safeint":
        case "int8":
        case "int16":
        case "int32":
        case "int64":
        case "uint8":
        case "uint16":
        case "uint32":
        case "uint64":
          return registry.int();
        case "utcDateTime":
        case "offsetDateTime":
        case "plainDate":
        case "plainTime":
          return registry.date();
        default:
          return unsupported(scalar, `scalar ${s.name}`);
      }
    }
    return unsupported(scalar, `scalar ${scalar.name}`);
  }

  function lowerModel(model: Model): KType {
    if (isArrayModelType(model)) {
      return registry.array(lowerType(model.indexer.value));
    }
    if (isRecordModelType(model)) {
      return registry.object(lowerType(model.indexer.value));
    }
    const fields: KField[] = [];
    for (const prop of walkPropertiesInherited(model)) {
      fields.push([prop.name, lowerType(prop.type), prop.optional]);
    }
    return registry.struct(fields);
  }

  function lowerEnum(en: Enum): KType {
    // an enum is sugar for a union of literals
    const literals = [...en.members.values()].map((m) => registry.literal(m.value ?? m.name));
    return registry.union(literals);
  }

  function lowerType(type: Type): KType {
    const cached = typeCache.get(type);
    if (cached !== undefined) return cached;
    const ct = lowerTypeUncached(type);
    typeCache.set(type, ct);
    if (!targets.has(ct)) targets.set(ct, type);
    return ct;
  }

  function lowerTypeUncached(type: Type): KType {
    switch (type.kind) {
      case "Model":
        return lowerModel(type);
      case "Union":
        return registry.union([...type.variants.values()].map((v) => lowerType(v.type)));
      case "Scalar":
        return lowerScalar(type);
      case "String":
        return registry.literal(type.value);
      case "Boolean":
        return registry.literal(type.value);
      case "Number":
        if (!Number.isInteger(type.value)) {
          return unsupported(type, `non-integer numeric literal ${type.value}`);
        }
        return registry.literal(type.value);
      case "Tuple":
        return registry.tuple(type.values.map((v) => lowerType(v)));
      case "Enum":
        return lowerEnum(type);
      case "Intrinsic":
        if (type.name === "null") return registry.null_();
        if (type.name === "unknown") return registry.json();
        return unsupported(type, `intrinsic ${type.name}`);
      default:
        return unsupported(type, type.kind);
    }
  }

  /** Lower an interface extending KurrentEngine.Store into a KStore. */
  function lowerStore(iface: Interface): KStore {
    const cached = storeCache.get(iface);
    if (cached !== undefined) return cached;

    // memoize before validating so diagnostic paths don't recurse forever
    const empty = new KStore([], []);
    empty.name = iface.name;
    storeCache.set(iface, empty);

    const instance = engineSource(iface, "Store");
    if (instance === undefined) {
      reportDiagnostic(program, { code: "not-a-store", format: { name: iface.name }, target: iface });
      return empty;
    }

    const [specArg, depsArg] = (instance.templateMapper?.args ?? []).map(argType);
    if (specArg === undefined || specArg.kind !== "Model") {
      invalidArgs(iface, `Store 'Spec' argument of '${iface.name}' must be a model`);
      return empty;
    }
    if (depsArg === undefined || depsArg.kind !== "Tuple") {
      invalidArgs(iface, `Store 'Deps' argument of '${iface.name}' must be a tuple of Stores`);
      return empty;
    }

    const deps: KStore[] = [];
    for (const dep of (depsArg as Tuple).values) {
      if (dep.kind !== "Interface" || engineSource(dep, "Store") === undefined) {
        reportDiagnostic(program, {
          code: "not-a-store",
          format: { name: "name" in dep && typeof dep.name === "string" ? dep.name : dep.kind },
          target: iface,
        });
        continue;
      }
      deps.push(lowerStore(dep));
    }

    // the Spec model's property names are the key templates
    const specs: [string, KType][] = [];
    for (const prop of specArg.properties.values()) {
      specs.push([prop.name, lowerType(prop.type)]);
    }

    let store: KStore;
    try {
      store = new KStore(specs, deps);
    } catch (e) {
      reportDiagnostic(program, {
        code: "store-collision",
        format: { message: (e as Error).message },
        target: iface,
      });
      return empty;
    }
    store.name = iface.name;
    storeCache.set(iface, store);
    return store;
  }

  function assignName(ct: KType, declName: string, target: Type): void {
    if (ct.name === null) {
      ct.name = declName;
    } else if (ct.name !== declName) {
      // two declarations resolved to the same structural type under different names
      reportDiagnostic(program, {
        code: "duplicate-name",
        format: { name: declName, other: ct.name },
        target,
      });
    }
  }

  /** sort declarations by their position in the source */
  function sourceOrder<T extends Type>(types: T[]): T[] {
    return types
      .map((t, i) => {
        const loc = getSourceLocation(t);
        return { t, i, file: loc?.file?.path ?? "", pos: loc?.pos ?? 0 };
      })
      .sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.pos - b.pos || a.i - b.i,
      )
      .map((x) => x.t);
  }

  const globalNs = program.getGlobalNamespaceType();

  // named data types: models, unions, and enums, in source order
  const namedDecls: (Model | Union | Enum)[] = sourceOrder([
    ...[...globalNs.models.values()].filter((m) => !isTemplateDeclaration(m)),
    ...[...globalNs.unions.values()].filter((u) => u.name !== undefined),
    ...globalNs.enums.values(),
  ]);
  for (const decl of namedDecls) {
    assignName(lowerType(decl), decl.name!, decl);
  }

  // stores, frameworks, and queries are interfaces extending the KurrentEngine vocabulary, in
  // source order
  const stores: KStore[] = [];
  const frameworks: KFramework[] = [];
  const queries: KQueries[] = [];
  const userInterfaces = sourceOrder(
    [...globalNs.interfaces.values()].filter((i) => !isTemplateDeclaration(i)),
  );
  for (const iface of userInterfaces) {
    if (engineSource(iface, "Store") !== undefined) {
      stores.push(lowerStore(iface));
      continue;
    }
    if (engineSource(iface, "Queries") !== undefined) {
      const ops: KQuery[] = [];
      for (const op of iface.operations.values()) {
        const args: KField[] = [];
        for (const param of op.parameters.properties.values()) {
          args.push([param.name, lowerType(param.type), param.optional]);
        }
        ops.push(new KQuery(op.name, args, lowerType(op.returnType)));
      }
      const kq = new KQueries(ops);
      kq.name = iface.name;
      queries.push(kq);
      continue;
    }
    const instance = engineSource(iface, "Framework");
    if (instance === undefined) continue; // a plain interface; none of our business

    const [eventsArg, commandsArg, storeArg] = (instance.templateMapper?.args ?? []).map(argType);
    if (eventsArg === undefined || commandsArg === undefined) {
      invalidArgs(iface, `Framework '${iface.name}' needs Events and Commands type arguments`);
      continue;
    }
    if (storeArg === undefined || storeArg.kind !== "Interface") {
      reportDiagnostic(program, {
        code: "not-a-store",
        format: { name: iface.name },
        target: iface,
      });
      continue;
    }
    const eventType = lowerType(eventsArg);
    const commandType = lowerType(commandsArg);
    // decoders are looked up by name (Decode<Name>), so both must lower to named types
    for (const [arg, ct] of [[eventsArg, eventType], [commandsArg, commandType]] as const) {
      if (ct.name === null) {
        invalidArgs(
          iface,
          `Framework '${iface.name}' Events/Commands must resolve to named types (got ${ct})`,
        );
      }
      void arg;
    }
    const fw = new KFramework(eventType, commandType, lowerStore(storeArg));
    fw.name = iface.name;
    frameworks.push(fw);
  }

  const roots = registry.all.filter((t) => t.name !== null);
  return { registry, roots, stores, frameworks, queries, targets };
}
