// utils //////////////////////////////////////////////////////////////////////

export function setdefault<T>(obj: Record<string, T>, key: string, dfault: T): T {
  if (key in obj) {
    return obj[key];
  } else {
    obj[key] = dfault;
    return dfault;
  }
}

const copySym = Symbol();

export function deepCopy<T>(base: T): T {
  switch (typeof base) {
    case "boolean":
    case "bigint":
    case "number":
    case "string":
    case "undefined":
      // these types are already immutable
      return base;

    case "object":
      // null handled here
      if (base === null) return base;
      // general objects handled below
      break;

    case "symbol":
    case "function":
    default:
      throw new Error(`base of type "${typeof base}" not handled by readOnly`);
  }

  // handle read-only and proxy objects in an efficient way
  const copier = (base as any)[copySym];
  if (copier) return copier();

  // object handling
  if (Array.isArray(base)) return [...base].map(deepCopy) as T;
  if (base instanceof Map) {
    const out = new Map();
    for (const [k, v] of base) out.set(k, deepCopy(v));
    return out as T;
  }
  if (base instanceof Set) return new Set(base) as T;  // object keys not allowed anyway
  if (base instanceof Date) return new Date(base) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, deepCopy(v)])) as T;
}

export function readOnly<T>(base: T): Readonly<T> {
  switch (typeof base) {
    case "boolean":
    case "bigint":
    case "number":
    case "string":
    case "undefined":
      // these types are already immutable
      return base;

    case "object":
      // null handled here
      if (base === null) return base;
      // general objects handled below
      break;

    case "symbol":
    case "function":
    default:
      throw new Error(`base of type "${typeof base}" not handled by readOnly`);
  }

  // object handling
  if (Array.isArray(base)) return readOnlyArray(base) as T;
  if (base instanceof Map) return readOnlyMap(base) as T;
  if (base instanceof Set) return readOnlySet(base) as T;
  if (base instanceof Date) return readOnlyDate(base) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return readOnlyObject(base as any) as T;
}

function throwReadOnlyError(): any {
  throw new Error("object is read-only and may not be modified");
}

function readOnlyObject<T>(base: Record<string, T>): Readonly<Record<string, T>> {
  const cache: Record<string, any> = {};

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,
    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop]);
        cache[prop] = value;
        return value;
      }

      let value = base[prop];

      if (value === undefined) {
        return value;
      }

      if (value instanceof Function) {
        return (...args: any[]) => value.apply(base, args);
      }

      const ro = readOnly(value);
      cache[prop] = ro;
      return ro;
    },
  });
}

function readOnlyArray<T>(base: T[]): Readonly<T[]> {
  const cache = Array(base.length);
  let filled = false;

  function dirty1(n: number): T | undefined {
    if (Object.hasOwn(cache, n)) return cache[n];
    if (!Object.hasOwn(base, n)) return undefined;
    const ro = readOnly(base[n]);
    cache[n] = ro;
    return ro;
  }

  function dirtyAll(){
    // all items at once
    if (filled) return cache;
    filled = true;
    for (const n of base.keys()) dirty1(n);
    return cache;
  }

  const roArrayMethods: any = {
    // special
    at: (index: number) => dirty1(index > -1 ? index : base.length + index),

    // things which require dirtyAll(), then run against the full shallow copy
    concat: (...args: any) => base.concat.apply(dirtyAll(), args),
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    every: (...args: any) => base.every.apply(dirtyAll(), args),
    filter: (...args: any) => base.filter.apply(dirtyAll(), args),
    find: (...args: any) => base.find.apply(dirtyAll(), args),
    findIndex: (...args: any) => base.findIndex.apply(dirtyAll(), args),
    findLast: (...args: any) => (base as any).findLast.apply(dirtyAll(), args),
    findLastIndex: (...args: any) => (base as any).findLastIndex.apply(dirtyAll(), args),
    flat: (...args: any) => base.flat.apply(dirtyAll(), args),
    flatMap: (...args: any) => base.flatMap.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    map: (...args: any) => base.map.apply(dirtyAll(), args),
    reduce: (...args: any) => base.reduce.apply(dirtyAll(), args),
    reduceRight: (...args: any) => base.reduceRight.apply(dirtyAll(), args),
    slice: (...args: any) => base.slice.apply(dirtyAll(), args),
    some: (...args: any) => base.some.apply(dirtyAll(), args),
    toReversed: (...args: any) => (base as any).toReversed.apply(dirtyAll(), args),
    toSorted: (...args: any) => (base as any).toSorted.apply(dirtyAll(), args),
    toSpliced: (...args: any) => (base as any).toSpliced.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    with: (...args: any) => (base as any).with.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // safe getters
    indexOf: (...args: any) => (base as any).indexOf(...args),
    join: (...args: any) => (base as any).join(...args),
    keys: (...args: any) => (base as any).keys(...args),
    lastIndexOf: (...args: any) => (base as any).lastIndexOf(...args),
    toLocaleString: (...args: any) => (base as any).toLocaleString(...args),
    toString: (...args: any) => (base as any).toString(...args),

    // disallowed
    push: throwReadOnlyError,
    pop: throwReadOnlyError,
    shift: throwReadOnlyError,
    reverse: throwReadOnlyError,
    copyWithin: throwReadOnlyError,
    fill: throwReadOnlyError,
    sort: throwReadOnlyError,
    splice: throwReadOnlyError,
    unshift: throwReadOnlyError,
  };

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      if (Object.hasOwn(cache, prop)) return cache[prop];
      if (Object.hasOwn(base, prop)) {
        const value = readOnly(base[prop]);
        cache[prop] = value;
        return value;
      }

      const method = roArrayMethods[prop];
      if (method) return method;

      return base[prop];
    },
  });
}

const roDatePrototype = {
  setDate: throwReadOnlyError,
  setFullYear: throwReadOnlyError,
  setHours: throwReadOnlyError,
  setMilliseconds: throwReadOnlyError,
  setMinutes: throwReadOnlyError,
  setMonth: throwReadOnlyError,
  setSeconds: throwReadOnlyError,
  setTime: throwReadOnlyError,
  setUTCDate: throwReadOnlyError,
  setUTCFullYear: throwReadOnlyError,
  setUTCHours: throwReadOnlyError,
  setUTCMilliseconds: throwReadOnlyError,
  setUTCMinutes: throwReadOnlyError,
  setUTCMonth: throwReadOnlyError,
  setUTCSeconds: throwReadOnlyError,
  setYear: throwReadOnlyError,
}
Object.setPrototypeOf(roDatePrototype, Date.prototype);

function readOnlyDate(base: Date): Readonly<Date> {
  // copy instead of proxy
  const out = new Date(base);
  Object.setPrototypeOf(out, roDatePrototype);
  return out;
}

function readOnlyMap<K, V>(base: Map<K, V>): Readonly<Map<K, Readonly<V>>> {
  const cache: Map<K, Readonly<V>> = new Map();
  let filled = false;

  function dirty1(k: K): V | undefined {
    if (filled || cache.has(k)) return cache.get(k);
    if (!base.has(k)) return undefined;
    const ro = readOnly(base.get(k)!);
    cache.set(k, ro);
    return ro;
  }

  function dirtyAll() {
    if (filled) return cache;
    filled = true;
    for (const k of base.keys()) {
      if (cache.has(k)) continue;
      cache.set(k, readOnly(base.get(k)!));
    }
    return cache;
  }

  const roMapMethods: any = {
    // special
    get: (key: any) => dirty1(key),

    // requires dirtyAll
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // passthru
    has: (...args: any[]) => (base as any).has(...args),
    keys: (...args: any[]) => (base as any).keys(...args),

    // mutators
    clear: throwReadOnlyError,
    delete: throwReadOnlyError,
    getOrInsert: throwReadOnlyError,
    getOrInsertComputed: throwReadOnlyError,
    set: throwReadOnlyError,
  };
  Object.setPrototypeOf(roMapMethods, null);

  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);
      const method = roMapMethods[prop];
      if (method) return method;

      return (base as any)[prop];
    },
  });
}

// no cache needed, since we don't support object keys and there are no values
function readOnlySet<K>(base: Set<K>): Readonly<Set<K>> {
  return new Proxy(base, {
    defineProperty: throwReadOnlyError,
    deleteProperty: throwReadOnlyError,
    set: throwReadOnlyError,

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(base);

      // just disallow mutations
      if (prop === "add" || prop === "delete") return throwReadOnlyError;

      const value = (base as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(base, args);
      }
      return value;
    },
  });
}

export function copyOnWrite<T>(base: T, parent?: () => void): T {
  switch (typeof base) {
    case "boolean":
    case "bigint":
    case "number":
    case "string":
    case "undefined":
      // these types are already immutable
      return base;

    case "object":
      // null handled here
      if (base === null) return base;
      if (base instanceof Date) return new Date(base) as T; // trivial copy
      // general objects handled below
      break;

    case "symbol":
    case "function":
    default:
      throw new Error(`base of type "${typeof base}" not handled by readOnly`);
  }

  // object handling
  if (Array.isArray(base)) return copyOnWriteArray(base, parent) as T;
  if (base instanceof Map) return copyOnWriteMap(base, parent) as T;
  if (base instanceof Set) return copyOnWriteSet(base, parent) as T;
  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  return copyOnWriteObject(base as any, parent) as T;
}

const recoverSym = Symbol();

export function recover<T>(base: T): T {
  switch (typeof base) {
    case "boolean":
    case "bigint":
    case "number":
    case "string":
    case "undefined":
      // leaf type found; nothing was cow
      return base;

    case "object":
      if (base === null) return base;
      if (base instanceof Date) return base;
      // general objects handled below
      break;

    case "symbol":
    case "function":
    default:
      throw new Error(`base of type "${typeof base}" not handled by readOnly`);
  }

  // check if object was returned by copyOnWrite; recover its inner value
  const rcvr: () => T = (base as any)[recoverSym];
  if (rcvr) return rcvr();

  // otherwise walk normal objects looking for anything that came out of a copyOnWrite.

  if (Array.isArray(base)) {
    for (const [i, item] of base.entries()) {
      const r = recover(item);
      if (r !== item) {
        base[i] = r;
      }
    }
    return base;
  }

  if (base instanceof Map) {
    for(const [key, value] of base.entries()) {
      const r = recover(value);
      if (r !== value) {
        base.set(key, r);
      }
    }
    return base;
  }

  // Set with non-primitive keys is not supported, so nothing to be checked
  if (base instanceof Set) return base;

  const proto = Object.getPrototypeOf(base);
  if (proto && proto !== Object.prototype) {
    throw new Error(`base has a nonstandard protoype`);
  }

  // plain objects
  for (const [key, value] of Object.entries(base)) {
    const r = recover(value);
    if (r !== value) {
      (base as any)[key] = r;
    }
  }
  return base as T;
}

const DELETED = Symbol("DELETED");

function copyOnWriteObject<T>(base: Record<string, T>, parent?: () => void): Record<string, T> {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache: Record<string, T | typeof DELETED> = {};
  let clean = true;
  let full = false;

  function mark() {
    if (clean) {
      clean = false;
      // dirty our parent too
      if (parent) parent();
    }
  }

  function copy() {
    if (clean) return deepCopy(base);
    const out: Record<string, T> = {};
    if (!full) {
      for (const [key, val] of Object.entries(base)) {
        if (!Object.hasOwn(cache, key)) out[key] = deepCopy(val);
      }
    }
    for (const [key, val] of Object.entries(cache)) {
      if (val !== DELETED) out[key] = deepCopy(val as T);
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    if (full) {
      const out: Record<string, T> = {};
      for (const [key, val] of Object.entries(cache)) {
        if (val !== DELETED) out[key] = recover(val);
      }
      return out;
    }
    // start with a shallow copy of base
    const out = { ...base };
    for (const [key, val] of Object.entries(cache)) {
      if (val === DELETED) {
        delete out[key];
      } else {
        out[key] = recover(val);
      }
    }
    return out;
  }

  return new Proxy(base, {
    defineProperty() {
      throw new Error("not supported by copyOnWrite");
    },

    deleteProperty(_, prop: any) {
      mark();
      cache[prop] = DELETED;
      return true;
    },

    getOwnPropertyDescriptor(_, prop: any) {
      if (cache[prop] === DELETED) return undefined;
      return Object.getOwnPropertyDescriptor(cache, prop) ??
        Object.getOwnPropertyDescriptor(base, prop);
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      // lookup value in cache first
      if (Object.hasOwn(cache, prop)) {
        const value = cache[prop];
        return value !== DELETED ? value : undefined;
      }
      // then get cacheable value from base
      if (Object.hasOwn(base, prop)) {
        const value = copyOnWrite(base[prop], mark);
        cache[prop] = value;
        return value;
      }

      const value = base[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      if (Object.hasOwn(cache, prop)) return cache[prop] !== DELETED;
      return prop in base;
    },

    ownKeys() {
      const out = [];
      for (const key of Object.keys(base)) {
        if (cache[key] === DELETED) continue;
        out.push(key);
      }
      for (const key of Object.keys(cache)) {
        if (Object.hasOwn(base, key)) continue;
        if (cache[key] !== DELETED) out.push(key);
      }
      return out;
    },

    set(_, prop: any, value: T) {
      mark();
      cache[prop] = value;
      return true;
    },
  });
}

function copyOnWriteArray<T>(base: T[], parent?: () => void): T[] {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache = Array<T | typeof DELETED>(base.length);
  let clean = true;
  let full = false;

  function mark() {
    if (clean) {
      clean = false;
      if (parent) parent();
    }
  }

  function dirty1(n: number){
    if (full) return cache[n];
    if (Object.hasOwn(cache, n)){
      const out = cache[n];
      return out !== DELETED ? out : undefined;
    }
    if (!Object.hasOwn(base, n)) return undefined;
    const ro = copyOnWrite(base[n]);
    cache[n] = ro;
    return ro;
  }

  function dirtyAll(){
    if (full) return cache;
    full = true;
    // use Object.keys() instead of .keys() to preserve holes
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(cache, key)) {
        cache[key as any] = copyOnWrite(base[key as any], mark);
      }
    }
    // to make things like iteration easy, we remove DELETED after we iterate
    for (const [key, value] of Object.entries(cache)) {
      if (value === DELETED) delete cache[key as any];
    }
    return cache;
  }

  const cowArrayMethods: any = {
    // special
    at: (index: number) => dirty1(index > -1 ? index : base.length + index),
    push: (...args: any[]) => cache.push(...args),


    // things which require dirtyAll(), then run against the full shallow copy
    concat: (...args: any) => base.concat.apply(dirtyAll(), args),
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    every: (...args: any) => base.every.apply(dirtyAll(), args),
    filter: (...args: any) => base.filter.apply(dirtyAll(), args),
    find: (...args: any) => base.find.apply(dirtyAll(), args),
    findIndex: (...args: any) => base.findIndex.apply(dirtyAll(), args),
    findLast: (...args: any) => (base as any).findLast.apply(dirtyAll(), args),
    findLastIndex: (...args: any) => (base as any).findLastIndex.apply(dirtyAll(), args),
    flat: (...args: any) => base.flat.apply(dirtyAll(), args),
    flatMap: (...args: any) => base.flatMap.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    map: (...args: any) => base.map.apply(dirtyAll(), args),
    reduce: (...args: any) => base.reduce.apply(dirtyAll(), args),
    reduceRight: (...args: any) => base.reduceRight.apply(dirtyAll(), args),
    slice: (...args: any) => base.slice.apply(dirtyAll(), args),
    some: (...args: any) => base.some.apply(dirtyAll(), args),
    toReversed: (...args: any) => (base as any).toReversed.apply(dirtyAll(), args),
    toSorted: (...args: any) => (base as any).toSorted.apply(dirtyAll(), args),
    toSpliced: (...args: any) => (base as any).toSpliced.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    with: (...args: any) => (base as any).with.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // mutators that require a dirtyAll() due to possible index changes
    pop: (...args: any) => base.pop.apply(dirtyAll(), args),
    reverse: (...args: any) => base.reverse.apply(dirtyAll(), args),
    copyWithin: (...args: any) => base.copyWithin.apply(dirtyAll(), args),
    fill: (...args: any) => base.fill.apply(dirtyAll(), args),
    sort: (...args: any) => base.sort.apply(dirtyAll(), args),
    splice: (...args: any) => base.splice.apply(dirtyAll(), args),
    unshift: (...args: any) => base.unshift.apply(dirtyAll(), args),

    // getters which don't HAVE to cowify the whole array, but would need something about as expensive
    toLocaleString: (...args: any) => base.toLocaleString.apply(dirtyAll(), args),
    toString: (...args: any) => base.toString.apply(dirtyAll(), args),
    join: (...args: any) => base.join.apply(dirtyAll(), args),

    // getters which work against cache as-is
    keys: () => cache.keys(),

    // getters which can operate on a frankenstein array where base is prototype of cache
    includes: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).includes(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
    indexOf: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).indexOf(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
    lastIndexOf: (...args: any) => {
      const old = Object.getPrototypeOf(cache);
      try {
        Object.setPrototypeOf(cache, base);
        return (cache as any).lastIndexOf(...args);
      } finally {
        Object.setPrototypeOf(cache, old);
      }
    },
  };
  Object.setPrototypeOf(cowArrayMethods, null);

  function copy() {
    if (clean) return deepCopy(base);
    if (full) return deepCopy(cache);
    const out = Array(cache.length);
    for (const [key, value] of Object.entries(base)) {
      if (!Object.hasOwn(cache, key)) out[key as any] = deepCopy(value);
    }
    for (const [key, value] of Object.entries(cache)) {
      if (value !== DELETED) out[key as any] = deepCopy(value);
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    if (full) {
      const out = Array(cache.length)
      for (const [key, val] of Object.entries(cache)) {
        out[key as any] = recover(val);
      }
      return out;
    }
    const out = Array(cache.length);
    for (const [key, val] of Object.entries(base)) {
      if (!Object.hasOwn(cache, key)) out[key as any] = val;
    }
    for (const [key, val] of Object.entries(cache)) {
      if (val !== DELETED) out[key as any] = recover(val);
    }
    return out;
  }

  return new Proxy(base, {
    defineProperty() {
      throw new Error("not supported by copyOnWrite");
    },

    deleteProperty(_, prop: any) {
      if (full) {
        delete cache[prop];
        return true;
      }
      mark();
      cache[prop] = DELETED;
      return true;
    },

    getOwnPropertyDescriptor(_, prop: any) {
      if (full) return Object.getOwnPropertyDescriptor(cache, prop);
      if (cache[prop] === DELETED) return undefined;
      return Object.getOwnPropertyDescriptor(cache, prop) ??
        Object.getOwnPropertyDescriptor(base, prop);
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      // special logic if we have no more DELETEDs in cache
      if (full) {
        if (Object.hasOwn(cache, prop)) {
          return cache[prop];
        }
        const method = cowArrayMethods[prop];
        if (method) return method;
        return cache[prop];
      }

      // lookup value in cache first
      if (Object.hasOwn(cache, prop)) {
        const value = cache[prop];
        return value !== DELETED ? value : undefined;
      }
      // then get cacheable value from base
      if (Object.hasOwn(base, prop)) {
        const value = copyOnWrite(base[prop], mark);
        cache[prop] = value;
        return value;
      }

      // get methods
      const method = cowArrayMethods[prop];
      if (method) return method;

      const value = base[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      if (full) return Object.hasOwn(cache, prop);
      if (Object.hasOwn(cache, prop)) return cache[prop] !== DELETED;
      return prop in base;
    },

    ownKeys() {
      if (full) return Object.getOwnPropertyNames(cache);
      const out = ["length"];
      for (const key of Object.keys(base)) {
        if (cache[key as any] === DELETED) continue;
        out.push(key);
      }
      for (const key of Object.keys(cache)) {
        if (Object.hasOwn(base, key)) continue;
        if (cache[key as any] !== DELETED) out.push(key);
      }
      return out;
    },

    set(_, prop: any, value: T) {
      mark();
      cache[prop] = value;
      return true;
    },
  });
}

function copyOnWriteMap<K, V>(base: Map<K, V>, parent?: () => void): Map<K, V> {
  // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
  const cache: Map<K, V | typeof DELETED> = new Map();
  let clean = true;
  let full = false;
  let ndeletions = 0;
  let noverlap = 0;

  function size() {
    if (full) return cache.size;
    return base.size + cache.size - ndeletions - noverlap;
  }

  function mark() {
    if (clean) {
      clean = false;
      if (parent) parent();
    }
  }

  function dirty1(k: K) {
    if (full) return cache.get(k);
    if (cache.has(k)) {
      const out = cache.get(k);
      return out !== DELETED ? out : undefined;
    }
    if (!base.has(k)) return undefined;
    const cow = copyOnWrite(base.get(k)!, mark);
    cache.set(k, cow);
    noverlap++;
    return cow;
  }

  function dirtyAll(){
    if (full) return cache;
    full = true;
    const deleted = new Set<K>();
    for (const [k, v] of cache) {
      if (v === DELETED) deleted.add(k);
    }
    for (const [k, v] of base) {
      if (!cache.has(k)) {
        cache.set(k, copyOnWrite(v, mark));
      }
    }
    for (const k of deleted) {
      cache.delete(k);
    }
    ndeletions = 0;
    return cache;
  }

  function copy() {
    if (clean) return deepCopy(base);
    if (full) return deepCopy(cache);
    const out = new Map();
    for (const [key, value] of base.entries()) {
      if (!cache.has(key)) out.set(key, deepCopy(value));
    }
    for (const [key, value] of cache.entries()) {
      if (value !== DELETED) out.set(key, deepCopy(value));
    }
    return out;
  }

  function rcvr() {
    // was any modification made?
    if (clean) return base;
    // did we already copy all keys and eliminate deletions?
    if (full) {
      const out = new Map();
      for (const [k, v] of cache) {
        out.set(k, recover(v));
      }
      return out;
    }
    // start with a shallow copy
    const out = new Map(base);
    for (const [k, v] of cache) {
      if (v === DELETED) {
        out.delete(k);
      } else {
        out.set(k, recover(v));
      }
    }
    return out;
  }

  let proxy: Map<K, V>;

  // create a one-off methods object, since we have a lot of stuff to bind into it
  const cowMapMethods: any = {
    // special
    get: (key: K) => dirty1(key),
    has: (key: K) => {
      if (full) return cache.has(key);
      if (cache.has(key)) {
        return cache.get(key) !== DELETED;
      }
      return base.has(key);
    },
    clear() {
      mark();
      full = true;
      return cache.clear();
    },

    // requires dirtyAll
    entries: (...args: any) => base.entries.apply(dirtyAll(), args),
    forEach: (...args: any) => base.forEach.apply(dirtyAll(), args),
    values: (...args: any) => base.values.apply(dirtyAll(), args),
    [Symbol.iterator]: (...args: any) => base[Symbol.iterator].apply(dirtyAll(), args),

    // mutators
    delete: (key: K) =>{
      if (full) return cache.delete(key);
      const old = cache.get(key);
      if (old === DELETED) return false; // noop; already marked as deleted
      const incache = old !== undefined || cache.has(key);
      if (!base.has(key)) {
        // key not in base: is it newly added to cache, or totally missing?
        if (!incache) return false;
        cache.delete(key);
        return true;
      }
      // key is in base; add a new deletion marker
      cache.set(key, DELETED);
      ndeletions++;
      if (!incache) {
        noverlap++;
        mark();
      }
      return true;
    },
    getOrInsert: (key: K, defaultValue: V) => {
      let old = cache.get(key);
      if (old === DELETED) {
        // undelete a deleted key
        cache.set(key, defaultValue);
        ndeletions--;
        return defaultValue;
      }
      if (old !== undefined || cache.has(key)) return old;
      // not in cache; check base
      old = base.get(key);
      if (old !== undefined || base.has(key)) return old;
      // not in base either; do an insert
      cache.set(key, defaultValue);
      return defaultValue;
    },
    getOrInsertComputed: (key: K, callback: (key: K) => V) => {
      let old = cache.get(key);
      if (old === DELETED) {
        // undelete a deleted key
        const value = callback(key);
        cache.set(key, value);
        ndeletions--;
        return value;
      }
      if (old !== undefined || cache.has(key)) return old;
      // not in cache; check base
      old = base.get(key);
      if (old !== undefined || base.has(key)) return old;
      // not in base either; do an insert
      const value = callback(key);
      cache.set(key, value);
      return value;
    },
    set: (key: K, value: V) => {
      mark();
      const old = cache.get(key);
      if (old === DELETED) ndeletions--;
      const incache = old !== undefined || cache.has(key);
      if (!incache && base.has(key)) noverlap++;
      cache.set(key, value);
      // don't return the cache or the base; return the copy-on-write proxy
      return proxy;
    },
  };
  Object.setPrototypeOf(cowMapMethods, null);

  proxy = new Proxy(base, {
    defineProperty() {
      throw new Error("not supported by copyOnWrite");
    },

    deleteProperty() {
      throw new Error("not supported by copyOnWriteMap");
    },

    getOwnPropertyDescriptor() {
      throw new Error("not supported by copyOnWriteMap");
    },

    set() {
      throw new Error("not supported by copyOnWriteMap");
    },

    get(_, prop: any) {
      if (prop === copySym) return copy;
      if (prop === recoverSym) return rcvr;

      if (prop === "size") return size();

      // get methods
      const method = cowMapMethods[prop];
      if (method) return method;

      const value = (base as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache, args);
      }
      return value;
    },

    has(_, prop: any) {
      // we don't support custom own properties or prototypes, so this is sufficient
      return prop in cache;
    },

    ownKeys() {
      // we don't support custom own properties
      return [];
    },
  });

  return proxy;
}

function copyOnWriteSet<K>(base: Set<K>, parent?: () => void) {
  // since we have no child cow objects, as soon as we get an update we do a full copy and use that
  let cache: Set<K> | undefined = undefined;

  return new Proxy(base, {
    defineProperty() {
      throw new Error("not supported by copyOnWrite");
    },

    deleteProperty() {
      throw new Error("not supported by copyOnWriteSet");
    },

    getOwnPropertyDescriptor() {
      throw new Error("not supported by copyOnWriteSet");
    },

    set() {
      throw new Error("not supported by copyOnWriteSet");
    },

    get(_, prop: any) {
      if (prop === copySym) return () => deepCopy(cache ?? base);
      if (prop === recoverSym) return () => cache ?? base;

      if (prop === "add" || prop === "delete") {
        if (cache === undefined) {
          // break the glass
          cache = new Set(base);
          if(parent) parent();
        }
      }

      const value = ((cache ?? base) as any)[prop];
      if (value instanceof Function) {
        return (...args: any) => value.apply(cache ?? base, args);
      }
      return value;
    },

    has(_, prop: any) {
      // we don't support custom own properties or prototypes, so this is sufficient
      return prop in (cache as any);
    },

    ownKeys(_) {
      // we don't support custom own properties
      return [];
    },
  });
}

// futures ////////////////////////////////////////////////////////////////////

/* A Future is a function that yields nothing, is woken up with nothing, and eventually returns T */
export type Future<T> = Generator<void, T, void>;

/* A FutureContext corresponds to the first generator in our callstack.  Though it may be delegating
   yields to some child generator through yield* statements, when a condition is met to wake up the
   child, the .next() has to be sent to the root generator, not the child (or grandchild).

   FutureContext makes that trivial. */
export class FutureContext {
  #coro: Generator;
  #awake: boolean = false;

  constructor(coro: Generator) {
    this.#coro = coro;
  }

  wakeup() {
    // disallow calls to the base wakeup from inside the base wakeup
    if (this.#awake) return;
    this.#awake = true;
    try {
      this.#coro.next();
    } finally {
      this.#awake = false;
    }
  }

  throw(e: Error) {
    // if we're actually inside the coro, throw the error now
    if (this.#awake) throw(e);
    this.#awake = true;
    try {
      this.#coro.throw(e);
    } finally {
      this.#awake = false;
    }
  }
}

// storage ////////////////////////////////////////////////////////////////////

// an indexeddb-compatible, transactional key-value store built around generators.
//
// A note about typing: the Storage interface must receive a value with .set() and return the same
// type value with .get().  It must not matter which implementation of Storage is in use.  However,
// most of the access to storage is untyped.  So storage cannot get() and set() the real proto
// values.  Instead, a Storage implementation which stores anywhere other than in-memory must do
// the type-to-storage conversion internally.  Then any generated typed getters built around the
// Storage interface shall be merely typecasting wrappers.

// Storage is the interface for creating read and write transasctions.  An implementation of Storage
// is callback-based and should support multiple parallel gets and sets at the API level, even if
// they must be serialized internally.  The runTxn function is used to convert the callback
// interface of WTxn and RTxn to the StorageGenerator protocol.
export interface Storage {
  withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T>;
  withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T>;
}

export type StorageValue = {value: unknown} | {err: Error};
export type StorageDone = {value: true} | {err: Error};

export interface WTxn {
  get(key: string, cb: (result: StorageValue) => void): void;
  set(key: string, value: unknown, cb: (result: StorageDone) => void): void;
  del(key: string, cb: (result: StorageDone) => void): void;
};

export interface RTxn {
  get(key: string, cb: (result: StorageValue) => void): void;
  set(key: string, value: unknown, cb: (result: StorageDone) => void): void;
  del(key: string, cb: (result: StorageDone) => void): void;
};

export type WStorageQuestion = {
  // keys to look up
  get?: Record<string, true>,
  // key-values to set
  set?: Record<string, unknown>,
  // key-values to delete
  del?: Record<string, true>,
};

export type RStorageQuestion = {
  // keys to look up
  get?: Record<string, true>,
};

export type StorageAnswer = {
  // key-value lookup results
  get: Record<string, StorageValue>,
  // keys done setting
  set: Record<string, StorageDone>,
  // keys done deleting
  del: Record<string, StorageDone>,
};

export type WStorageGenerator<T> = Generator<WStorageQuestion, T, StorageAnswer>;
export type RStorageGenerator<T> = Generator<RStorageQuestion, T, StorageAnswer>;

// function to interact with the StorageGenerator
export function *txnGet(key: string): RStorageGenerator<unknown>{
  const ans = (yield {"get": {[key]: true}}).get[key];
  if ("err" in ans) {
    throw ans.err;
  }
  return ans.value;
}

// a function to interact with the StorageGenerator
export function *txnSet(key: string, value: unknown): WStorageGenerator<void> {
  const ans = (yield {"set": {[key]: value}}).set[key];
  if ("err" in ans) {
    throw ans.err;
  }
}

// a function to interact with the StorageGenerator
export function *txnDel(key: string): WStorageGenerator<void> {
  const ans = (yield {"del": {[key]: true}}).del[key];
  if ("err" in ans) {
    throw ans.err;
  }
}

// a function to hide some of the boilerplate of opening a WTxn
export function *withWTxn<T>(
  fx: FutureContext, s: Storage, fn: () => WStorageGenerator<T>,
): Future<T> {
  return yield* s.withWTxn(fx, function*(txn){
    return yield* runTxn(fx, txn, fn());
  });
}

// a function to hide some of the boilerplate of opening a RTxn
export function *withRTxn<T>(
  fx: FutureContext, s: Storage, fn: () => RStorageGenerator<T>,
): Future<T> {
  return yield* s.withRTxn(fx, function*(txn){
    return yield* runTxn(fx, txn, fn());
  });
}

// run a StorageGenerator to completion, converting potentially many parallel callbacks into a
// generator interface.
function *runTxn<T>(
  fx: FutureContext, txn: WTxn, g: WStorageGenerator<T>,
): Future<T> {
  // ignore late callbacks
  let valid = true;
  try {
    let ans: StorageAnswer = {get: {}, set: {}, del: {}};
    let ready = false;
    while (true) {
      const {value, done} = g.next(ans);
      if (done) return value;

      ans = {get: {}, set: {}, del: {}};
      ready = false;

      // start gets
      for (const key of Object.keys(value.get ?? {})) {
        txn.get(key, (result) => {
          if (!valid) return;  // ignore late callback
          ans.get[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // start sets
      for (const [key, val] of Object.entries(value.set ?? {})) {
        txn.set(key, val, (result) => {
          if (!valid) return;  // ignore late callback
          ans.set[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // start deletes
      for (const key of Object.keys(value.del ?? {})) {
        txn.del(key, (result) => {
          if (!valid) return;  // ignore late callback
          ans.del[key] = result;
          ready = true;
          fx.wakeup();
        });
      }

      // wait for a result
      while (!ready) yield;
    }
  } finally {
    valid = false;
  }
}

type StorageCoders = {
  encoder: (key: string, val: unknown) => unknown,
  decoder: (key: string, val: unknown) => unknown,
};

export class IndexedDBStorage {
  #db: IDBDatabase;
  #store: string;
  #coders: StorageCoders;

  constructor(db: IDBDatabase, store: string, coders: StorageCoders) {
    this.#db = db;
    this.#store = store;
    this.#coders = coders
  }

  *#withTxn<T>(
    fx: FutureContext, mode: IDBTransactionMode, fn: (txn: WTxn) => Future<T>,
  ): Future<T> {
    // create the transaction
    let ready = false;
    const txn = this.#db.transaction([this.#store], mode);
    txn.onerror = (/*event*/) => {
      // nobody to send the error to, so just crash the coroutine
      fx.throw(new Error("txn failed"));
    };
    txn.onabort = (/*event*/) => {
      ready = true;
      fx.wakeup();
    };
    txn.oncomplete = (/*event*/) => {
      ready = true;
      fx.wakeup();
    };
    const store = txn.objectStore(this.#store);
    const indexedDBTxn = new IndexedDBTxn(store, this.#coders);

    // run the user function
    let result: T;
    try {
      result = yield* fn(indexedDBTxn);
    } catch (e: unknown) {
      txn.abort();
      while (!ready) yield;
      throw e;
    }
    txn.commit();
    while (!ready) yield;
    return result;
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, "readwrite", fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, "readonly", fn);
  }
}

class IndexedDBTxn {
  #store: IDBObjectStore;
  #coders: StorageCoders;

  constructor(store: IDBObjectStore, coders: StorageCoders) {
    this.#store = store;
    this.#coders = coders;
  }

  get(key: string, cb: (result: StorageValue) => void): void {
    const req = this.#store.get(key);
    req.onsuccess = () => {
      cb({value: this.#coders.decoder(key, req.result)});
    };
    req.onerror = () => {
      cb({err: new Error(`failed to look up "${key}"`)});
    };
  }

  set(key: string, value: unknown, cb: (result: StorageDone) => void): void {
    const req = this.#store.put(this.#coders.encoder(key, value), key);
    req.onsuccess = () => {
      cb({value: true});
    };
    req.onerror = () => {
      cb({err: new Error(`failed to set "${key}"`)});
    };
  }

  del(key: string, cb: (result: StorageDone) => void): void {
    const req = this.#store.delete(key);
    req.onsuccess = () => {
      cb({value: true});
    };
    req.onerror = () => {
      cb({err: new Error(`failed to delete "${key}"`)});
    };
  }
}

// InMemoryStorage does not require any StorageCoders because it never encodes or decodes.
export class InMemStorage {
  #data: Record<string, unknown> ;

  constructor(data?: Record<string, unknown>) {
    this.#data = data !== undefined ? data : {};
  }

  *#withTxn<T>(fn: (txn: WTxn) => Future<T>): Future<T> {
    const updates: Record<string, unknown> = {};
    const txn = new InMemTxn(this.#data, updates);
    // abort case is that we don't catch the exception here:
    const result = yield* fn(txn);
    // commit case
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) {
        delete this.#data[key];
      } else {
        this.#data[key] = val;
      }
    }
    return result;
  }

  *withWTxn<T>(_fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fn);
  }

  *withRTxn<T>(_fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fn);
  }
}

class InMemTxn {
  #data: Record<string, unknown>;
  #updates: Record<string, unknown>;

  constructor(data: Record<string, unknown>, updates: Record<string, unknown>) {
    this.#data = data;
    this.#updates = updates;
  }

  get(key: string, cb: (result: StorageValue) => void): void {
    if (key in this.#updates) {
      cb({value: this.#updates[key]});
    } else {
      cb({value: this.#data[key]});
    }
  }

  set(key: string, value: unknown, cb: (result: StorageDone) => void): void {
    this.#updates[key] = value;
    cb({value: true});
  }

  del(key: string, cb: (result: StorageDone) => void): void {
    this.#updates[key] = undefined;
    cb({value: true});
  }
}

export class OverlayStorage {
  #base: Storage;
  #data: Record<string, unknown> = {};

  constructor(base: Storage) {
    this.#base = base;
  }

  keys(): string[] {
    return Object.keys(this.#data);
  }

  *#withTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
    const self = this;
    return yield* this.#base.withRTxn(fx, function*(baseTxn){
      const updates: Record<string, unknown> = {};
      const txn = new OverlayTxn(baseTxn, self.#data, updates);
      // abort case is that we don't catch the exception here:
      const result = yield* fn(txn);
      // commit case
      for (const [key, val] of Object.entries(updates)) {
        // note: we must keep undefined values rather than propagate deletions to base
        self.#data[key] = val;
      }
      return result;
    });
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, fn);
  }
}

class OverlayTxn {
  #base: RTxn;
  #data: Record<string, unknown>;
  #updates: Record<string, unknown>

  constructor(base: RTxn, data: Record<string, unknown>, updates: Record<string, unknown>) {
    this.#base = base;
    this.#data = data;
    this.#updates = updates;
  }

  get(key: string, cb: (result: StorageValue) => void): void {
    if (key in this.#updates) {
      cb({value: this.#updates[key]});
    } else if (key in this.#data) {
      cb({value: this.#data[key]});
    } else {
      this.#base.get(key, cb);
    }
  }

  set(key: string, value: unknown, cb: (result: StorageDone) => void): void {
    this.#updates[key] = value;
    cb({value: true});
  }

  del(key: string, cb: (result: StorageDone) => void): void {
    this.#updates[key] = undefined;
    cb({value: true});
  }
}

//

/* ExternalCallbackStorage implements storage entirely via callback functions. */
export class ExternalCallbackStorage {
  #txn: (writable: boolean, cb: (result: StorageValue) => void) => unknown;
  #commit: (txn: unknown, cb: (result: StorageDone) => void) => void;
  #abort: (txn: unknown, cb: () => void) => void;
  #get: (txn: unknown, key: string, cb: (result: StorageValue) => void) => void;
  #set: (txn: unknown, key: string, value: unknown, cb: (result: StorageDone) => void) => void;
  #del: (txn: unknown, key: string, cb: (result: StorageDone) => void) => void;

  constructor(
    // txn returns an opaque value that gets passed to the other callbacks
    txn: (writable: boolean, cb: (result: StorageValue) => void) => unknown,
    // commit commits a transaction, or returns an error.
    commit: (txn: unknown, cb: (result: StorageDone) => void) => void,
    // abort aborts the transaction.  It is not allowed to return an error.
    abort: (txn: unknown, cb: () => void) => void,
    // get gets a value
    get: (txn: unknown, key: string, cb: (result: StorageValue) => void) => void,
    // set sets a value
    set: (txn: unknown, key: string, value: unknown, cb: (result: StorageDone) => void) => void,
    // del deletes a value
    del: (txn: unknown, key: string, cb: (result: StorageDone) => void) => void,
  ) {
    this.#txn = txn;
    this.#commit = commit;
    this.#abort = abort;
    this.#get = get;
    this.#set = set;
    this.#del = del;
  }

  *#withTxn<T>(
    fx: FutureContext, writable: boolean, fn: (txn: WTxn) => Future<T>,
  ): Future<T> {
    // create the transaction
    let txnVal: unknown;
    let txnReady = false;
    this.#txn(writable, (result) => {
      if ("err" in result) {
        fx.throw(result.err);
      } else {
        txnVal = result.value;
        txnReady = true;
        fx.wakeup();
      }
    });
    while (!txnReady) yield;

    const txn: WTxn = {
      get: (key: string, cb: (result: StorageValue) => void) => {
        return this.#get(txnVal, key, cb);
      },
      set: (key: string, value: unknown, cb: (result: StorageDone) => void) => {
        return this.#set(txnVal, key, value, cb);
      },
      del: (key: string, cb: (result: StorageDone) => void) => {
        return this.#del(txnVal, key, cb);
      }
    };

    let result: T;
    try {
      result = yield* fn(txn);
    } catch (e: unknown) {
      // abort and re-throw error
      let abortReady = false;
      this.#abort(txnVal, () => {
        abortReady = true;
        fx.wakeup();
      })
      while(!abortReady) yield;
      throw e;
    }

    // try to commit
    let commitReady = false;
    this.#commit(txnVal, (result) => {
      if ("err" in result) {
        fx.throw(result.err);
      } else {
        commitReady = true;
        fx.wakeup();
      }
    });
    while (!commitReady) yield;

    return result;
  }

  *withWTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, true, fn);
  }

  *withRTxn<T>(fx: FutureContext, fn: (txn: RTxn) => Future<T>): Future<T> {
    return yield* this.#withTxn(fx, false, fn);
  }
}

// reducers /////////////////////////////////////////////////////////////////

export type ReducerQuestion = {
  // keys to look up
  old?: Record<string, true>,
  // keys to look up
  get?: Record<string, true>,
  // key-values to set
  set?: Record<string, unknown>,
  // key-values to delete
  del?: Record<string, true>,
};

export type ReducerAnswer = {
  old: Record<string, StorageValue>,
  // key-value lookup results
  get: Record<string, StorageValue>,
  // keys done setting
  set: Record<string, StorageDone>,
  // keys done deleting
  del: Record<string, StorageDone>,
};

export type Reducer<T> = Generator<ReducerQuestion, T, ReducerAnswer>;
// ReducerContext looks like:
// yield* rx.set.project(key, val): set new value (you only get to set it once per txn)
// yield* rx.get.project(key): get the current value for key, possibly setting it from old
// yield* rx.old.project(key): explicitly get the old value for key

// wrap a Reducer so it acts like a WStorageGenerator, returning a set of updated keys
export function *runReducer(g: Reducer<void>, simulate?: boolean): WStorageGenerator<string[]> {
  // our cache of get's we've already completed
  const old: Record<string, unknown> = Object.create(null);
  // our planned sets and dels that we submit at the end
  const cur: Record<string, unknown> = Object.create(null);

  function *finish(): WStorageGenerator<string[]> {
    const updates = [];
    const question: WStorageQuestion = {get: {}, set: {}, del: {}};
    for (const [k, v] of Object.entries(cur)) {
      // de-copyOnWrite-ify the value
      const r = recover(v);
      // get the old value
      const o = old[k];
      // detect noop
      if (r === o) continue;
      // otherwise write the value to storage
      updates.push(k);
      if (r === DELETED) {
        question.del![k] = true;
      } else {
        question.set![k] = r;
      }
    }
    // is there any storage updates to make?
    if (updates.length === 0 || simulate) return updates;
    let nupdated = 0;
    while (nupdated < updates.length) {
      // actually yield the write request to storage
      const ans = yield question;
      // check every result
      for (const [k, v] of Object.entries(ans.set ?? {})) {
        if ("err" in v) throw new Error(`setting "${k}" after reducer: ${v.err}`)
        nupdated++;
      }
      for (const [k, v] of Object.entries(ans.del ?? {})) {
        if ("err" in v) throw new Error(`deleting "${k}" after reducer: ${v.err}`)
        nupdated++;
      }
    }
    return updates;
  }

  let ans: ReducerAnswer = {old: {}, get: {}, set: {}, del: {}};
  // inflight is for gets we have submitted but haven't received
  // (you can have many olds or gets in flight simultaneously, but only one set, and it cannot be
  //  simultaneous with any gets)
  let inflight: Record<string, true> = {};
  // pending is for answers we're trying to deliver
  // {key: pending_ops}
  let pending: Record<string, {old?: true, get?: true}> = {};
  let storageQuestion: WStorageQuestion = {get: {}, set: {}, del: {}};

  // run the reducer to completion
  while (true) {
    let ready = true;
    while (ready) {
      const {value, done} = g.next(ans);
      if (done) return yield* finish();

      ans = {old: {}, get: {}, set: {}, del: {}};
      ready = false;

      for (const key of Object.keys(value.old ?? {})) {
        if (key in old) {
          // we already know this one
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.old[key] = {value: old[key]};
          ready = true;
        } else if (!inflight[key]) {
          inflight[key] = true;
          storageQuestion.get![key] = true;
          setdefault(pending, key, {}).old = true;
        }
      }

      for (const key of Object.keys(value.get ?? {})) {
        if (key in cur) {
          // value was already set
          // TODO: let copyOnWrite() fork an existing copyOnWrite object, so we don't have to
          //       materialize the updated object until we call finish()
          const cached = cur[key];
          ans.get[key] = {value: recover(cached !== DELETED ? cached : undefined)};
          ready = true;
        } else if (key in old) {
          // we looked this up before
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.get[key] = {value: old[key]};
          ready = true;
        } else if (!inflight[key]) {
          inflight[key] = true;
          storageQuestion.get![key] = true;
          setdefault(pending, key, {}).get = true;
        }
      }

      for (const [key, val] of Object.entries(value.set ?? {})) {
        // just store this in memory for now
        cur[key] = val;
        ans.set[key] = {value: true};
        ready = true;
      }

      for (const key of Object.keys(value.del ?? {})) {
        // just store this in memory for now
        cur[key] = DELETED;
        ans.del[key] = {value: true};
        ready = true;
      }
    }

    // interact with storage until we have an answer to return to the reducers
    while (!ready) {
      const storageAnswer = yield storageQuestion;
      storageQuestion = {get: {}, set: {}, del: {}};

      for (const [key, val] of Object.entries(storageAnswer.get)) {
        // cache successful results
        if ("value" in val) old[key] = val.value;
        // done with this query
        delete inflight[key];
        const pnd = pending[key];
        // why did we need this again?
        if (pnd.old) {
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.old[key] = val;
          ready = true;
        }
        if (pnd.get) {
          // note that copyOnWrite() is applied inside the ReducerContext; not here
          ans.get[key] = val;
          ready = true;
        }
        delete pending[key];
      }
    }
  }
}

// queries ////////////////////////////////////////////////////////////////////

/* Example query for loading all comments in a topic:

      let myTopic = ...;
      const q = framework.newQuery(function*(qx: QX) => {
        const uuids = yield* qx.get.topicComments(myTopic);
        const comments = {};
        const toplevels = [];
        for (const uuid of uuids) {
          comments[uuid] = yield* qx.get.comments(uuid);
          if (!comment.parent) toplevels.push(uuid);
        }
        return {comments, toplevels};
      })
*/

// user-facing query api
export interface Query<T> {
  // latest holds the most recent value passed to subscribe callback.  It is updated immediately
  // after subscribe callbacks are made, on a per-Query basis.
  latest: T | undefined;
  // awaitResult has no effect when executed outside of a query function
  awaitResult(): QueryGenerator<T>
  // subscribe returns an unsubscribe function
  subscribe(callback: (val: T) => void): () => void;
  // start will start the query, if it wasn't created with start=true.  This is mostly for wrappers
  // written in other languages, where the event-loop will be managed automatically, and the caller
  // needs a way to create the query and subscribe to it before letting it run the first time.
  start(): void;
  // close will stop the query from running again.
  // Dependent queries which are not also closed will start crashing.
  close(): void;
}

export type QueryQuestion = {
  // which keys to look up in storage
  store?: Record<string, true>,
  // which query ids to await their result
  query?: Record<string, true>,
};

export type QueryAnswer = {
  // the value for each storage lookup
  store: Record<string, StorageValue>,
  // the [result, dirty] for each asked query
  query: Record<string, [unknown, boolean]>,
};

export type QueryGenerator<T> = Generator<QueryQuestion, T, QueryAnswer>;

export type QueryFunction<QX, T> = (qx: QX, prev: T | undefined, prevIsValid: boolean) => QueryGenerator<T>;

// graph-facing api, which hides typing info from the graph
interface QueryWrapper<QX> {
  // the id of this query
  id: string;
  closed: boolean; // TODO: somehow use this to fail dependent queries after a query is closed
  // returns `[result, dirty]` indicating if the result and if it changed
  run(qx: QX, commitKeys: Record<string, true>): QueryGenerator<[unknown, boolean]>;
  // call subscribers with the latest result
  notify(): void;
}

class _Query<QX, T> {
  id: string;
  latest: T | undefined = undefined;
  closed: boolean = false;

  #subs: ((val: T) => void)[] = [];

  // {key: true}
  #keyDeps: Record<string, true> = {};
  // {query_id: true}
  #queryDeps: Record<string, true> = {};
  #runs: number = 0;
  #result: T | undefined = undefined;
  #fn: (qx: QX, prev: T | undefined, prevIsValid: boolean) => QueryGenerator<T>;
  #onStart: (() => void) | undefined;

  constructor(id: string, fn: QueryFunction<QX, T>, onStart: () => void) {
    this.id = id;
    this.#fn = fn;
    this.#onStart = onStart;
  }

  // part of public api
  *awaitResult(): QueryGenerator<T> {
    if (this.#onStart) {
      throw new Error("cannot await result of unstarted Query");
    }
    // don't try to coordinate our own #result vaule with the graph being executed; just use this as
    // an idiomatic way to ask the graph run for the result from our .id.
    const ans = yield {query: {[this.id]: true}};
    const [result] = ans.query[this.id];
    return result as T;
  }

  // part of public api
  subscribe(callback: (val: T) => void): () => void {
    this.#subs.push(callback);
    return () => {
      this.#subs = this.#subs.filter((x) => x !== callback);
    };
  }

  start(): void {
    if (this.closed) {
      throw new Error("call to Query.start() on closed query");
    }
    if (this.#onStart) {
      this.#onStart();
      this.#onStart = undefined
    }
  }

  // part of public api
  close(): void {
    this.closed = true;
  }

  *#shouldSkip(commitKeys: Record<string, true>): QueryGenerator<boolean> {
    if (this.#runs === 1) {
      // this is our first time; always run
      return false;
    }

    // check if a key dependency was updated
    for (const key of Object.keys(this.#keyDeps)) {
      if (key in commitKeys) return false;
    }

    // check if any query dependency changed its result
    for (const qid of Object.keys(this.#queryDeps)) {
      const ans = yield {"query": {[qid]: true}};
      const [, dirty] = ans["query"][qid];
      if (dirty) return false;
    }

    return true;
  }

  // part of graph api
  *run(qx: QX, commitKeys: Record<string, true>): QueryGenerator<[unknown, boolean]> {
    // shift current values to old values
    const oldResult = this.#result;
    this.#runs++;

    if (yield* this.#shouldSkip(commitKeys)) {
      return [this.#result, false]
    }

    // rebuild deps
    this.#keyDeps = {};
    this.#queryDeps = {};

    const g = this.#fn(qx, oldResult, this.#runs > 1);
    let ans: QueryAnswer = {query: {}, store: {}};
    // run query function to completion
    while (true) {
      // pass the current answer to the coroutine
      const {value, done} = g.next(ans);
      if (done) {
        this.#result = value;
        const dirty = (this.#runs === 1) || (this.#result !== oldResult);
        return [this.#result, dirty];
      }
      // capture dependencies before yielding up to the graph for answers
      // {store: {storage_key: true}, query: {query_id: true}}
      for (const key of Object.keys(value.store ?? {})) {
        this.#keyDeps[key] = true;
      }
      for (const qid of Object.keys(value.query ?? {})) {
        this.#queryDeps[qid] = true;
      }
      // let the graph provide answers
      ans = yield value;
    }
  }

  // part of graph api
  notify(): void {
    if (this.closed) return;
    for (const sub of this.#subs) {
      sub(this.#result!);
    }
    this.latest = this.#result;
  }
}

/* GraphRun represents one run of the QueryGraph.  Having it as a separate object rather than a
   single generator function (as it once was written) allows a graph to be extended if new queries
   arrive */
class GraphRun<QX> {
  #qx: QX;
  // {key: true}
  #commitKeys: Record<string, true>;

  // the [result, dirty] of queries which have ran
  // {query_id: [value, dirty]}
  #ran: Record<string, [unknown, boolean]> = {};

  constructor(qx: QX, commitKeys: Record<string, true>) {
    this.#qx = qx;
    this.#commitKeys = commitKeys;
  }

  // Run the query graph to completion.
  //
  // run() may be called once after construction against all existing queries, then may be called
  // additional times as new queries are added to the QueryGraph.
  // yields: list of keys, returns callback for users, receives: map of keys to values
  *run(queries: QueryWrapper<QX>[]): RStorageGenerator<() => void> {
    // freeze current query list, in case our caller ever gives us something they intend to mutate
    queries = [...queries];

    // every query which is currently running
    // {query_id: generator}
    const active: Record<string, QueryGenerator<[unknown, boolean]>> = {};
    // a record of {query_id: answer} to feed to coroutines
    let runnable: Record<string, QueryAnswer> = {};
    // which queries are unblocked by a given answer
    // {answer_key: query_id[]}
    const wantAnswers: Record<string, string[]> = {};
    // which queries are unblocked by a given query result
    // {query_id: query_id[]}
    const wantResults: Record<string, string[]> = {};

    // start every query in parallel
    for (const q of queries) {
      const g = q.run(this.#qx, this.#commitKeys);
      active[q.id] = g;
      // provide a phony first answer to start the generator off
      runnable[q.id] = {store: {}, query: {}};
    }

    // run the graph to completion
    while (true) {
      // run runnables until we run out; each runnable may unlock other runnables
      while (true) {
        const answers = Object.entries(runnable);
        if (answers.length === 0) break;
        runnable = {};
        for (const [qid, ans] of answers) {
          const {value, done} = active[qid].next(ans);
          if (done) {
            // query finished
            delete active[qid];
            const result = value;
            this.#ran[qid] = result;
            // unblock anybody waiting for this result
            const waiting = wantResults[qid];
            if (waiting !== undefined) {
              delete wantResults[qid];
              for (const id of waiting) {
                setdefault(runnable, id, {query: {}, store: {}}).query[qid] = result;
              }
            }
            continue;
          }
          // query is blocked; handle its store and query questions
          for (const key of Object.keys(value.store ?? {})) {
            setdefault(wantAnswers, key, []).push(qid);
          }
          for (const id of Object.keys(value.query ?? {})) {
            // has this query ran yet?
            if (id in this.#ran) {
              // we already have this result
              setdefault(runnable, qid, {query: {}, store: {}}).query[id] = this.#ran[id];
            } else {
              // wake this query up when the other query finishes
              setdefault(wantResults, id, []).push(qid);
            }
          }
        }
      }

      // are we all done?
      if (Object.keys(active).length === 0) break;

      // send all pending questions to storage
      const gets: Record<string, true> = {};
      for (const key of Object.keys(wantAnswers)) {
        gets[key] = true;
      }
      const answers = (yield {get: gets}).get;

      // process answers
      const answerEntries = Object.entries(answers);
      if (answerEntries.length === 0) {
        throw new Error("empty answer");
      }
      for (const [key, value] of answerEntries){
        for (const qid of wantAnswers[key]) {
          setdefault(runnable, qid, {query: {}, store: {}}).store[key] = value;
        }
        delete wantAnswers[key];
      }
    }

    // return a callback to notify query subscribers
    return () => {
      for (const q of queries) {
        const [,dirty] = this.#ran[q.id];
        if (dirty) q.notify();
      }
    };
  }
}

/* QueryGraph is responsible for tracking queries generated by the UI and rerunning them when new
   data is present.  It tracks dependencies of a query function by injecting a query context, which
   provides the actual key-value lookup capability to the function.  It is informed of changes to
   storage by the Midend, such as some keys being updated by the UI, keys of an old overlay being
   discarded, or new forecast data from the UI itself. */
export class QueryGraph<QX> {
  #qx: QX;
  #dirty: Record<string, true> = {};
  #queries: Record<string, QueryWrapper<QX>> = {};
  #newQueries: QueryWrapper<QX>[] = [];
  #id: number = 1;

  #run: GraphRun<QX>;

  constructor(qx: QX) {
    this.#qx = qx;
    // start with an empty graphrun
    this.#run = new GraphRun(this.#qx, {});
  }

  newQuery<T>(fn: QueryFunction<QX, T>, manualStart: boolean, onStart: () => void): Query<T> {
    const id = `${this.#id++}`;
    const q = new _Query(id, fn, () => {
      onStart();
      this.#queries[id] = q;
      this.#newQueries.push(q);
    });
    if (!manualStart) q.start();
    return q;
  }

  dirty(keys: string[]): void {
    for (const key of keys) {
      this.#dirty[key] = true;
    }
  }

  *run(): RStorageGenerator<() => void> {
    // start a new graph run
    const commitKeys = this.#dirty;
    this.#dirty = {};
    this.#run = new GraphRun(this.#qx, commitKeys);

    // run against all queries
    const queries = Object.values(this.#queries);
    this.#newQueries = [];
    return yield* this.#execute(queries);
  }

  *extend(): RStorageGenerator<() => void> {
    // extend an existing graph run with only new queries
    const queries = this.#newQueries;
    this.#newQueries = [];
    return yield* this.#execute(queries);
  }

  *#execute(queries: QueryWrapper<QX>[]): RStorageGenerator<() => void> {
    /* TODO: put a graph-wide storage cache here.  We can keep a new cache and an old cache.  When
       the new cache is hit we return it immediately.  When the old cache is hit, we pop from old,
       place in new, then return.  When we start a new graph run we discard the old old, make the
       old new into the new old, and create a new, empty new.   We'll need something like the
       while loop in GraphRun to return partial answers until we are fully blocked.

       Additional ideas might be:
         - grant individual lookups a cache control flag (true/false/undefined)
         - allow configuring the graph-wide query default cache disposition (true/false)
         - maybe a frequent use cache mode, where we track stats of key lookup usage and cache
           the most frequently used keys
         - nah, just let the cache be a configurable extra layer.  Too many ways to do it.
         - probably force yourself to skip this for now.
    */
    return yield* this.#run.run(queries);
  }
}

// frameworks /////////////////////////////////////////////////////////////////

// check"p"oint
// "R"educerConte"x"t
// "Q"ueryConte"x"t
// "E"vents
// "C"ommands
export class Framework<QX, RX, E, C, P> {
  #rx: RX;
  #storage: Storage;
  #migrate: null | ((rx: RX) => Reducer<void>);
  #reducer: (rx: RX, events: E[]) => Reducer<void>;
  #forecaster: null | ((commands: C[]) => E[]);
  #forecastKey: null | ((event: E) => string);
  #onCommands: null | ((commands: C[], onSent: ()=> void) => void);

  #live: boolean = false;
  #setLive: boolean = false;
  #overlay: OverlayStorage;
  #graph: QueryGraph<QX>;
  #coro: Generator<void, void, void>;
  #fx: FutureContext;

  #scheduled: boolean = false;
  #commandId: number = 0;

  // #reconnects is a list of promise resolve functions
  #reconnects: ((value: {checkpoint: P | undefined, commands: C[]}) => void)[] = [];
  #recvdEvents: E[] = [];
  #checkpoint: P | undefined = undefined;
  #recvdCommands: C[] = [];
  #sentCommands: string[] = [];
  #forecasts: Map<string, E> = new Map();
  // just a flag if new queries exist to be run; we don't store them here for typing purposes.
  #newQueries: boolean = false;
  #simulates: (() => Reducer<void>)[] = [];

  constructor(
    qx: QX,
    rx: RX,
    storage: Storage,
    callbacks: {
      // optional: configure storage before any events arrive
      migrate?: (rx: RX) => Reducer<void>,
      // required: reduce a batch of events into the read model
      reducer: (rx: RX, events: E[]) => Reducer<void>,
      // optional: forecast the events a server will send for a command
      forecaster?: (commands: C[]) => E[],
      // required if using forecaster: create a unique forecast key for an event; used to create a
      // map of forecast events and to invalidate the forecasted event when the real event arrives
      forecastKey?: (event: E) => string,
      // required if using sendCommands: receive events to send on the wire and a callback to signal
      // when that succeeded
      onCommands?: (commands: C[], onSent: ()=> void)=> void,
    },
  ) {
    this.#rx = rx;
    this.#storage = storage;
    this.#migrate = callbacks.migrate ?? null;
    this.#reducer = callbacks.reducer;
    this.#forecaster = callbacks.forecaster ?? null;
    this.#forecastKey = callbacks.forecastKey ?? null;
    this.#onCommands = callbacks.onCommands ?? null;
    if (this.#forecaster && !this.#forecastKey) {
      throw new Error("forecastKey is required if forecast is set");
    }

    this.#overlay = new OverlayStorage(this.#storage);
    this.#graph = new QueryGraph(qx);

    this.#coro = this.#advancer();
    this.#fx = new FutureContext(this.#coro);
    // let the advancer begin initializing
    this.#fx.wakeup();
  }

  //// public api ////

  // request info needed to resume a connection: last committed checkpoint and unsent commands
  reconnect(cb: (result: {checkpoint: P | undefined, commands: C[]}) => void): void {
    this.#reconnects.push(cb);
    this.#schedule();
  }

  // new events from the wire come here
  recvEvents(events: E[], checkpoint: P): void {
    this.#recvdEvents.push.apply(this.#recvdEvents, events);
    this.#checkpoint = checkpoint;
    this.#schedule();
  }

  fellBehind(): void {
    this.#setLive = false;
    this.#schedule();
  }

  caughtUp(): void {
    this.#setLive = true;
    this.#schedule();
  }

  // after forecasting and saving to storage, these will appear in an onCommands() callback
  sendCommands(commands: C[]): void {
    if (!this.#onCommands) {
      throw new Error("sendCommands() used but onCommands callback was not set");
    }
    this.#recvdCommands.push.apply(commands);
    this.#schedule();
  }

  // add a new Query to the graph
  newQuery<T>(fn: QueryFunction<QX, T>, manualStart?: boolean): Query<T> {
    return this.#graph.newQuery(fn, manualStart ?? false, () => {
      this.#newQueries = true;
      this.#schedule();
    });
  }

  simulate<T>(fn: (rx: RX) => Reducer<T>, cb: (result: T) => void): void {
    const self = this;
    this.#simulates.push(function*() {
      cb(yield* fn(self.#rx));
    });
    this.#schedule();
  }

  //// end of public api ////

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.#fx.wakeup();
    });
  }

  *#initialize(): Generator<void, void, void> {
    const self = this;

    // run migration logic on the data store
    if (self.#migrate) {
      yield* withWTxn(this.#fx, this.#storage, function*() {
        yield* runReducer(self.#migrate!(self.#rx));
        // ignore updated keys and don't trigger a run of the graph
      });
    }

    // reload forecasted state
    if (!this.#forecaster) return;

    // load unset commands from storage, along with the highest-yet command id
    const commands: C[] = [];
    this.#commandId = yield* withRTxn(this.#fx, this.#storage, function*() {
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      let maxId = 0;
      for (const idstr of Object.keys(index)) {
        const id = Number(idstr);
        if(id > maxId) maxId = id;
        // TODO: convert from json for typed return value
        const batch = yield* txnGet(`.command-${idstr}`)
        commands.push.apply(batch);
      }
      return maxId;
    });
    if (commands.length === 0) return;

    // forecast events
    const forecasts = this.#forecaster(commands);
    if (forecasts.length === 0) return;

    // remember these forecasts for later
    for (const forecast of forecasts) {
      const key = this.#forecastKey!(forecast);
      this.#forecasts.set(key, forecast);
    }

    // populate the initial overlay
    yield* withWTxn(this.#fx, this.#overlay, function*() {
      yield* runReducer(self.#reducer(self.#rx, forecasts));
      // ignore updated keys and don't trigger a run of the graph
    });
  }

  // our main logic is implemented as a coroutine
  *#advancer(): Generator<void, void, void> {
    yield* this.#initialize();

    // what are the different things we can have to do?
    // - receive events,
    //     - then shape them,
    //     - then pass shaped events into reducers,
    //     - then commit that result along with the checkpoint,
    //     - then take the commit and pass it to the query graph
    // - recieve sentCommands and update commands in storage
    // - receive sendCommands
    //     - then commit them to storage,
    //         - then send those to onCommand hook
    //     - then forecast events,
    //     - then pass them to reducers,
    //     - then commit that result to the overlay
    //     - then pass that commit to the query graph
    // - recieve a new query
    //     - extend the graph
    // - recieve a reconnect request
    //     - then return the checkpoint in storage
    while(true){
      if (this.#live && !this.#setLive) {
        // we fell behind; freeze graph and overlay, and when caughtUp() is called, we'll process
        // all changes from now until then with a single run of the graph
        this.#live = false;
      }

      if (this.#recvdEvents.length > 0) {
        yield* this.#onRecvEvents();
        continue;
      }

      if (!this.#live && this.#setLive) {
        // we caught up, and processed all recvdEvents(); time to restart the query graphs
        this.#live = true;
        yield* this.#rebuildOverlay();
        continue;
      }

      if (this.#recvdCommands.length > 0) {
        yield* this.#onSendCommands();
        continue;
      }

      if (this.#sentCommands.length > 0) {
        yield* this.#onSentCommands();
        continue;
      }

      if (this.#newQueries && this.#live) {
        yield* this.#onNewQueries();
        continue;
      }

      if (this.#reconnects.length > 0) {
        yield* this.#onReconnects();
        continue;
      }

      if (this.#simulates.length > 0) {
        yield* this.#onSimulates();
        continue;
      }

      // if we got here we probably had a spurious wakeup, or perhaps a newQuery() while not #live
      yield
    }
  }

  *#onRecvEvents(): Generator<void, void, void> {
    const self = this;
    // take events and latest checkpoint
    const events = this.#recvdEvents;
    const checkpoint = this.#checkpoint as P;
    this.#recvdEvents = [];
    this.#checkpoint = undefined;

    // open a write txn to real storage
    // IDEA: what if we wrote a txn wrapper that could automatically allow high-value gets/sets to
    // happen in between the normal gets/sets?
    const updates = yield* withWTxn(this.#fx, this.#storage, function*(){
      // update our checkpoint when this txn finishes
      yield* txnSet(".checkpoint", checkpoint);

      // run the reducer with our new events
      return yield* runReducer(self.#reducer(self.#rx, events));
    })
    this.#graph.dirty(updates);

    // discard now-irrelevant forecasts
    if (this.#forecasts.size > 0) {
      for (const event of events) {
        const key = this.#forecastKey!(event);
        this.#forecasts.delete(key);
      }
    }

    if (this.#live) {
      yield* this.#rebuildOverlay();
    }
  }

  *#rebuildOverlay(): Generator<void, void, void> {
    const self = this;

    // discard old overlay, start a new one
    this.#graph.dirty(this.#overlay.keys());
    this.#overlay = new OverlayStorage(this.#storage);

    // rebuild overlay using all forecasts
    if (this.#forecasts.size > 0) {
      const updates = yield* withWTxn(this.#fx, this.#overlay, function*(){
        return yield* runReducer(self.#reducer(self.#rx, [...self.#forecasts.values()]));
      });
      self.#graph.dirty(updates);
    }

    const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
      // this will run all queries, even new ones
      self.#newQueries = false;
      return yield* self.#graph.run();
    });
    cbs();
  }

  *#onSendCommands(): Generator<void, void, void> {
    const self = this;
    const commands = this.#recvdCommands;
    this.#recvdCommands = [];

    const id = `${++this.#commandId}`;

    // open a write txn to real storage
    yield* withWTxn(this.#fx, this.#storage, function*(){
      // save a batch of commands
      // TODO: convert to json for untyped access
      yield* txnSet(`.command-${id}`, commands);
      // extend the index of batches
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      yield* txnSet(".commands", {...index, [id]: true});
    });

    // define a hook to trigger cleanup when those commands are actually sent
    const onSent = () => {
      this.#sentCommands.push(id);
      this.#schedule();
    };

    // now forecast events based on those commands
    if (this.#forecaster) {
      const forecasts = this.#forecaster(commands);
      if (forecasts.length > 0) {
        // remember these forecasts for later
        for (const forecast of forecasts) {
          const key = this.#forecastKey!(forecast);
          this.#forecasts.set(key, forecast);
        }

        if (this.#live) {
          // open a write txn against the existing overlay
          const updates = yield* withWTxn(this.#fx, this.#overlay, function*(){
            return yield* runReducer(self.#reducer(self.#rx, forecasts));
          });
          this.#graph.dirty(updates);

          const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
            // this will run all queries, even new ones
            self.#newQueries = false;
            return yield* self.#graph.run();
          });
          cbs();
        }
      }
    }

    // schedule a callback for the user to know it is time to send the commands
    setTimeout(() => this.#onCommands!(commands, onSent));
  }

  *#onSentCommands(): Generator<void, void, void> {
    const self = this;
    yield* withWTxn(this.#fx, this.#storage, function*(){
      // load the index of batches of commands
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      // delete any batches we know to be sent
      let id;
      while ((id = self.#sentCommands.shift())) {
        yield* txnDel(`.command-${id}`);
        delete index[id];
      }
      // update the index
      yield* txnSet(".commands", index);
    });
  }

  *#onNewQueries(): Generator<void, void, void> {
    const self = this;
    const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
      self.#newQueries = false;
      return yield* self.#graph.extend();
    });
    cbs();
  }

  *#onReconnects(): Generator<void, void, void> {
    const {checkpoint, commands} = yield* withRTxn(this.#fx, this.#storage, function*(){
      const checkpoint = (yield* txnGet(".checkpoint")) as (P | undefined);
      const commands: C[] = [];
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      for (const id of Object.keys(index)) {
        // TODO: convert from json for typed return value
        const batch = yield* txnGet(`.command-${id}`)
        commands.push.apply(batch);
      }
      return {checkpoint, commands};
    });
    for (const resolve of this.#reconnects) {
      resolve({checkpoint, commands});
    }
    this.#reconnects = [];
  }

  *#onSimulates(): Generator<void, void, void> {
    const simulates = this.#simulates;
    this.#simulates = [];
    // use a single read txn for all simulations, since runReducer() with simulate=true doesn't write
    yield* withRTxn(this.#fx, this.#storage, function*() {
      for (const fn of simulates) {
        yield* runReducer(fn(), true);
      }
    });
  }
}

// end of skeleton ////////////////////////////////////////////////////////////
