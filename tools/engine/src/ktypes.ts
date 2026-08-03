/**
 * KType and friends are intermediate representation (IR) layer that code generation consumes.
 *
 * KTypes are interned: identical types are represented by a single object, so object identity is
 * 1:1 with type equality.  The union solver and the decoder generators both rely on that.
 *
 * The 'K' in 'KType' is for Kurrent, and distinguishes e.g. KUnion from @typescript/compiler's
 * Union type, as well as distinguishing KFramework from our own user-facing Framework.
 */

export type JsonType = "null" | "int" | "string" | "boolean" | "object" | "array" | "*";
export type LitValue = string | number | boolean;

let nextId = 0;

export abstract class KType {
  readonly id: number = nextId++;
  name: string | null = null;
  abstract readonly jsonType: JsonType;
  abstract toString(): string;
}

/** Iterate union members, or the type itself for non-unions. */
export function members(t: KType): readonly KType[] {
  return t instanceof KUnion ? t.types : [t];
}

export class KNull extends KType {
  readonly jsonType = "null";
  toString() { return "null"; }
}

export class KInt extends KType {
  readonly jsonType = "int";
  toString() { return "int"; }
}

export class KString extends KType {
  readonly jsonType = "string";
  toString() { return "str"; }
}

export class KBool extends KType {
  readonly jsonType = "boolean";
  toString() { return "bool"; }
}

export class KDate extends KType {
  readonly jsonType = "string";
  toString() { return "Date"; }
}

export class KJson extends KType {
  readonly jsonType = "*";
  toString() { return "json"; }
}

export class KLiteral extends KType {
  readonly jsonType: JsonType;
  constructor(readonly value: LitValue) {
    super();
    if (typeof value === "boolean") this.jsonType = "boolean";
    else if (typeof value === "string") this.jsonType = "string";
    else if (Number.isInteger(value)) this.jsonType = "int";
    else throw new Error(`illegal value for KLiteral(${value})`);
  }
  toString() {
    if (typeof this.value === "string") return `"${this.value}"`;
    return String(this.value);
  }
}

export type KField = readonly [name: string, type: KType, optional: boolean];

export class KStruct extends KType {
  readonly jsonType = "object";
  /** all fields, regardless of maybe status, in declaration order */
  readonly fields: Map<string, KType>;
  /** only non-maybe fields */
  readonly always: Map<string, KType>;
  /** only maybe fields */
  readonly maybes: Map<string, KType>;
  constructor(fields: readonly KField[]) {
    super();
    this.fields = new Map(fields.map(([k, t]) => [k, t]));
    this.always = new Map(fields.filter(([, , opt]) => !opt).map(([k, t]) => [k, t]));
    this.maybes = new Map(fields.filter(([, , opt]) => opt).map(([k, t]) => [k, t]));
  }
  toString() {
    if (this.name) return this.name;
    const mkfield = (k: string, v: KType) => `${k}${this.maybes.has(k) ? "?" : ""}: ${v}`;
    return "{" + [...this.fields].map(([k, v]) => mkfield(k, v)).join(", ") + "}";
  }
}

export class KObject extends KType {
  readonly jsonType = "object";
  constructor(readonly valueType: KType) { super(); }
  toString() { return this.name ?? `Object[${this.valueType}]`; }
}

export class KArray extends KType {
  readonly jsonType = "array";
  constructor(readonly itemType: KType) { super(); }
  lengthRange(): [number, number] { return [0, Infinity]; }
  typeat(_i: number): KType { return this.itemType; }
  toString() { return this.name ?? `Array[${this.itemType}]`; }
}

export class KTuple extends KType {
  readonly jsonType = "array";
  constructor(readonly itemTypes: readonly KType[]) { super(); }
  lengthRange(): [number, number] { return [this.itemTypes.length, this.itemTypes.length]; }
  typeat(i: number): KType { return this.itemTypes[i]; }
  toString() { return this.name ?? "Tuple[" + this.itemTypes.join(", ") + "]"; }
}

export class KUnion extends KType {
  /** members in first-seen order; never contains a nested KUnion */
  readonly types: readonly KType[];
  constructor(types: readonly KType[]) {
    super();
    this.types = types;
  }
  // A union has no single json type.  Solver inputs are always flattened members (never nested
  // unions), so reaching this indicates a bug in the caller.
  get jsonType(): JsonType { throw new Error(`unions have no single json type: ${this}`); }
  toString() {
    return this.name ?? this.types.map(String).sort().join("|");
  }
}

/**
 * KTypeRegistry is the interning layer: every type is created through it, and structurally
 * identical types come back as the same object.
 *
 * Structural keys are built from child ids, which is sound because children are themselves
 * interned before the parent key is computed.  Struct keys sort their fields so that field order
 * does not affect identity (the first creation wins the display order); union keys sort member
 * ids so that member order does not affect identity either.
 */
export class KTypeRegistry {
  /** every distinct type ever created, in creation order */
  readonly all: KType[] = [];
  private interned = new Map<string, KType>();

  private intern<T extends KType>(key: string, create: () => T): T {
    const existing = this.interned.get(key);
    if (existing !== undefined) return existing as T;
    const val = create();
    this.interned.set(key, val);
    this.all.push(val);
    return val;
  }

  null_(): KNull { return this.intern("null", () => new KNull()); }
  int(): KInt { return this.intern("int", () => new KInt()); }
  string(): KString { return this.intern("string", () => new KString()); }
  bool(): KBool { return this.intern("bool", () => new KBool()); }
  date(): KDate { return this.intern("date", () => new KDate()); }
  json(): KJson { return this.intern("json", () => new KJson()); }

  literal(value: LitValue): KLiteral {
    return this.intern(`lit:${typeof value}:${JSON.stringify(value)}`, () => new KLiteral(value));
  }

  struct(fields: readonly KField[]): KStruct {
    const key = "struct:" + [...fields]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, t, opt]) => `${k}${opt ? "?" : ""}=${t.id}`)
      .join(",");
    return this.intern(key, () => new KStruct(fields));
  }

  object(valueType: KType): KObject {
    return this.intern(`obj:${valueType.id}`, () => new KObject(valueType));
  }

  array(itemType: KType): KArray {
    return this.intern(`arr:${itemType.id}`, () => new KArray(itemType));
  }

  tuple(itemTypes: readonly KType[]): KTuple {
    return this.intern(`tup:${itemTypes.map((t) => t.id).join(",")}`, () => new KTuple(itemTypes));
  }

  /**
   * Create a union.  Nested unions are flattened and duplicate members dropped, so union members
   * are never themselves unions.  A single-member union resolves to the member itself.
   */
  union(types: readonly KType[]): KType {
    const flat: KType[] = [];
    const seen = new Set<KType>();
    for (const t of types) {
      for (const m of members(t)) {
        if (!seen.has(m)) { seen.add(m); flat.push(m); }
      }
    }
    if (flat.length === 0) throw new Error("no types in union!");
    if (flat.length === 1) return flat[0];
    const key = "union:" + flat.map((t) => t.id).sort((a, b) => a - b).join(",");
    return this.intern(key, () => new KUnion(flat));
  }
}

// Store, Framework, and Queries IR

const TPL_PATTERN = /\{([^}]*)\}/g;

export class KStoreItem {
  private constructor(
    readonly tpl: string,
    readonly type: KType,
    readonly origin: KStore,
    readonly name: string,
    /** there is always one more chunk than params */
    readonly chunks: readonly string[],
    readonly params: readonly string[],
  ) {}

  static fromSpec(tpl: string, type: KType, origin: KStore): KStoreItem {
    const name = tpl.split(".")[0];
    if (name.includes("{")) {
      throw new Error(`store key template '${tpl}' does not have a name before a '.'`);
    }
    const [chunks, params] = KStoreItem.parseTpl(tpl);
    return new KStoreItem(tpl, type, origin, name, chunks, params);
  }

  static parseTpl(tpl: string): [string[], string[]] {
    const chunks: string[] = [];
    const params: string[] = [];
    let i = 0;
    for (const m of tpl.matchAll(TPL_PATTERN)) {
      chunks.push(tpl.slice(i, m.index));
      i = m.index + m[0].length;
      params.push(m[1]);
    }
    chunks.push(tpl.slice(i));
    return [chunks, params];
  }
}

export class KStore {
  name: string | null = null;
  readonly deps: readonly KStore[];
  /** all items including those of deps, sorted by name */
  readonly items: readonly KStoreItem[];

  constructor(specs: readonly (readonly [string, KType])[], deps: readonly KStore[]) {
    this.deps = deps;
    const items: KStoreItem[] = [];
    const names = new Map<string, KStoreItem>();
    const add = (si: KStoreItem) => {
      const match = names.get(si.name);
      if (match !== undefined) {
        throw new Error(
          `unable to add store template '${si.tpl}', which collides with template '${match.tpl}'`,
        );
      }
      items.push(si);
      names.set(si.name, si);
    };
    for (const dep of deps) {
      for (const si of dep.items) add(si);
    }
    for (const [tpl, type] of specs) add(KStoreItem.fromSpec(tpl, type, this));
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.items = items;
  }

  /** items declared on this store itself (not inherited from deps), in sorted order */
  get originalItems(): KStoreItem[] {
    return this.items.filter((si) => si.origin === this);
  }

  toString() {
    return "Store(\n  " + this.items.map((si) => `${si.tpl}: ${si.type}`).join(",\n  ") + "\n)";
  }
}

export class KFramework {
  name: string | null = null;
  constructor(
    readonly eventType: KType,
    readonly commandType: KType,
    readonly store: KStore,
  ) {}
}

/** One query declaration: its name, arguments, and result type. */
export class KQuery {
  constructor(
    readonly name: string,
    readonly args: readonly KField[],
    readonly result: KType,
  ) {}
}

export class KQueries {
  name: string | null = null;
  constructor(readonly queries: readonly KQuery[]) {}
}
