// utils //////////////////////////////////////////////////////////////////////
// json_typeof returns the json type of a value that came out of parsing json
// (so 'undefined' is not handled, since it isn't allowed in json)
function setdefault(obj, key, dfault) {
    if (key in obj) {
        return obj[key];
    }
    else {
        obj[key] = dfault;
        return dfault;
    }
}
const NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
// generateUuid is either injected into the environment or we expect to use crypto.getRandomValues()
if (!globalThis.generateUuid) {
    var generateUuid = function () {
        let out = '';
        // Get 128 bits of randomness.
        const values = new Uint8Array(16);
        crypto.getRandomValues(values);
        // rfc4122 compliance: type 4 uuid
        values[6] = 0x40 | (values[6] & 0x0f);
        values[8] = 0x80 | (values[8] & 0x3f);
        values.forEach((x) => {
            out += NIBBLE[x >>> 4] + NIBBLE[x & 0x0f];
        });
        return [
            out.substring(0, 8),
            out.substring(8, 12),
            out.substring(12, 16),
            out.substring(16, 20),
            out.substring(20, 32),
        ].join('-');
    };
}
function EncodeProto(base) {
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
            if (base === null)
                return base;
            // general objects handled below
            break;
        case "symbol":
        case "function":
        default:
            throw new Error(`base of type "${typeof base}" not handled by EncodeProto`);
    }
    // check if object has toJSON()
    if (base.toJSON)
        return base.toJSON();
    if (Array.isArray(base))
        return base.map(EncodeProto);
    if (base instanceof Map)
        return [...base.entries()].map(EncodeProto);
    if (base instanceof Set)
        return [...base.keys()]; // object keys not supported
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, EncodeProto(v)]));
}
const copySym = Symbol();
function deepCopy(base) {
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
            if (base === null)
                return base;
            // general objects handled below
            break;
        case "symbol":
        case "function":
        default:
            throw new Error(`base of type "${typeof base}" not handled by deepCopy`);
    }
    // handle read-only and proxy objects in an efficient way
    const copier = base[copySym];
    if (copier)
        return copier();
    // object handling
    if (Array.isArray(base))
        return [...base].map(deepCopy);
    if (base instanceof Map) {
        const out = new Map();
        for (const [k, v] of base)
            out.set(k, deepCopy(v));
        return out;
    }
    if (base instanceof Set)
        return new Set(base); // object keys not allowed anyway
    if (base instanceof Date)
        return new Date(base);
    const proto = Object.getPrototypeOf(base);
    if (proto && proto !== Object.prototype) {
        throw new Error(`base has a nonstandard protoype`);
    }
    return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, deepCopy(v)]));
}
function readOnly(base) {
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
            if (base === null)
                return base;
            // general objects handled below
            break;
        case "symbol":
        case "function":
        default:
            throw new Error(`base of type "${typeof base}" not handled by readOnly`);
    }
    // object handling
    if (Array.isArray(base))
        return readOnlyArray(base);
    if (base instanceof Map)
        return readOnlyMap(base);
    if (base instanceof Set)
        return readOnlySet(base);
    if (base instanceof Date)
        return readOnlyDate(base);
    const proto = Object.getPrototypeOf(base);
    if (proto && proto !== Object.prototype) {
        throw new Error(`base has a nonstandard protoype`);
    }
    return readOnlyObject(base);
}
function throwReadOnlyError() {
    throw new Error("object is read-only and may not be modified");
}
function readOnlyObject(base) {
    const cache = {};
    return new Proxy(base, {
        defineProperty: throwReadOnlyError,
        deleteProperty: throwReadOnlyError,
        set: throwReadOnlyError,
        get(_, prop) {
            if (prop === copySym)
                return () => deepCopy(base);
            if (Object.hasOwn(cache, prop))
                return cache[prop];
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
                return (...args) => value.apply(base, args);
            }
            const ro = readOnly(value);
            cache[prop] = ro;
            return ro;
        },
    });
}
function readOnlyArray(base) {
    const cache = Array(base.length);
    let filled = false;
    function dirty1(n) {
        if (Object.hasOwn(cache, n))
            return cache[n];
        if (!Object.hasOwn(base, n))
            return undefined;
        const ro = readOnly(base[n]);
        cache[n] = ro;
        return ro;
    }
    function dirtyAll() {
        // all items at once
        if (filled)
            return cache;
        filled = true;
        for (const n of base.keys())
            dirty1(n);
        return cache;
    }
    const roArrayMethods = {
        // special
        at: (index) => dirty1(index > -1 ? index : base.length + index),
        // things which require dirtyAll(), then run against the full shallow copy
        concat: (...args) => base.concat.apply(dirtyAll(), args),
        entries: (...args) => base.entries.apply(dirtyAll(), args),
        every: (...args) => base.every.apply(dirtyAll(), args),
        filter: (...args) => base.filter.apply(dirtyAll(), args),
        find: (...args) => base.find.apply(dirtyAll(), args),
        findIndex: (...args) => base.findIndex.apply(dirtyAll(), args),
        findLast: (...args) => base.findLast.apply(dirtyAll(), args),
        findLastIndex: (...args) => base.findLastIndex.apply(dirtyAll(), args),
        flat: (...args) => base.flat.apply(dirtyAll(), args),
        flatMap: (...args) => base.flatMap.apply(dirtyAll(), args),
        forEach: (...args) => base.forEach.apply(dirtyAll(), args),
        map: (...args) => base.map.apply(dirtyAll(), args),
        reduce: (...args) => base.reduce.apply(dirtyAll(), args),
        reduceRight: (...args) => base.reduceRight.apply(dirtyAll(), args),
        slice: (...args) => base.slice.apply(dirtyAll(), args),
        some: (...args) => base.some.apply(dirtyAll(), args),
        toReversed: (...args) => base.toReversed.apply(dirtyAll(), args),
        toSorted: (...args) => base.toSorted.apply(dirtyAll(), args),
        toSpliced: (...args) => base.toSpliced.apply(dirtyAll(), args),
        values: (...args) => base.values.apply(dirtyAll(), args),
        with: (...args) => base.with.apply(dirtyAll(), args),
        [Symbol.iterator]: (...args) => base[Symbol.iterator].apply(dirtyAll(), args),
        // safe getters
        indexOf: (...args) => base.indexOf(...args),
        join: (...args) => base.join(...args),
        keys: (...args) => base.keys(...args),
        lastIndexOf: (...args) => base.lastIndexOf(...args),
        toLocaleString: (...args) => base.toLocaleString(...args),
        toString: (...args) => base.toString(...args),
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
        get(_, prop) {
            if (prop === copySym)
                return () => deepCopy(base);
            if (Object.hasOwn(cache, prop))
                return cache[prop];
            if (Object.hasOwn(base, prop)) {
                const value = readOnly(base[prop]);
                cache[prop] = value;
                return value;
            }
            const method = roArrayMethods[prop];
            if (method)
                return method;
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
};
Object.setPrototypeOf(roDatePrototype, Date.prototype);
function readOnlyDate(base) {
    // copy instead of proxy
    const out = new Date(base);
    Object.setPrototypeOf(out, roDatePrototype);
    return out;
}
function readOnlyMap(base) {
    const cache = new Map();
    let filled = false;
    function dirty1(k) {
        if (filled || cache.has(k))
            return cache.get(k);
        if (!base.has(k))
            return undefined;
        const ro = readOnly(base.get(k));
        cache.set(k, ro);
        return ro;
    }
    function dirtyAll() {
        if (filled)
            return cache;
        filled = true;
        for (const k of base.keys()) {
            if (cache.has(k))
                continue;
            cache.set(k, readOnly(base.get(k)));
        }
        return cache;
    }
    const roMapMethods = {
        // special
        get: (key) => dirty1(key),
        // requires dirtyAll
        entries: (...args) => base.entries.apply(dirtyAll(), args),
        forEach: (...args) => base.forEach.apply(dirtyAll(), args),
        values: (...args) => base.values.apply(dirtyAll(), args),
        [Symbol.iterator]: (...args) => base[Symbol.iterator].apply(dirtyAll(), args),
        // passthru
        has: (...args) => base.has(...args),
        keys: (...args) => base.keys(...args),
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
        get(_, prop) {
            if (prop === copySym)
                return () => deepCopy(base);
            const method = roMapMethods[prop];
            if (method)
                return method;
            return base[prop];
        },
    });
}
// no cache needed, since we don't support object keys and there are no values
function readOnlySet(base) {
    return new Proxy(base, {
        defineProperty: throwReadOnlyError,
        deleteProperty: throwReadOnlyError,
        set: throwReadOnlyError,
        get(_, prop) {
            if (prop === copySym)
                return () => deepCopy(base);
            // just disallow mutations
            if (prop === "add" || prop === "delete" || prop === "clear")
                return throwReadOnlyError;
            const value = base[prop];
            if (value instanceof Function) {
                return (...args) => value.apply(base, args);
            }
            return value;
        },
    });
}
function copyOnWrite(base, parent) {
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
            if (base === null)
                return base;
            if (base instanceof Date)
                return new Date(base); // trivial copy
            // general objects handled below
            break;
        case "symbol":
        case "function":
        default:
            throw new Error(`base of type "${typeof base}" not handled by copyOnWrite`);
    }
    // object handling
    if (Array.isArray(base))
        return copyOnWriteArray(base, parent);
    if (base instanceof Map)
        return copyOnWriteMap(base, parent);
    if (base instanceof Set)
        return copyOnWriteSet(base, parent);
    const proto = Object.getPrototypeOf(base);
    if (proto && proto !== Object.prototype) {
        throw new Error(`base has a nonstandard protoype`);
    }
    return copyOnWriteObject(base, parent);
}
const recoverSym = Symbol();
function recover(base) {
    switch (typeof base) {
        case "boolean":
        case "bigint":
        case "number":
        case "string":
        case "undefined":
            // leaf type found; nothing was cow
            return base;
        case "object":
            if (base === null)
                return base;
            if (base instanceof Date)
                return base;
            // general objects handled below
            break;
        case "symbol":
        case "function":
        default:
            throw new Error(`base of type "${typeof base}" not handled by recover`);
    }
    // check if object was returned by copyOnWrite; recover its inner value
    const rcvr = base[recoverSym];
    if (rcvr)
        return rcvr();
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
        for (const [key, value] of base.entries()) {
            const r = recover(value);
            if (r !== value) {
                base.set(key, r);
            }
        }
        return base;
    }
    // Set with non-primitive keys is not supported, so nothing to be checked
    if (base instanceof Set)
        return base;
    const proto = Object.getPrototypeOf(base);
    if (proto && proto !== Object.prototype) {
        throw new Error(`base has a nonstandard protoype`);
    }
    // plain objects
    for (const [key, value] of Object.entries(base)) {
        const r = recover(value);
        if (r !== value) {
            base[key] = r;
        }
    }
    return base;
}
const DELETED = Symbol("DELETED");
function copyOnWriteObject(base, parent) {
    // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
    const cache = {};
    let clean = true;
    function mark() {
        if (clean) {
            clean = false;
            // dirty our parent too
            if (parent)
                parent();
        }
    }
    function copy() {
        if (clean)
            return deepCopy(base);
        const out = {};
        {
            for (const [key, val] of Object.entries(base)) {
                if (!Object.hasOwn(cache, key))
                    out[key] = deepCopy(val);
            }
        }
        for (const [key, val] of Object.entries(cache)) {
            if (val !== DELETED)
                out[key] = deepCopy(val);
        }
        return out;
    }
    function rcvr() {
        // was any modification made?
        if (clean)
            return base;
        // start with a shallow copy of base
        const out = { ...base };
        for (const [key, val] of Object.entries(cache)) {
            if (val === DELETED) {
                delete out[key];
            }
            else {
                out[key] = recover(val);
            }
        }
        return out;
    }
    return new Proxy(base, {
        defineProperty() {
            throw new Error("not supported by copyOnWrite");
        },
        deleteProperty(_, prop) {
            mark();
            cache[prop] = DELETED;
            return true;
        },
        getOwnPropertyDescriptor(_, prop) {
            if (cache[prop] === DELETED)
                return undefined;
            return Object.getOwnPropertyDescriptor(cache, prop) ??
                Object.getOwnPropertyDescriptor(base, prop);
        },
        get(_, prop) {
            if (prop === copySym)
                return copy;
            if (prop === recoverSym)
                return rcvr;
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
                return (...args) => value.apply(cache, args);
            }
            return value;
        },
        has(_, prop) {
            if (Object.hasOwn(cache, prop))
                return cache[prop] !== DELETED;
            return prop in base;
        },
        ownKeys() {
            const out = [];
            for (const key of Object.keys(base)) {
                if (cache[key] === DELETED)
                    continue;
                out.push(key);
            }
            for (const key of Object.keys(cache)) {
                if (Object.hasOwn(base, key))
                    continue;
                if (cache[key] !== DELETED)
                    out.push(key);
            }
            return out;
        },
        set(_, prop, value) {
            mark();
            cache[prop] = value;
            return true;
        },
    });
}
function copyOnWriteArray(base, parent) {
    // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
    const cache = Array(base.length);
    let clean = true;
    let full = false;
    function mark() {
        if (clean) {
            clean = false;
            if (parent)
                parent();
        }
    }
    function dirty1(n) {
        if (full)
            return cache[n];
        if (Object.hasOwn(cache, n)) {
            const out = cache[n];
            return out !== DELETED ? out : undefined;
        }
        if (!Object.hasOwn(base, n))
            return undefined;
        const ro = copyOnWrite(base[n]);
        cache[n] = ro;
        return ro;
    }
    function dirtyAll() {
        if (full)
            return cache;
        full = true;
        // use Object.keys() instead of .keys() to preserve holes
        for (const key of Object.keys(base)) {
            if (!Object.hasOwn(cache, key)) {
                cache[key] = copyOnWrite(base[key], mark);
            }
        }
        // to make things like iteration easy, we remove DELETED after we iterate
        for (const [key, value] of Object.entries(cache)) {
            if (value === DELETED)
                delete cache[key];
        }
        return cache;
    }
    const cowArrayMethods = {
        // special
        at: (index) => dirty1(index > -1 ? index : base.length + index),
        push: (...args) => (mark(), cache.push(...args)),
        // things which require dirtyAll(), then run against the full shallow copy
        concat: (...args) => base.concat.apply(dirtyAll(), args),
        entries: (...args) => base.entries.apply(dirtyAll(), args),
        every: (...args) => base.every.apply(dirtyAll(), args),
        filter: (...args) => base.filter.apply(dirtyAll(), args),
        find: (...args) => base.find.apply(dirtyAll(), args),
        findIndex: (...args) => base.findIndex.apply(dirtyAll(), args),
        findLast: (...args) => base.findLast.apply(dirtyAll(), args),
        findLastIndex: (...args) => base.findLastIndex.apply(dirtyAll(), args),
        flat: (...args) => base.flat.apply(dirtyAll(), args),
        flatMap: (...args) => base.flatMap.apply(dirtyAll(), args),
        forEach: (...args) => base.forEach.apply(dirtyAll(), args),
        map: (...args) => base.map.apply(dirtyAll(), args),
        reduce: (...args) => base.reduce.apply(dirtyAll(), args),
        reduceRight: (...args) => base.reduceRight.apply(dirtyAll(), args),
        slice: (...args) => base.slice.apply(dirtyAll(), args),
        some: (...args) => base.some.apply(dirtyAll(), args),
        toReversed: (...args) => base.toReversed.apply(dirtyAll(), args),
        toSorted: (...args) => base.toSorted.apply(dirtyAll(), args),
        toSpliced: (...args) => base.toSpliced.apply(dirtyAll(), args),
        values: (...args) => base.values.apply(dirtyAll(), args),
        with: (...args) => base.with.apply(dirtyAll(), args),
        [Symbol.iterator]: (...args) => base[Symbol.iterator].apply(dirtyAll(), args),
        // mutators that require a dirtyAll() due to possible index changes
        pop: (...args) => (mark(), base.pop.apply(dirtyAll(), args)),
        reverse: (...args) => (mark(), base.reverse.apply(dirtyAll(), args)),
        copyWithin: (...args) => (mark(), base.copyWithin.apply(dirtyAll(), args)),
        fill: (...args) => (mark(), base.fill.apply(dirtyAll(), args)),
        sort: (...args) => (mark(), base.sort.apply(dirtyAll(), args)),
        splice: (...args) => (mark(), base.splice.apply(dirtyAll(), args)),
        shift: (...args) => (mark(), base.shift.apply(dirtyAll(), args)),
        unshift: (...args) => (mark(), base.unshift.apply(dirtyAll(), args)),
        // getters which don't HAVE to cowify the whole array, but would need something about as expensive
        toLocaleString: (...args) => base.toLocaleString.apply(dirtyAll(), args),
        toString: (...args) => base.toString.apply(dirtyAll(), args),
        join: (...args) => base.join.apply(dirtyAll(), args),
        // getters which work against cache as-is
        keys: () => cache.keys(),
        // getters which can operate on a frankenstein array where base is prototype of cache
        includes: (...args) => {
            const old = Object.getPrototypeOf(cache);
            try {
                Object.setPrototypeOf(cache, base);
                return cache.includes(...args);
            }
            finally {
                Object.setPrototypeOf(cache, old);
            }
        },
        indexOf: (...args) => {
            const old = Object.getPrototypeOf(cache);
            try {
                Object.setPrototypeOf(cache, base);
                return cache.indexOf(...args);
            }
            finally {
                Object.setPrototypeOf(cache, old);
            }
        },
        lastIndexOf: (...args) => {
            const old = Object.getPrototypeOf(cache);
            try {
                Object.setPrototypeOf(cache, base);
                return cache.lastIndexOf(...args);
            }
            finally {
                Object.setPrototypeOf(cache, old);
            }
        },
    };
    Object.setPrototypeOf(cowArrayMethods, null);
    function copy() {
        if (clean)
            return deepCopy(base);
        if (full)
            return deepCopy(cache);
        const out = Array(cache.length);
        for (const [key, value] of Object.entries(base)) {
            if (!Object.hasOwn(cache, key))
                out[key] = deepCopy(value);
        }
        for (const [key, value] of Object.entries(cache)) {
            if (value !== DELETED)
                out[key] = deepCopy(value);
        }
        return out;
    }
    function rcvr() {
        // was any modification made?
        if (clean)
            return base;
        if (full) {
            const out = Array(cache.length);
            for (const [key, val] of Object.entries(cache)) {
                out[key] = recover(val);
            }
            return out;
        }
        const out = Array(cache.length);
        for (const [key, val] of Object.entries(base)) {
            if (!Object.hasOwn(cache, key))
                out[key] = val;
        }
        for (const [key, val] of Object.entries(cache)) {
            if (val !== DELETED)
                out[key] = recover(val);
        }
        return out;
    }
    return new Proxy(base, {
        defineProperty() {
            throw new Error("not supported by copyOnWrite");
        },
        deleteProperty(_, prop) {
            if (full) {
                if (Object.hasOwn(base, prop))
                    mark();
                delete cache[prop];
                return true;
            }
            mark();
            cache[prop] = DELETED;
            return true;
        },
        getOwnPropertyDescriptor(_, prop) {
            if (full)
                return Object.getOwnPropertyDescriptor(cache, prop);
            if (cache[prop] === DELETED)
                return undefined;
            return Object.getOwnPropertyDescriptor(cache, prop) ??
                Object.getOwnPropertyDescriptor(base, prop);
        },
        get(_, prop) {
            if (prop === copySym)
                return copy;
            if (prop === recoverSym)
                return rcvr;
            // special logic if we have no more DELETEDs in cache
            if (full) {
                if (Object.hasOwn(cache, prop)) {
                    return cache[prop];
                }
                const method = cowArrayMethods[prop];
                if (method)
                    return method;
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
            if (method)
                return method;
            const value = base[prop];
            if (value instanceof Function) {
                return (...args) => value.apply(cache, args);
            }
            return value;
        },
        has(_, prop) {
            if (full)
                return Object.hasOwn(cache, prop);
            if (Object.hasOwn(cache, prop))
                return cache[prop] !== DELETED;
            return prop in base;
        },
        ownKeys() {
            if (full)
                return Object.getOwnPropertyNames(cache);
            const out = ["length"];
            for (const key of Object.keys(base)) {
                if (cache[key] === DELETED)
                    continue;
                out.push(key);
            }
            for (const key of Object.keys(cache)) {
                if (Object.hasOwn(base, key))
                    continue;
                if (cache[key] !== DELETED)
                    out.push(key);
            }
            return out;
        },
        set(_, prop, value) {
            mark();
            cache[prop] = value;
            return true;
        },
    });
}
function copyOnWriteMap(base, parent) {
    // build our cache incrementally, to reduce the number of copyOnWrite calls to a minimum
    const cache = new Map();
    let clean = true;
    let full = false;
    let ndeletions = 0;
    let noverlap = 0;
    function size() {
        if (full)
            return cache.size;
        return base.size + cache.size - ndeletions - noverlap;
    }
    function mark() {
        if (clean) {
            clean = false;
            if (parent)
                parent();
        }
    }
    function dirty1(k) {
        if (full)
            return cache.get(k);
        if (cache.has(k)) {
            const out = cache.get(k);
            return out !== DELETED ? out : undefined;
        }
        if (!base.has(k))
            return undefined;
        const cow = copyOnWrite(base.get(k), mark);
        cache.set(k, cow);
        noverlap++;
        return cow;
    }
    function dirtyAll() {
        if (full)
            return cache;
        full = true;
        const deleted = new Set();
        for (const [k, v] of cache) {
            if (v === DELETED)
                deleted.add(k);
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
        if (clean)
            return deepCopy(base);
        if (full)
            return deepCopy(cache);
        const out = new Map();
        for (const [key, value] of base.entries()) {
            if (!cache.has(key))
                out.set(key, deepCopy(value));
        }
        for (const [key, value] of cache.entries()) {
            if (value !== DELETED)
                out.set(key, deepCopy(value));
        }
        return out;
    }
    function rcvr() {
        // was any modification made?
        if (clean)
            return base;
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
            }
            else {
                out.set(k, recover(v));
            }
        }
        return out;
    }
    let proxy;
    // create a one-off methods object, since we have a lot of stuff to bind into it
    const cowMapMethods = {
        // special
        get: (key) => dirty1(key),
        has: (key) => {
            if (full)
                return cache.has(key);
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
        keys: (...args) => base.keys.apply(dirtyAll(), args),
        entries: (...args) => base.entries.apply(dirtyAll(), args),
        forEach: (...args) => base.forEach.apply(dirtyAll(), args),
        values: (...args) => base.values.apply(dirtyAll(), args),
        [Symbol.iterator]: (...args) => base[Symbol.iterator].apply(dirtyAll(), args),
        // mutators
        delete: (key) => {
            mark();
            if (full)
                return cache.delete(key);
            const old = cache.get(key);
            if (old === DELETED)
                return false; // noop; already marked as deleted
            const incache = old !== undefined || cache.has(key);
            if (!base.has(key)) {
                // key not in base: is it newly added to cache, or totally missing?
                if (!incache)
                    return false;
                cache.delete(key);
                return true;
            }
            // key is in base; add a new deletion marker
            cache.set(key, DELETED);
            ndeletions++;
            if (!incache) {
                noverlap++;
            }
            return true;
        },
        getOrInsert: (key, defaultValue) => {
            let old = cache.get(key);
            if (old === DELETED) {
                // undelete a deleted key
                cache.set(key, defaultValue);
                ndeletions--;
                return defaultValue;
            }
            if (old !== undefined || cache.has(key))
                return old;
            // not in cache; check base
            old = base.get(key);
            if (old !== undefined || base.has(key))
                return old;
            // not in base either; do an insert
            mark();
            cache.set(key, defaultValue);
            return defaultValue;
        },
        getOrInsertComputed: (key, callback) => {
            let old = cache.get(key);
            if (old === DELETED) {
                // undelete a deleted key
                const value = callback(key);
                cache.set(key, value);
                ndeletions--;
                return value;
            }
            if (old !== undefined || cache.has(key))
                return old;
            // not in cache; check base
            old = base.get(key);
            if (old !== undefined || base.has(key))
                return old;
            // not in base either; do an insert
            mark();
            const value = callback(key);
            cache.set(key, value);
            return value;
        },
        set: (key, value) => {
            mark();
            const old = cache.get(key);
            if (old === DELETED)
                ndeletions--;
            const incache = old !== undefined || cache.has(key);
            if (!incache && base.has(key))
                noverlap++;
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
        get(_, prop) {
            if (prop === copySym)
                return copy;
            if (prop === recoverSym)
                return rcvr;
            if (prop === "size")
                return size();
            // get methods
            const method = cowMapMethods[prop];
            if (method)
                return method;
            const value = base[prop];
            if (value instanceof Function) {
                return (...args) => value.apply(cache, args);
            }
            return value;
        },
        has(_, prop) {
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
function copyOnWriteSet(base, parent) {
    // since we have no child cow objects, as soon as we get an update we do a full copy and use that
    let cache = undefined;
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
        get(_, prop) {
            if (prop === copySym)
                return () => deepCopy(cache ?? base);
            if (prop === recoverSym)
                return () => cache ?? base;
            if (prop === "add" || prop === "delete" || prop === "clear") {
                if (cache === undefined) {
                    // break the glass
                    cache = new Set(base);
                    if (parent)
                        parent();
                }
            }
            const value = (cache ?? base)[prop];
            if (value instanceof Function) {
                return (...args) => value.apply(cache ?? base, args);
            }
            return value;
        },
        has(_, prop) {
            // we don't support custom own properties or prototypes, so this is sufficient
            return prop in base;
        },
        ownKeys(_) {
            // we don't support custom own properties
            return [];
        },
    });
}
/* A FutureContext corresponds to the first generator in our callstack.  Though it may be delegating
   yields to some child generator through yield* statements, when a condition is met to wake up the
   child, the .next() has to be sent to the root generator, not the child (or grandchild).

   FutureContext makes that trivial. */
class FutureContext {
    #coro;
    #awake = false;
    constructor(coro) {
        this.#coro = coro;
    }
    wakeup() {
        // disallow calls to the base wakeup from inside the base wakeup
        if (this.#awake)
            return;
        this.#awake = true;
        try {
            this.#coro.next();
        }
        finally {
            this.#awake = false;
        }
    }
    throw(e) {
        // if we're actually inside the coro, throw the error now
        if (this.#awake)
            throw (e);
        this.#awake = true;
        try {
            this.#coro.throw(e);
        }
        finally {
            this.#awake = false;
        }
    }
}
// function to interact with the StorageGenerator
function* txnGet(key) {
    const ans = (yield { "get": { [key]: true } }).get[key];
    if ("err" in ans) {
        throw ans.err;
    }
    return ans.value;
}
// a function to interact with the StorageGenerator
function* txnSet(key, value) {
    const ans = (yield { "set": { [key]: value } }).set[key];
    if ("err" in ans) {
        throw ans.err;
    }
}
// a function to interact with the StorageGenerator
function* txnDel(key) {
    const ans = (yield { "del": { [key]: true } }).del[key];
    if ("err" in ans) {
        throw ans.err;
    }
}
// a function to hide some of the boilerplate of opening a WTxn
function* withWTxn(fx, s, fn) {
    return yield* s.withWTxn(fx, function* (txn) {
        return yield* runTxn(fx, txn, fn());
    });
}
// a function to hide some of the boilerplate of opening a RTxn
function* withRTxn(fx, s, fn) {
    return yield* s.withRTxn(fx, function* (txn) {
        return yield* runTxn(fx, txn, fn());
    });
}
// run a StorageGenerator to completion, converting potentially many parallel callbacks into a
// generator interface.
function* runTxn(fx, txn, g) {
    // ignore late callbacks
    let valid = true;
    try {
        let ans = { get: {}, set: {}, del: {} };
        let ready = false;
        while (true) {
            const { value, done } = g.next(ans);
            if (done)
                return value;
            ans = { get: {}, set: {}, del: {} };
            ready = false;
            // start gets
            for (const key of Object.keys(value.get ?? {})) {
                txn.get(key, (result) => {
                    if (!valid)
                        return; // ignore late callback
                    ans.get[key] = result;
                    ready = true;
                    fx.wakeup();
                });
            }
            // start sets
            for (const [key, val] of Object.entries(value.set ?? {})) {
                txn.set(key, val, (result) => {
                    if (!valid)
                        return; // ignore late callback
                    ans.set[key] = result;
                    ready = true;
                    fx.wakeup();
                });
            }
            // start deletes
            for (const key of Object.keys(value.del ?? {})) {
                txn.del(key, (result) => {
                    if (!valid)
                        return; // ignore late callback
                    ans.del[key] = result;
                    ready = true;
                    fx.wakeup();
                });
            }
            // wait for a result
            while (!ready)
                yield;
        }
    }
    finally {
        valid = false;
    }
}
// InMemoryStorage does not require any StorageCoders because it never encodes or decodes.
class InMemStorage {
    #data;
    constructor(data) {
        this.#data = data !== undefined ? data : {};
    }
    *#withTxn(fn) {
        const updates = {};
        const txn = new InMemTxn(this.#data, updates);
        // abort case is that we don't catch the exception here:
        const result = yield* fn(txn);
        // commit case
        for (const [key, val] of Object.entries(updates)) {
            if (val === undefined) {
                delete this.#data[key];
            }
            else {
                this.#data[key] = val;
            }
        }
        return result;
    }
    *withWTxn(_fx, fn) {
        return yield* this.#withTxn(fn);
    }
    *withRTxn(_fx, fn) {
        return yield* this.#withTxn(fn);
    }
}
class InMemTxn {
    #data;
    #updates;
    constructor(data, updates) {
        this.#data = data;
        this.#updates = updates;
    }
    get(key, cb) {
        if (key in this.#updates) {
            cb({ value: this.#updates[key] });
        }
        else {
            cb({ value: this.#data[key] });
        }
    }
    set(key, value, cb) {
        this.#updates[key] = value;
        cb({ value: true });
    }
    del(key, cb) {
        this.#updates[key] = undefined;
        cb({ value: true });
    }
}
class OverlayStorage {
    #base;
    #data = {};
    constructor(base) {
        this.#base = base;
    }
    keys() {
        return Object.keys(this.#data);
    }
    *#withTxn(fx, fn) {
        // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
        const self = this;
        return yield* this.#base.withRTxn(fx, function* (baseTxn) {
            const updates = {};
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
    *withWTxn(fx, fn) {
        return yield* this.#withTxn(fx, fn);
    }
    *withRTxn(fx, fn) {
        return yield* this.#withTxn(fx, fn);
    }
}
class OverlayTxn {
    #base;
    #data;
    #updates;
    constructor(base, data, updates) {
        this.#base = base;
        this.#data = data;
        this.#updates = updates;
    }
    get(key, cb) {
        if (key in this.#updates) {
            cb({ value: this.#updates[key] });
        }
        else if (key in this.#data) {
            cb({ value: this.#data[key] });
        }
        else {
            this.#base.get(key, cb);
        }
    }
    set(key, value, cb) {
        this.#updates[key] = value;
        cb({ value: true });
    }
    del(key, cb) {
        this.#updates[key] = undefined;
        cb({ value: true });
    }
}
// ReducerContext looks like:
// yield* rx.set.project(key, val): set new value (you only get to set it once per txn)
// yield* rx.get.project(key): get the current value for key, possibly setting it from old
// yield* rx.old.project(key): explicitly get the old value for key
// wrap a Reducer so it acts like a WStorageGenerator, returning a set of updated keys
function* runReducer(g, simulate) {
    // our cache of get's we've already completed
    const old = Object.create(null);
    // our planned sets and dels that we submit at the end
    const cur = Object.create(null);
    function* finish(retVal) {
        const updates = [];
        const question = { get: {}, set: {}, del: {} };
        for (const [k, v] of Object.entries(cur)) {
            if (v === DELETED) {
                question.del[k] = true;
                updates.push(k);
            }
            else {
                // de-copyOnWrite-ify the value
                const r = recover(v);
                // get the old value
                const o = old[k];
                // detect noop
                if (r === o)
                    continue;
                // otherwise write the value to storage
                updates.push(k);
                question.set[k] = r;
            }
        }
        // is there any storage updates to make?
        if (updates.length === 0 || simulate)
            return [updates, retVal];
        let nupdated = 0;
        while (nupdated < updates.length) {
            // actually yield the write request to storage
            const ans = yield question;
            // check every result
            for (const [k, v] of Object.entries(ans.set ?? {})) {
                if ("err" in v)
                    throw new Error(`setting "${k}" after reducer: ${v.err}`);
                nupdated++;
            }
            for (const [k, v] of Object.entries(ans.del ?? {})) {
                if ("err" in v)
                    throw new Error(`deleting "${k}" after reducer: ${v.err}`);
                nupdated++;
            }
        }
        return [updates, retVal];
    }
    let ans = { old: {}, get: {}, set: {}, del: {} };
    // inflight is for gets we have submitted but haven't received
    // (you can have many olds or gets in flight simultaneously, but only one set, and it cannot be
    //  simultaneous with any gets)
    let inflight = {};
    // pending is for answers we're trying to deliver
    // {key: pending_ops}
    let pending = {};
    let storageQuestion = { get: {}, set: {}, del: {} };
    // run the reducer to completion
    while (true) {
        let ready = true;
        while (ready) {
            const { value, done } = g.next(ans);
            if (done)
                return yield* finish(value ?? []);
            ans = { old: {}, get: {}, set: {}, del: {} };
            ready = false;
            for (const key of Object.keys(value.old ?? {})) {
                if (key in old) {
                    // we already know this one
                    // note that copyOnWrite() is applied inside the ReducerContext; not here
                    ans.old[key] = { value: old[key] };
                    ready = true;
                }
                else if (!inflight[key]) {
                    inflight[key] = true;
                    storageQuestion.get[key] = true;
                    setdefault(pending, key, {}).old = true;
                }
            }
            for (const key of Object.keys(value.get ?? {})) {
                if (key in cur) {
                    // value was already set
                    // TODO: let copyOnWrite() fork an existing copyOnWrite object, so we don't have to
                    //       materialize the updated object until we call finish()
                    const cached = cur[key];
                    ans.get[key] = { value: recover(cached !== DELETED ? cached : undefined) };
                    ready = true;
                }
                else if (key in old) {
                    // we looked this up before
                    // note that copyOnWrite() is applied inside the ReducerContext; not here
                    ans.get[key] = { value: old[key] };
                    ready = true;
                }
                else if (!inflight[key]) {
                    inflight[key] = true;
                    storageQuestion.get[key] = true;
                    setdefault(pending, key, {}).get = true;
                }
            }
            for (const [key, val] of Object.entries(value.set ?? {})) {
                // just store this in memory for now
                cur[key] = val;
                ans.set[key] = { value: true };
                ready = true;
            }
            for (const key of Object.keys(value.del ?? {})) {
                // just store this in memory for now
                cur[key] = DELETED;
                ans.del[key] = { value: true };
                ready = true;
            }
        }
        // interact with storage until we have an answer to return to the reducers
        while (!ready) {
            const storageAnswer = yield storageQuestion;
            storageQuestion = { get: {}, set: {}, del: {} };
            for (const [key, val] of Object.entries(storageAnswer.get)) {
                // cache successful results
                if ("value" in val)
                    old[key] = val.value;
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
class _Query {
    id;
    latest = undefined;
    closed = false;
    #subs = [];
    // {key: true}
    #keyDeps = {};
    // {query_id: true}
    #queryDeps = {};
    #runs = 0;
    #result = undefined;
    #fn;
    #onStart;
    constructor(id, fn, onStart) {
        this.id = id;
        this.#fn = fn;
        this.#onStart = onStart;
    }
    // part of public api
    *awaitResult() {
        if (this.#onStart) {
            throw new Error("cannot await result of unstarted Query");
        }
        // don't try to coordinate our own #result vaule with the graph being executed; just use this as
        // an idiomatic way to ask the graph run for the result from our .id.
        const ans = yield { query: { [this.id]: true } };
        const [result] = ans.query[this.id];
        return result;
    }
    // part of public api
    subscribe(callback) {
        this.#subs.push(callback);
        return () => {
            this.#subs = this.#subs.filter((x) => x !== callback);
        };
    }
    start() {
        if (this.closed) {
            throw new Error("call to Query.start() on closed query");
        }
        if (this.#onStart) {
            this.#onStart();
            this.#onStart = undefined;
        }
    }
    // part of public api
    close() {
        this.closed = true;
    }
    *#shouldSkip(commitKeys) {
        if (this.#runs === 1) {
            // this is our first time; always run
            return false;
        }
        // check if a key dependency was updated
        for (const key of Object.keys(this.#keyDeps)) {
            if (key in commitKeys)
                return false;
        }
        // check if any query dependency changed its result
        for (const qid of Object.keys(this.#queryDeps)) {
            const ans = yield { "query": { [qid]: true } };
            const [, dirty] = ans["query"][qid];
            if (dirty)
                return false;
        }
        return true;
    }
    // part of graph api
    *run(qx, commitKeys) {
        // shift current values to old values
        const oldResult = this.#result;
        this.#runs++;
        if (yield* this.#shouldSkip(commitKeys)) {
            return [this.#result, false];
        }
        // rebuild deps
        this.#keyDeps = {};
        this.#queryDeps = {};
        const g = this.#fn(qx, oldResult, this.#runs > 1);
        let ans = { query: {}, store: {} };
        // run query function to completion
        while (true) {
            // pass the current answer to the coroutine
            const { value, done } = g.next(ans);
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
    notify() {
        if (this.closed)
            return;
        for (const sub of this.#subs) {
            sub(this.#result);
        }
        this.latest = this.#result;
    }
}
/* GraphRun represents one run of the QueryGraph.  Having it as a separate object rather than a
   single generator function (as it once was written) allows a graph to be extended if new queries
   arrive */
class GraphRun {
    #qx;
    // {key: true}
    #commitKeys;
    // the [result, dirty] of queries which have ran
    // {query_id: [value, dirty]}
    #ran = {};
    constructor(qx, commitKeys) {
        this.#qx = qx;
        this.#commitKeys = commitKeys;
    }
    // Run the query graph to completion.
    //
    // run() may be called once after construction against all existing queries, then may be called
    // additional times as new queries are added to the QueryGraph.
    // yields: list of keys, returns callback for users, receives: map of keys to values
    *run(queries) {
        // freeze current query list, in case our caller ever gives us something they intend to mutate
        queries = [...queries];
        // every query which is currently running
        // {query_id: generator}
        const active = {};
        // a record of {query_id: answer} to feed to coroutines
        let runnable = {};
        // which queries are unblocked by a given answer
        // {answer_key: query_id[]}
        const wantAnswers = {};
        // which queries are unblocked by a given query result
        // {query_id: query_id[]}
        const wantResults = {};
        // start every query in parallel
        for (const q of queries) {
            const g = q.run(this.#qx, this.#commitKeys);
            active[q.id] = g;
            // provide a phony first answer to start the generator off
            runnable[q.id] = { store: {}, query: {} };
        }
        // run the graph to completion
        while (true) {
            // run runnables until we run out; each runnable may unlock other runnables
            while (true) {
                const answers = Object.entries(runnable);
                if (answers.length === 0)
                    break;
                runnable = {};
                for (const [qid, ans] of answers) {
                    const { value, done } = active[qid].next(ans);
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
                                setdefault(runnable, id, { query: {}, store: {} }).query[qid] = result;
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
                            setdefault(runnable, qid, { query: {}, store: {} }).query[id] = this.#ran[id];
                        }
                        else {
                            // wake this query up when the other query finishes
                            setdefault(wantResults, id, []).push(qid);
                        }
                    }
                }
            }
            // are we all done?
            if (Object.keys(active).length === 0)
                break;
            // send all pending questions to storage
            const gets = {};
            for (const key of Object.keys(wantAnswers)) {
                gets[key] = true;
            }
            const answers = (yield { get: gets }).get;
            // process answers
            const answerEntries = Object.entries(answers);
            if (answerEntries.length === 0) {
                throw new Error("empty answer");
            }
            for (const [key, value] of answerEntries) {
                for (const qid of wantAnswers[key]) {
                    setdefault(runnable, qid, { query: {}, store: {} }).store[key] = value;
                }
                delete wantAnswers[key];
            }
        }
        // return a callback to notify query subscribers
        return () => {
            for (const q of queries) {
                const [, dirty] = this.#ran[q.id];
                if (dirty)
                    q.notify();
            }
        };
    }
}
/* QueryGraph is responsible for tracking queries generated by the UI and rerunning them when new
   data is present.  It tracks dependencies of a query function by injecting a query context, which
   provides the actual key-value lookup capability to the function.  It is informed of changes to
   storage by the Midend, such as some keys being updated by the UI, keys of an old overlay being
   discarded, or new forecast data from the UI itself. */
class QueryGraph {
    #qx;
    #dirty = {};
    #queries = {};
    #newQueries = [];
    #id = 1;
    #run;
    constructor(qx) {
        this.#qx = qx;
        // start with an empty graphrun
        this.#run = new GraphRun(this.#qx, {});
    }
    newQuery(fn, manualStart, onStart) {
        const id = `${this.#id++}`;
        const q = new _Query(id, fn, () => {
            onStart();
            this.#queries[id] = q;
            this.#newQueries.push(q);
        });
        if (!manualStart)
            q.start();
        return q;
    }
    dirty(keys) {
        for (const key of keys) {
            this.#dirty[key] = true;
        }
    }
    *run() {
        // start a new graph run
        const commitKeys = this.#dirty;
        this.#dirty = {};
        this.#run = new GraphRun(this.#qx, commitKeys);
        // run against all queries
        const queries = Object.values(this.#queries);
        this.#newQueries = [];
        return yield* this.#execute(queries);
    }
    *extend() {
        // extend an existing graph run with only new queries
        const queries = this.#newQueries;
        this.#newQueries = [];
        return yield* this.#execute(queries);
    }
    *#execute(queries) {
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
function DecodeRealEvent(val, subdecoder) {
    return { ...val, data: subdecoder(val.data) };
}
function matchSent(tpl, cmd) {
    if (typeof tpl !== typeof cmd)
        return false;
    switch (typeof tpl) {
        case "boolean":
        case "bigint":
        case "number":
        case "string":
        case "undefined":
            return tpl === cmd;
        case "function":
            return tpl(cmd);
        case "object":
            // null handled here
            if (tpl === null)
                return cmd === null;
            // general objects handled below
            break;
        case "symbol":
        default:
            throw new Error(`mark of type "${typeof tpl}" not handled by matchSent`);
    }
    if (Array.isArray(tpl)) {
        if (!Array.isArray(cmd))
            return false;
        if (tpl.length !== cmd.length)
            return false;
        return tpl.every((v, i) => matchSent(v, cmd[i]));
    }
    if (tpl instanceof Map) {
        throw new Error(`mark of type Map not handled by matchSent`);
    }
    if (tpl instanceof Set) {
        throw new Error(`mark of type Set not handled by matchSent`);
    }
    return Object.entries(tpl).every(([k, v]) => matchSent(v, cmd[k]));
}
// "R"educerConte"x"t
// "Q"ueryConte"x"t
// "E"vents
// "C"ommands
class Framework {
    #rx;
    #storage;
    #decodeEvent;
    #migrate;
    #reducer;
    #forecaster;
    #decodeCommand;
    #onCommands;
    #live = false;
    #setLive = false;
    #overlay;
    #graph;
    #coro;
    #fx;
    #scheduled = false;
    // #reconnects is a list of promise resolve functions
    #reconnects = [];
    #recvdEvents = [];
    // commands that came to us from the client
    #sendCommands = [];
    // command ids the user explicitly marks as completed
    #roundTripped = [];
    // ordered map of command ids to the forecasted events from that command
    #unsent = new Map();
    // just a flag if new queries exist to be run; we don't store them here for typing purposes.
    #newQueries = false;
    #simulates = [];
    constructor(qx, rx, 
    // if storage is null, InMemStorage is used
    storage, callbacks) {
        this.#rx = rx;
        this.#storage = storage ?? new InMemStorage();
        this.#decodeEvent = callbacks.decodeEvent;
        this.#decodeCommand = callbacks.decodeCommand ?? null;
        this.#migrate = callbacks.migrate ?? null;
        this.#reducer = callbacks.reducer;
        this.#forecaster = callbacks.forecaster ?? null;
        this.#onCommands = callbacks.onCommands ?? null;
        this.#overlay = new OverlayStorage(this.#storage);
        this.#graph = new QueryGraph(qx);
        this.#coro = this.#advancer();
        this.#fx = new FutureContext(this.#coro);
        // let the advancer begin initializing
        this.#fx.wakeup();
    }
    //// public api ////
    // request info needed to resume a connection: last committed checkpoint and unsent commands
    reconnect(cb) {
        this.#reconnects.push(cb);
        this.#schedule();
    }
    // new events from the wire come here
    recvEvents(raw) {
        for (const r of raw) {
            const event = DecodeRealEvent(r, this.#decodeEvent);
            this.#recvdEvents.push(event);
        }
        this.#schedule();
    }
    fellBehind() {
        this.#setLive = false;
        this.#schedule();
    }
    caughtUp() {
        this.#setLive = true;
        this.#schedule();
    }
    // after forecasting and saving to storage, these will appear in an onCommands() callback
    sendCommands(commands) {
        if (!this.#onCommands || !this.#decodeCommand) {
            throw new Error("if sendCommands() is used, the following callbacks must be defined: "
                + "onCommands and decodeCommand");
        }
        this.#sendCommands.push.apply(this.#sendCommands, commands);
        this.#schedule();
    }
    // normally forecasted events are discarded when the event id that was submitted is observed in
    // recvEvents().  But if the command was rejected, then it may be necessary to explicitly flag the
    // command as sent, so the forecasted events from that rejected command can be discarded.
    markSent(...id) {
        this.#roundTripped.push(...id);
        this.#schedule();
    }
    // add a new Query to the graph
    newQuery(fn, manualStart) {
        return this.#graph.newQuery(fn, manualStart ?? false, () => {
            this.#newQueries = true;
            this.#schedule();
        });
    }
    simulate(fn, cb, undecodedEvents) {
        const self = this;
        this.#simulates.push(function* () {
            // unwrap and decode events
            const decoded = (undecodedEvents ?? []).map((u) => self.#decodeEvent(u.data));
            // run provided function
            const result = yield* fn(self.#rx, decoded);
            // send result
            cb(result);
        });
        this.#schedule();
    }
    //// end of public api ////
    #schedule() {
        if (this.#scheduled)
            return;
        this.#scheduled = true;
        setTimeout(() => {
            this.#scheduled = false;
            this.#fx.wakeup();
        });
    }
    *#initialize() {
        const self = this;
        // run migration logic on the data store
        if (self.#migrate) {
            yield* withWTxn(this.#fx, this.#storage, function* () {
                yield* runReducer(self.#migrate(self.#rx));
                // ignore updated keys and don't trigger a run of the graph
            });
        }
        // load unsent commands from storage
        const commands = [];
        yield* withRTxn(this.#fx, this.#storage, function* () {
            const index = (yield* txnGet(".commands")) ?? [];
            for (const id of index) {
                const command = (yield* txnGet(`.command-${id}`));
                commands.push(command);
            }
        });
        if (commands.length === 0)
            return;
        if (!this.#forecaster) {
            // reload just the list of unset event ids
            for (const command of commands) {
                this.#unsent.set(command.id, []);
            }
            return;
        }
        // reload forecasted state
        const forecasts = [];
        for (const command of commands) {
            // note that since storage may be in-memory, we must take care to preserve command.data
            const c = copyOnWrite(this.#decodeCommand(command.data));
            const fs = recover(this.#forecaster(c));
            this.#unsent.set(command.id, fs);
            forecasts.push(...fs);
        }
        if (forecasts.length === 0)
            return;
        // populate the initial overlay
        yield* withWTxn(this.#fx, this.#overlay, function* () {
            yield* runReducer(self.#reducer(self.#rx, forecasts));
            // ignore updated keys and don't trigger a run of the graph
        });
    }
    // our main logic is implemented as a coroutine
    *#advancer() {
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
        while (true) {
            if (this.#live && !this.#setLive) {
                // we fell behind; freeze graph and overlay, and when caughtUp() is called, we'll process
                // all changes from now until then with a single run of the graph
                this.#live = false;
            }
            if (this.#recvdEvents.length > 0) {
                yield* this.#onRecvEvents();
                continue;
            }
            if (this.#roundTripped.length > 0) {
                yield* this.#onRoundTripped();
                continue;
            }
            if (!this.#live && this.#setLive) {
                // we caught up and processed all recvdEvents(); time to restart the query graphs
                this.#live = true;
                yield* this.#rebuildOverlay();
                continue;
            }
            if (this.#sendCommands.length > 0) {
                yield* this.#onSendCommands();
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
            yield;
        }
    }
    *#onRecvEvents() {
        const self = this;
        // take events and latest checkpoint
        const events = this.#recvdEvents;
        const checkpoint = events.at(-1).position;
        this.#recvdEvents = [];
        // open a write txn to real storage
        const updates = yield* withWTxn(this.#fx, this.#storage, function* () {
            // update our checkpoint when this txn finishes
            yield* txnSet(".checkpoint", checkpoint);
            // run the reducer with our new events
            const eventsData = events.map((event) => event.data);
            const [updates, markedSent] = yield* runReducer(self.#reducer(self.#rx, eventsData));
            // discard unsent commands that we now know are sent
            if (self.#unsent.size > 0) {
                // discard commands we observed round-trip by matching event ids
                for (const event of events) {
                    if (self.#unsent.has(event.id)) {
                        self.#roundTripped.push(event.id);
                    }
                }
                // discard commands that match what the reducer says was sent
                if (markedSent.length > 0) {
                    const toIgnore = self.#roundTripped.reduce((acc, id) => (acc[id] = true, acc), {});
                    for (const id of self.#unsent.keys()) {
                        if (id in toIgnore)
                            continue;
                        const event = (yield* txnGet(`.command-${id}`));
                        const cmd = self.#decodeCommand(event.data);
                        for (const m of markedSent) {
                            if (!matchSent(m, cmd))
                                continue;
                            self.#roundTripped.push(event.id);
                            break;
                        }
                    }
                }
            }
            // discard commands based on calls to Framework.markSent()
            yield* self.#discardRoundTripped();
            return updates;
        });
        this.#graph.dirty(updates);
        this.#roundTripped.map((id) => this.#unsent.delete(id));
        this.#roundTripped = [];
        if (this.#live) {
            yield* this.#rebuildOverlay();
        }
    }
    *#rebuildOverlay() {
        const self = this;
        // discard old overlay, start a new one
        this.#graph.dirty(this.#overlay.keys());
        this.#overlay = new OverlayStorage(this.#storage);
        // rebuild overlay with current forecasts
        const forecasts = [...this.#unsent.values()].flat();
        if (forecasts.length > 0) {
            const [updates, _markedSent] = yield* withWTxn(this.#fx, this.#overlay, function* () {
                return yield* runReducer(self.#reducer(self.#rx, forecasts));
            });
            self.#graph.dirty(updates);
        }
        const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
            // this will run all queries, even new ones
            self.#newQueries = false;
            return yield* self.#graph.run();
        });
        cbs();
    }
    *#onSendCommands() {
        const self = this;
        // generate a uuid now for each event
        const commands = this.#sendCommands.map((c) => ({ id: generateUuid(), data: c }));
        this.#sendCommands = [];
        // encode once for both storage and sending over the wire
        const encoded = commands.map((c) => ({ id: c.id, data: EncodeProto(c.data) }));
        // open a write txn to real storage
        yield* withWTxn(this.#fx, this.#storage, function* () {
            const added = [];
            // write each command to storage
            for (const ec of encoded) {
                yield* txnSet(`.command-${ec.id}`, ec);
                added.push(ec.id);
            }
            // update the index
            const index = (yield* txnGet(".commands")) ?? [];
            yield* txnSet(".commands", [...index, ...added]);
        });
        // schedule a callback for the user to know it is time to send these commands
        setTimeout(() => this.#onCommands(commands));
        // store those commands as unsent
        // now forecast events based on those commands
        if (!this.#forecaster) {
            for (const command of commands) {
                this.#unsent.set(command.id, []);
            }
            return;
        }
        const forecasts = [];
        for (const command of commands) {
            const c = copyOnWrite(command.data);
            const fs = recover(this.#forecaster(c));
            this.#unsent.set(command.id, fs);
            forecasts.push(...fs);
        }
        if (forecasts.length === 0 || !this.#live)
            return;
        // open a write txn against the existing overlay
        const [updates, _markedSent] = yield* withWTxn(this.#fx, this.#overlay, function* () {
            return yield* runReducer(self.#reducer(self.#rx, forecasts));
        });
        this.#graph.dirty(updates);
        const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
            // this will run all queries, even new ones
            self.#newQueries = false;
            return yield* self.#graph.run();
        });
        cbs();
    }
    // discard this.#roundTripped within some externally-provided WTxn
    // (you'll have to erase this.#roundTripped after the txn commits)
    // return true if something was deleted (but it always processes this.#roundTripped)
    *#discardRoundTripped() {
        if (this.#roundTripped.length === 0)
            return false;
        const roundTripped = {};
        for (const id of this.#roundTripped) {
            roundTripped[id] = true;
        }
        // load the index of batches of commands
        const index = (yield* txnGet(".commands")) ?? [];
        // decide what to delete
        const toDelete = index.filter((id) => roundTripped[id]);
        if (toDelete.length === 0)
            return false;
        for (const id of toDelete) {
            yield* txnDel(`.command-${id}`);
        }
        // update the index
        const toKeep = index.filter((id) => !roundTripped[id]);
        yield* txnSet(".commands", toKeep);
        return true;
    }
    *#onRoundTripped() {
        const self = this;
        const changed = yield* withWTxn(this.#fx, this.#storage, function* () {
            return yield* self.#discardRoundTripped();
        });
        this.#roundTripped.map((id) => this.#unsent.delete(id));
        this.#roundTripped = [];
        if (changed && this.#live) {
            yield* this.#rebuildOverlay();
        }
    }
    *#onNewQueries() {
        const self = this;
        const cbs = yield* withRTxn(this.#fx, this.#overlay, function* () {
            self.#newQueries = false;
            return yield* self.#graph.extend();
        });
        cbs();
    }
    *#onReconnects() {
        const { checkpoint, commands } = yield* withRTxn(this.#fx, this.#storage, function* () {
            const checkpoint = (yield* txnGet(".checkpoint"));
            const commands = [];
            const index = (yield* txnGet(".commands")) ?? [];
            for (const id of index) {
                const command = (yield* txnGet(`.command-${id}`));
                commands.push(command);
            }
            return { checkpoint, commands };
        });
        for (const resolve of this.#reconnects) {
            resolve({ checkpoint, commands });
        }
        this.#reconnects = [];
    }
    *#onSimulates() {
        const simulates = this.#simulates;
        this.#simulates = [];
        // use a single read txn for all simulations, since runReducer() with simulate=true doesn't write
        yield* withRTxn(this.#fx, this.#storage, function* () {
            for (const fn of simulates) {
                yield* runReducer(fn(), true);
            }
        });
    }
}
function DecodeTodoEvents(val) {
    return val;
}
function* queryGet(key) {
    const ans = yield { 'store': { [key]: true } };
    const sv = ans.store[key];
    if ('err' in sv)
        throw sv.err;
    return readOnly(sv.value);
}
function* reducerOld(key) {
    const ans = yield { 'old': { [key]: true } };
    const sv = ans.old[key];
    if ('err' in sv)
        throw sv.err;
    return copyOnWrite(sv.value);
}
function* reducerGet(key) {
    const ans = yield { 'get': { [key]: true } };
    const sv = ans.get[key];
    if ('err' in sv)
        throw sv.err;
    return copyOnWrite(sv.value);
}
function* reducerSet(key, value) {
    const ans = yield { 'set': { [key]: value } };
    const sv = ans.set[key];
    if ('err' in sv)
        throw sv.err;
}
function* reducerDel(key) {
    const ans = yield { 'del': { [key]: true } };
    const sv = ans.del[key];
    if ('err' in sv)
        throw sv.err;
}
function* reducerUpdate(key, fn) {
    const obj = yield* reducerGet(key);
    const out = fn(obj);
    yield* reducerSet(key, obj);
    return out;
}
const TodoQueryContext = {
    get: {
        all_lists: () => queryGet(`all_lists`),
        item: (item_id) => queryGet(`item.${item_id}`),
        list: (list_id) => queryGet(`list.${list_id}`),
    },
};
const TodoReducerContext = {
    old: {
        all_lists: () => reducerOld(`all_lists`),
        item: (item_id) => reducerOld(`item.${item_id}`),
        list: (list_id) => reducerOld(`list.${list_id}`),
    },
    get: {
        all_lists: () => reducerGet(`all_lists`),
        item: (item_id) => reducerGet(`item.${item_id}`),
        list: (list_id) => reducerGet(`list.${list_id}`),
    },
    set: {
        all_lists: (value) => reducerSet(`all_lists`, value),
        item: (item_id, value) => reducerSet(`item.${item_id}`, value),
        list: (list_id, value) => reducerSet(`list.${list_id}`, value),
    },
    del: {
        item: (item_id) => reducerDel(`item.${item_id}`),
        list: (list_id) => reducerDel(`list.${list_id}`),
    },
    update: {
        all_lists: (fn) => reducerUpdate(`all_lists`, fn),
        item: (item_id, fn) => reducerUpdate(`item.${item_id}`, fn),
        list: (list_id, fn) => reducerUpdate(`list.${list_id}`, fn),
    },
};
class TodoFramework extends Framework {
    constructor(storage, callbacks, 
    // used in cross-language support: inject an arbitrary object as the QueryContext
    qx) {
        super(qx ?? TodoQueryContext, TodoReducerContext, storage, {
            ...callbacks,
            decodeEvent: DecodeTodoEvents,
            decodeCommand: DecodeTodoEvents,
        });
    }
}

function* migrateTodos(rx) {
    // just set "all_lists" key to an empty list if it doesn't exist yet
    yield* rx.set.all_lists((yield* rx.get.all_lists()) ?? []);
}
function* reduceTodos(rx, events) {
    for (const e of events) {
        switch (e.type) {
            case "new-list":
                yield* rx.update.all_lists((all_lists) => all_lists.push(e.id));
                yield* rx.set.list(e.id, { id: e.id, name: e.name, items: [], archived: false });
                break;
            case "rename-list":
                yield* rx.update.list(e.id, (list) => list.name = e.name);
                break;
            case "archive-list":
                yield* rx.update.list(e.id, (list) => list.archived = true);
                break;
            case "new-item":
                yield* rx.set.item(e.id, { id: e.id, text: e.text, done: false, archived: false });
                yield* rx.update.list(e.list, (list) => list.items.push(e.id));
                break;
            case "edit-item":
                yield* rx.update.item(e.id, (item) => item.text = e.text);
                break;
            case "mark-item":
                yield* rx.update.item(e.id, (item) => item.done = e.done);
                break;
            case "archive-item":
                yield* rx.update.item(e.id, (item) => item.archived = true);
                break;
            default:
                const _typecheck = e;
                return _typecheck;
        }
    }
}

export { DecodeTodoEvents, InMemStorage, TodoFramework, migrateTodos, reduceTodos };
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9kZWwuanMiLCJzb3VyY2VzIjpbIi4uLy4uL21vZGVsL21vZGVsLmdlbi50cyIsIi4uLy4uL21vZGVsL3JlZHVjZXJzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIHV0aWxzIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuLy8ganNvbl90eXBlb2YgcmV0dXJucyB0aGUganNvbiB0eXBlIG9mIGEgdmFsdWUgdGhhdCBjYW1lIG91dCBvZiBwYXJzaW5nIGpzb25cbi8vIChzbyAndW5kZWZpbmVkJyBpcyBub3QgaGFuZGxlZCwgc2luY2UgaXQgaXNuJ3QgYWxsb3dlZCBpbiBqc29uKVxuZXhwb3J0IGZ1bmN0aW9uIGpzb25fdHlwZW9mKHZhbDogYW55KTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHR5cGVvZih2YWwpO1xuICBpZiAodCA9PT0gXCJvYmplY3RcIikge1xuICAgIGlmICh2YWwgPT09IG51bGwpIHJldHVybiBcIm51bGxcIjtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWwpKSByZXR1cm4gXCJhcnJheVwiO1xuICB9XG4gIHJldHVybiB0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0ZGVmYXVsdDxUPihvYmo6IFJlY29yZDxzdHJpbmcsIFQ+LCBrZXk6IHN0cmluZywgZGZhdWx0OiBUKTogVCB7XG4gIGlmIChrZXkgaW4gb2JqKSB7XG4gICAgcmV0dXJuIG9ialtrZXldO1xuICB9IGVsc2Uge1xuICAgIG9ialtrZXldID0gZGZhdWx0O1xuICAgIHJldHVybiBkZmF1bHQ7XG4gIH1cbn1cblxuY29uc3QgTklCQkxFID0gWycwJywgJzEnLCAnMicsICczJywgJzQnLCAnNScsICc2JywgJzcnLCAnOCcsICc5JywgJ2EnLCAnYicsICdjJywgJ2QnLCAnZScsICdmJ107XG5cbi8vIGdlbmVyYXRlVXVpZCBpcyBlaXRoZXIgaW5qZWN0ZWQgaW50byB0aGUgZW52aXJvbm1lbnQgb3Igd2UgZXhwZWN0IHRvIHVzZSBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKClcbmlmICghKGdsb2JhbFRoaXMgYXMgYW55KS5nZW5lcmF0ZVV1aWQpIHtcbiAgdmFyIGdlbmVyYXRlVXVpZCA9IGZ1bmN0aW9uKCk6IHN0cmluZyB7XG4gICAgbGV0IG91dCA9ICcnO1xuXG4gICAgLy8gR2V0IDEyOCBiaXRzIG9mIHJhbmRvbW5lc3MuXG4gICAgY29uc3QgdmFsdWVzID0gbmV3IFVpbnQ4QXJyYXkoMTYpO1xuICAgIGNyeXB0by5nZXRSYW5kb21WYWx1ZXModmFsdWVzKTtcblxuICAgIC8vIHJmYzQxMjIgY29tcGxpYW5jZTogdHlwZSA0IHV1aWRcbiAgICB2YWx1ZXNbNl0gPSAweDQwIHwgKHZhbHVlc1s2XSAmIDB4MGYpO1xuICAgIHZhbHVlc1s4XSA9IDB4ODAgfCAodmFsdWVzWzhdICYgMHgzZik7XG5cbiAgICB2YWx1ZXMuZm9yRWFjaCgoeCkgPT4ge1xuICAgICAgb3V0ICs9IE5JQkJMRVt4ID4+PiA0XSArIE5JQkJMRVt4ICYgMHgwZl07XG4gICAgfSk7XG5cbiAgICByZXR1cm4gW1xuICAgICAgb3V0LnN1YnN0cmluZygwLCA4KSxcbiAgICAgIG91dC5zdWJzdHJpbmcoOCwgMTIpLFxuICAgICAgb3V0LnN1YnN0cmluZygxMiwgMTYpLFxuICAgICAgb3V0LnN1YnN0cmluZygxNiwgMjApLFxuICAgICAgb3V0LnN1YnN0cmluZygyMCwgMzIpLFxuICAgIF0uam9pbignLScpO1xuICB9XG59XG5cbi8vIHByb3RvSlNPTlJlcGxhY2VyIGlzIGEgSlNPTi5zdHJpbmdpZnkoKSByZXBsYWNlcjsgaXQgaXMgbW9yZSBlZmZpY2llbnQgdGhhbiBFbmNvZGVQcm90byBiZWNhdXNlXG4vLyBKU09OLnN0cmluZ2lmeSgpIGRvZXNuJ3QgaGF2ZSB0byByZWNyZWF0ZSB0aGUgd2hvbGUgdHJlZSBvZiBhbiBvYmplY3QgbGlrZSBFbmNvZGVQcm90byBkb2VzLlxuLy8gQnV0IEVuY29kZVByb3RvIGlzIG1vcmUgbGlrZSBhbiBpbnZlcnNlIG9wZXJhdGlvbiBvZiB0aGUgRGVjb2RlKiBmYW1pbHkgb2YgZnVuY3Rpb25zLlxuZXhwb3J0IGZ1bmN0aW9uIHByb3RvSlNPTlJlcGxhY2VyKF9rOiBzdHJpbmcsIHY6IGFueSk6IGFueSB7XG4gIGlmICh2IGluc3RhbmNlb2YgTWFwKSByZXR1cm4gWy4uLnYuZW50cmllcygpXTtcbiAgaWYgKHYgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBbLi4udi5rZXlzKCldO1xuICAvLyBhbGwgb3RoZXIgdHlwZXMgbmF0dXJhbGx5IHN0cmluZ2lmeSBjb3JyZWN0bHksIGUuZy4gRGF0ZVxuICByZXR1cm4gdjtcbn1cblxuLy8gcHJvdG9TdHJpbmdpZnkgaXMgbGlrZSBKU09OLnN0cmluZ2lmeSgpLCBidXQgaXQgaGFuZGxlcyBNYXAgYW5kIFNldFxuZXhwb3J0IGZ1bmN0aW9uIHByb3RvU3RyaW5naWZ5KG9iajogYW55KTogYW55IHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG9iaiwgcHJvdG9KU09OUmVwbGFjZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRW5jb2RlUHJvdG8oYmFzZTogYW55KTogYW55IHtcbiAgc3dpdGNoICh0eXBlb2YgYmFzZSkge1xuICAgIGNhc2UgXCJib29sZWFuXCI6XG4gICAgY2FzZSBcImJpZ2ludFwiOlxuICAgIGNhc2UgXCJudW1iZXJcIjpcbiAgICBjYXNlIFwic3RyaW5nXCI6XG4gICAgY2FzZSBcInVuZGVmaW5lZFwiOlxuICAgICAgLy8gdGhlc2UgdHlwZXMgYXJlIGFscmVhZHkgaW1tdXRhYmxlXG4gICAgICByZXR1cm4gYmFzZTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBFbmNvZGVQcm90b2ApO1xuICB9XG5cbiAgLy8gY2hlY2sgaWYgb2JqZWN0IGhhcyB0b0pTT04oKVxuICBpZiAoYmFzZS50b0pTT04pIHJldHVybiBiYXNlLnRvSlNPTigpO1xuXG4gIGlmIChBcnJheS5pc0FycmF5KGJhc2UpKSByZXR1cm4gYmFzZS5tYXAoRW5jb2RlUHJvdG8pO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIE1hcCkgcmV0dXJuIFsuLi5iYXNlLmVudHJpZXMoKV0ubWFwKEVuY29kZVByb3RvKTtcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBbLi4uYmFzZS5rZXlzKCldOyAgLy8gb2JqZWN0IGtleXMgbm90IHN1cHBvcnRlZFxuICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGJhc2UpLm1hcCgoW2ssIHZdKSA9PiBbaywgRW5jb2RlUHJvdG8odildKSk7XG59XG5cbmNvbnN0IGNvcHlTeW0gPSBTeW1ib2woKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZXBDb3B5PFQ+KGJhc2U6IFQpOiBUIHtcbiAgc3dpdGNoICh0eXBlb2YgYmFzZSkge1xuICAgIGNhc2UgXCJib29sZWFuXCI6XG4gICAgY2FzZSBcImJpZ2ludFwiOlxuICAgIGNhc2UgXCJudW1iZXJcIjpcbiAgICBjYXNlIFwic3RyaW5nXCI6XG4gICAgY2FzZSBcInVuZGVmaW5lZFwiOlxuICAgICAgLy8gdGhlc2UgdHlwZXMgYXJlIGFscmVhZHkgaW1tdXRhYmxlXG4gICAgICByZXR1cm4gYmFzZTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBkZWVwQ29weWApO1xuICB9XG5cbiAgLy8gaGFuZGxlIHJlYWQtb25seSBhbmQgcHJveHkgb2JqZWN0cyBpbiBhbiBlZmZpY2llbnQgd2F5XG4gIGNvbnN0IGNvcGllciA9IChiYXNlIGFzIGFueSlbY29weVN5bV07XG4gIGlmIChjb3BpZXIpIHJldHVybiBjb3BpZXIoKTtcblxuICAvLyBvYmplY3QgaGFuZGxpbmdcbiAgaWYgKEFycmF5LmlzQXJyYXkoYmFzZSkpIHJldHVybiBbLi4uYmFzZV0ubWFwKGRlZXBDb3B5KSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIE1hcCkge1xuICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBiYXNlKSBvdXQuc2V0KGssIGRlZXBDb3B5KHYpKTtcbiAgICByZXR1cm4gb3V0IGFzIFQ7XG4gIH1cbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBuZXcgU2V0KGJhc2UpIGFzIFQ7ICAvLyBvYmplY3Qga2V5cyBub3QgYWxsb3dlZCBhbnl3YXlcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gbmV3IERhdGUoYmFzZSkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhiYXNlKS5tYXAoKFtrLCB2XSkgPT4gW2ssIGRlZXBDb3B5KHYpXSkpIGFzIFQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkT25seTxUPihiYXNlOiBUKTogUmVhZG9ubHk8VD4ge1xuICBzd2l0Y2ggKHR5cGVvZiBiYXNlKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICAvLyB0aGVzZSB0eXBlcyBhcmUgYWxyZWFkeSBpbW11dGFibGVcbiAgICAgIHJldHVybiBiYXNlO1xuXG4gICAgY2FzZSBcIm9iamVjdFwiOlxuICAgICAgLy8gbnVsbCBoYW5kbGVkIGhlcmVcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSByZXR1cm4gYmFzZTtcbiAgICAgIC8vIGdlbmVyYWwgb2JqZWN0cyBoYW5kbGVkIGJlbG93XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJzeW1ib2xcIjpcbiAgICBjYXNlIFwiZnVuY3Rpb25cIjpcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBiYXNlIG9mIHR5cGUgXCIke3R5cGVvZiBiYXNlfVwiIG5vdCBoYW5kbGVkIGJ5IHJlYWRPbmx5YCk7XG4gIH1cblxuICAvLyBvYmplY3QgaGFuZGxpbmdcbiAgaWYgKEFycmF5LmlzQXJyYXkoYmFzZSkpIHJldHVybiByZWFkT25seUFycmF5KGJhc2UpIGFzIFQ7XG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSByZXR1cm4gcmVhZE9ubHlNYXAoYmFzZSkgYXMgVDtcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiByZWFkT25seVNldChiYXNlKSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIERhdGUpIHJldHVybiByZWFkT25seURhdGUoYmFzZSkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIHJlYWRPbmx5T2JqZWN0KGJhc2UgYXMgYW55KSBhcyBUO1xufVxuXG5mdW5jdGlvbiB0aHJvd1JlYWRPbmx5RXJyb3IoKTogYW55IHtcbiAgdGhyb3cgbmV3IEVycm9yKFwib2JqZWN0IGlzIHJlYWQtb25seSBhbmQgbWF5IG5vdCBiZSBtb2RpZmllZFwiKTtcbn1cblxuZnVuY3Rpb24gcmVhZE9ubHlPYmplY3Q8VD4oYmFzZTogUmVjb3JkPHN0cmluZywgVD4pOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBUPj4ge1xuICBjb25zdCBjYWNoZTogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBzZXQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGJhc2UpO1xuXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVhZE9ubHkoYmFzZVtwcm9wXSk7XG4gICAgICAgIGNhY2hlW3Byb3BdID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgbGV0IHZhbHVlID0gYmFzZVtwcm9wXTtcblxuICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueVtdKSA9PiB2YWx1ZS5hcHBseShiYXNlLCBhcmdzKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgcm8gPSByZWFkT25seSh2YWx1ZSk7XG4gICAgICBjYWNoZVtwcm9wXSA9IHJvO1xuICAgICAgcmV0dXJuIHJvO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZWFkT25seUFycmF5PFQ+KGJhc2U6IFRbXSk6IFJlYWRvbmx5PFRbXT4ge1xuICBjb25zdCBjYWNoZSA9IEFycmF5KGJhc2UubGVuZ3RoKTtcbiAgbGV0IGZpbGxlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGRpcnR5MShuOiBudW1iZXIpOiBUIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgbikpIHJldHVybiBjYWNoZVtuXTtcbiAgICBpZiAoIU9iamVjdC5oYXNPd24oYmFzZSwgbikpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgcm8gPSByZWFkT25seShiYXNlW25dKTtcbiAgICBjYWNoZVtuXSA9IHJvO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCl7XG4gICAgLy8gYWxsIGl0ZW1zIGF0IG9uY2VcbiAgICBpZiAoZmlsbGVkKSByZXR1cm4gY2FjaGU7XG4gICAgZmlsbGVkID0gdHJ1ZTtcbiAgICBmb3IgKGNvbnN0IG4gb2YgYmFzZS5rZXlzKCkpIGRpcnR5MShuKTtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBjb25zdCByb0FycmF5TWV0aG9kczogYW55ID0ge1xuICAgIC8vIHNwZWNpYWxcbiAgICBhdDogKGluZGV4OiBudW1iZXIpID0+IGRpcnR5MShpbmRleCA+IC0xID8gaW5kZXggOiBiYXNlLmxlbmd0aCArIGluZGV4KSxcblxuICAgIC8vIHRoaW5ncyB3aGljaCByZXF1aXJlIGRpcnR5QWxsKCksIHRoZW4gcnVuIGFnYWluc3QgdGhlIGZ1bGwgc2hhbGxvdyBjb3B5XG4gICAgY29uY2F0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmNvbmNhdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBlbnRyaWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmVudHJpZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZXZlcnk6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZXZlcnkuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmlsdGVyOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbHRlci5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbmQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmluZEluZGV4OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbmRJbmRleC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kTGFzdDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS5maW5kTGFzdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kTGFzdEluZGV4OiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmZpbmRMYXN0SW5kZXguYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmxhdDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mbGF0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZsYXRNYXA6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmxhdE1hcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmb3JFYWNoOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZvckVhY2guYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgbWFwOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLm1hcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICByZWR1Y2U6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UucmVkdWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHJlZHVjZVJpZ2h0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnJlZHVjZVJpZ2h0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHNsaWNlOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnNsaWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHNvbWU6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uuc29tZS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1JldmVyc2VkOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLnRvUmV2ZXJzZWQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9Tb3J0ZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9Tb3J0ZWQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9TcGxpY2VkOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLnRvU3BsaWNlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB2YWx1ZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudmFsdWVzLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHdpdGg6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkud2l0aC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBbU3ltYm9sLml0ZXJhdG9yXTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZVtTeW1ib2wuaXRlcmF0b3JdLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gc2FmZSBnZXR0ZXJzXG4gICAgaW5kZXhPZjogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS5pbmRleE9mKC4uLmFyZ3MpLFxuICAgIGpvaW46ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkuam9pbiguLi5hcmdzKSxcbiAgICBrZXlzOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmtleXMoLi4uYXJncyksXG4gICAgbGFzdEluZGV4T2Y6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkubGFzdEluZGV4T2YoLi4uYXJncyksXG4gICAgdG9Mb2NhbGVTdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9Mb2NhbGVTdHJpbmcoLi4uYXJncyksXG4gICAgdG9TdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9TdHJpbmcoLi4uYXJncyksXG5cbiAgICAvLyBkaXNhbGxvd2VkXG4gICAgcHVzaDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHBvcDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNoaWZ0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgcmV2ZXJzZTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIGNvcHlXaXRoaW46IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBmaWxsOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc29ydDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNwbGljZTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHVuc2hpZnQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgfTtcblxuICByZXR1cm4gbmV3IFByb3h5KGJhc2UsIHtcbiAgICBkZWZpbmVQcm9wZXJ0eTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIGRlbGV0ZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc2V0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGJhc2UpO1xuXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVhZE9ubHkoYmFzZVtwcm9wXSk7XG4gICAgICAgIGNhY2hlW3Byb3BdID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWV0aG9kID0gcm9BcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICByZXR1cm4gYmFzZVtwcm9wXTtcbiAgICB9LFxuICB9KTtcbn1cblxuY29uc3Qgcm9EYXRlUHJvdG90eXBlID0ge1xuICBzZXREYXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldEZ1bGxZZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldEhvdXJzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldE1pbGxpc2Vjb25kczogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRNaW51dGVzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldE1vbnRoOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFNlY29uZHM6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgc2V0VGltZTogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRVVENEYXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ0Z1bGxZZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ0hvdXJzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ01pbGxpc2Vjb25kczogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRVVENNaW51dGVzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ01vbnRoOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ1NlY29uZHM6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgc2V0WWVhcjogdGhyb3dSZWFkT25seUVycm9yLFxufVxuT2JqZWN0LnNldFByb3RvdHlwZU9mKHJvRGF0ZVByb3RvdHlwZSwgRGF0ZS5wcm90b3R5cGUpO1xuXG5mdW5jdGlvbiByZWFkT25seURhdGUoYmFzZTogRGF0ZSk6IFJlYWRvbmx5PERhdGU+IHtcbiAgLy8gY29weSBpbnN0ZWFkIG9mIHByb3h5XG4gIGNvbnN0IG91dCA9IG5ldyBEYXRlKGJhc2UpO1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2Yob3V0LCByb0RhdGVQcm90b3R5cGUpO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiByZWFkT25seU1hcDxLLCBWPihiYXNlOiBNYXA8SywgVj4pOiBSZWFkb25seTxNYXA8SywgUmVhZG9ubHk8Vj4+PiB7XG4gIGNvbnN0IGNhY2hlOiBNYXA8SywgUmVhZG9ubHk8Vj4+ID0gbmV3IE1hcCgpO1xuICBsZXQgZmlsbGVkID0gZmFsc2U7XG5cbiAgZnVuY3Rpb24gZGlydHkxKGs6IEspOiBWIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoZmlsbGVkIHx8IGNhY2hlLmhhcyhrKSkgcmV0dXJuIGNhY2hlLmdldChrKTtcbiAgICBpZiAoIWJhc2UuaGFzKGspKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHJvID0gcmVhZE9ubHkoYmFzZS5nZXQoaykhKTtcbiAgICBjYWNoZS5zZXQoaywgcm8pO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCkge1xuICAgIGlmIChmaWxsZWQpIHJldHVybiBjYWNoZTtcbiAgICBmaWxsZWQgPSB0cnVlO1xuICAgIGZvciAoY29uc3QgayBvZiBiYXNlLmtleXMoKSkge1xuICAgICAgaWYgKGNhY2hlLmhhcyhrKSkgY29udGludWU7XG4gICAgICBjYWNoZS5zZXQoaywgcmVhZE9ubHkoYmFzZS5nZXQoaykhKSk7XG4gICAgfVxuICAgIHJldHVybiBjYWNoZTtcbiAgfVxuXG4gIGNvbnN0IHJvTWFwTWV0aG9kczogYW55ID0ge1xuICAgIC8vIHNwZWNpYWxcbiAgICBnZXQ6IChrZXk6IGFueSkgPT4gZGlydHkxKGtleSksXG5cbiAgICAvLyByZXF1aXJlcyBkaXJ0eUFsbFxuICAgIGVudHJpZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZW50cmllcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmb3JFYWNoOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZvckVhY2guYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdmFsdWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnZhbHVlcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBbU3ltYm9sLml0ZXJhdG9yXTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZVtTeW1ib2wuaXRlcmF0b3JdLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gcGFzc3RocnVcbiAgICBoYXM6ICguLi5hcmdzOiBhbnlbXSkgPT4gKGJhc2UgYXMgYW55KS5oYXMoLi4uYXJncyksXG4gICAga2V5czogKC4uLmFyZ3M6IGFueVtdKSA9PiAoYmFzZSBhcyBhbnkpLmtleXMoLi4uYXJncyksXG5cbiAgICAvLyBtdXRhdG9yc1xuICAgIGNsZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZ2V0T3JJbnNlcnQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBnZXRPckluc2VydENvbXB1dGVkOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc2V0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIH07XG4gIE9iamVjdC5zZXRQcm90b3R5cGVPZihyb01hcE1ldGhvZHMsIG51bGwpO1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBzZXQ6IHRocm93UmVhZE9ubHlFcnJvcixcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gKCkgPT4gZGVlcENvcHkoYmFzZSk7XG4gICAgICBjb25zdCBtZXRob2QgPSByb01hcE1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICByZXR1cm4gKGJhc2UgYXMgYW55KVtwcm9wXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gbm8gY2FjaGUgbmVlZGVkLCBzaW5jZSB3ZSBkb24ndCBzdXBwb3J0IG9iamVjdCBrZXlzIGFuZCB0aGVyZSBhcmUgbm8gdmFsdWVzXG5mdW5jdGlvbiByZWFkT25seVNldDxLPihiYXNlOiBTZXQ8Sz4pOiBSZWFkb25seTxTZXQ8Sz4+IHtcbiAgcmV0dXJuIG5ldyBQcm94eShiYXNlLCB7XG4gICAgZGVmaW5lUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBkZWxldGVQcm9wZXJ0eTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNldDogdGhyb3dSZWFkT25seUVycm9yLFxuXG4gICAgZ2V0KF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKHByb3AgPT09IGNvcHlTeW0pIHJldHVybiAoKSA9PiBkZWVwQ29weShiYXNlKTtcblxuICAgICAgLy8ganVzdCBkaXNhbGxvdyBtdXRhdGlvbnNcbiAgICAgIGlmIChwcm9wID09PSBcImFkZFwiIHx8IHByb3AgPT09IFwiZGVsZXRlXCIgfHwgcHJvcCA9PT0gXCJjbGVhclwiKSByZXR1cm4gdGhyb3dSZWFkT25seUVycm9yO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IChiYXNlIGFzIGFueSlbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoYmFzZSwgYXJncyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb3B5T25Xcml0ZTxUPihiYXNlOiBULCBwYXJlbnQ/OiAoKSA9PiB2b2lkKTogVCB7XG4gIHN3aXRjaCAodHlwZW9mIGJhc2UpIHtcbiAgICBjYXNlIFwiYm9vbGVhblwiOlxuICAgIGNhc2UgXCJiaWdpbnRcIjpcbiAgICBjYXNlIFwibnVtYmVyXCI6XG4gICAgY2FzZSBcInN0cmluZ1wiOlxuICAgIGNhc2UgXCJ1bmRlZmluZWRcIjpcbiAgICAgIC8vIHRoZXNlIHR5cGVzIGFyZSBhbHJlYWR5IGltbXV0YWJsZVxuICAgICAgcmV0dXJuIGJhc2U7XG5cbiAgICBjYXNlIFwib2JqZWN0XCI6XG4gICAgICAvLyBudWxsIGhhbmRsZWQgaGVyZVxuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHJldHVybiBiYXNlO1xuICAgICAgaWYgKGJhc2UgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gbmV3IERhdGUoYmFzZSkgYXMgVDsgLy8gdHJpdmlhbCBjb3B5XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBjb3B5T25Xcml0ZWApO1xuICB9XG5cbiAgLy8gb2JqZWN0IGhhbmRsaW5nXG4gIGlmIChBcnJheS5pc0FycmF5KGJhc2UpKSByZXR1cm4gY29weU9uV3JpdGVBcnJheShiYXNlLCBwYXJlbnQpIGFzIFQ7XG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSByZXR1cm4gY29weU9uV3JpdGVNYXAoYmFzZSwgcGFyZW50KSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIFNldCkgcmV0dXJuIGNvcHlPbldyaXRlU2V0KGJhc2UsIHBhcmVudCkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIGNvcHlPbldyaXRlT2JqZWN0KGJhc2UgYXMgYW55LCBwYXJlbnQpIGFzIFQ7XG59XG5cbmNvbnN0IHJlY292ZXJTeW0gPSBTeW1ib2woKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlY292ZXI8VD4oYmFzZTogVCk6IFQge1xuICBzd2l0Y2ggKHR5cGVvZiBiYXNlKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICAvLyBsZWFmIHR5cGUgZm91bmQ7IG5vdGhpbmcgd2FzIGNvd1xuICAgICAgcmV0dXJuIGJhc2U7XG5cbiAgICBjYXNlIFwib2JqZWN0XCI6XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICBpZiAoYmFzZSBpbnN0YW5jZW9mIERhdGUpIHJldHVybiBiYXNlO1xuICAgICAgLy8gZ2VuZXJhbCBvYmplY3RzIGhhbmRsZWQgYmVsb3dcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcInN5bWJvbFwiOlxuICAgIGNhc2UgXCJmdW5jdGlvblwiOlxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGJhc2Ugb2YgdHlwZSBcIiR7dHlwZW9mIGJhc2V9XCIgbm90IGhhbmRsZWQgYnkgcmVjb3ZlcmApO1xuICB9XG5cbiAgLy8gY2hlY2sgaWYgb2JqZWN0IHdhcyByZXR1cm5lZCBieSBjb3B5T25Xcml0ZTsgcmVjb3ZlciBpdHMgaW5uZXIgdmFsdWVcbiAgY29uc3QgcmN2cjogKCkgPT4gVCA9IChiYXNlIGFzIGFueSlbcmVjb3ZlclN5bV07XG4gIGlmIChyY3ZyKSByZXR1cm4gcmN2cigpO1xuXG4gIC8vIG90aGVyd2lzZSB3YWxrIG5vcm1hbCBvYmplY3RzIGxvb2tpbmcgZm9yIGFueXRoaW5nIHRoYXQgY2FtZSBvdXQgb2YgYSBjb3B5T25Xcml0ZS5cblxuICBpZiAoQXJyYXkuaXNBcnJheShiYXNlKSkge1xuICAgIGZvciAoY29uc3QgW2ksIGl0ZW1dIG9mIGJhc2UuZW50cmllcygpKSB7XG4gICAgICBjb25zdCByID0gcmVjb3ZlcihpdGVtKTtcbiAgICAgIGlmIChyICE9PSBpdGVtKSB7XG4gICAgICAgIGJhc2VbaV0gPSByO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gYmFzZTtcbiAgfVxuXG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSB7XG4gICAgZm9yKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBiYXNlLmVudHJpZXMoKSkge1xuICAgICAgY29uc3QgciA9IHJlY292ZXIodmFsdWUpO1xuICAgICAgaWYgKHIgIT09IHZhbHVlKSB7XG4gICAgICAgIGJhc2Uuc2V0KGtleSwgcik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBiYXNlO1xuICB9XG5cbiAgLy8gU2V0IHdpdGggbm9uLXByaW1pdGl2ZSBrZXlzIGlzIG5vdCBzdXBwb3J0ZWQsIHNvIG5vdGhpbmcgdG8gYmUgY2hlY2tlZFxuICBpZiAoYmFzZSBpbnN0YW5jZW9mIFNldCkgcmV0dXJuIGJhc2U7XG5cbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgLy8gcGxhaW4gb2JqZWN0c1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhiYXNlKSkge1xuICAgIGNvbnN0IHIgPSByZWNvdmVyKHZhbHVlKTtcbiAgICBpZiAociAhPT0gdmFsdWUpIHtcbiAgICAgIChiYXNlIGFzIGFueSlba2V5XSA9IHI7XG4gICAgfVxuICB9XG4gIHJldHVybiBiYXNlIGFzIFQ7XG59XG5cbmNvbnN0IERFTEVURUQgPSBTeW1ib2woXCJERUxFVEVEXCIpO1xuXG5mdW5jdGlvbiBjb3B5T25Xcml0ZU9iamVjdDxUPihiYXNlOiBSZWNvcmQ8c3RyaW5nLCBUPiwgcGFyZW50PzogKCkgPT4gdm9pZCk6IFJlY29yZDxzdHJpbmcsIFQ+IHtcbiAgLy8gYnVpbGQgb3VyIGNhY2hlIGluY3JlbWVudGFsbHksIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGNvcHlPbldyaXRlIGNhbGxzIHRvIGEgbWluaW11bVxuICBjb25zdCBjYWNoZTogUmVjb3JkPHN0cmluZywgVCB8IHR5cGVvZiBERUxFVEVEPiA9IHt9O1xuICBsZXQgY2xlYW4gPSB0cnVlO1xuICBsZXQgZnVsbCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIG1hcmsoKSB7XG4gICAgaWYgKGNsZWFuKSB7XG4gICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgLy8gZGlydHkgb3VyIHBhcmVudCB0b29cbiAgICAgIGlmIChwYXJlbnQpIHBhcmVudCgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNvcHkoKSB7XG4gICAgaWYgKGNsZWFuKSByZXR1cm4gZGVlcENvcHkoYmFzZSk7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBUPiA9IHt9O1xuICAgIGlmICghZnVsbCkge1xuICAgICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKGJhc2UpKSB7XG4gICAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleV0gPSBkZWVwQ29weSh2YWwpO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICBpZiAodmFsICE9PSBERUxFVEVEKSBvdXRba2V5XSA9IGRlZXBDb3B5KHZhbCBhcyBUKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJjdnIoKSB7XG4gICAgLy8gd2FzIGFueSBtb2RpZmljYXRpb24gbWFkZT9cbiAgICBpZiAoY2xlYW4pIHJldHVybiBiYXNlO1xuICAgIGlmIChmdWxsKSB7XG4gICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIFQ+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICAgIGlmICh2YWwgIT09IERFTEVURUQpIG91dFtrZXldID0gcmVjb3Zlcih2YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgLy8gc3RhcnQgd2l0aCBhIHNoYWxsb3cgY29weSBvZiBiYXNlXG4gICAgY29uc3Qgb3V0ID0geyAuLi5iYXNlIH07XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKGNhY2hlKSkge1xuICAgICAgaWYgKHZhbCA9PT0gREVMRVRFRCkge1xuICAgICAgICBkZWxldGUgb3V0W2tleV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRba2V5XSA9IHJlY292ZXIodmFsKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoXywgcHJvcDogYW55KSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBjYWNoZVtwcm9wXSA9IERFTEVURUQ7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuXG4gICAgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKGNhY2hlW3Byb3BdID09PSBERUxFVEVEKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApID8/XG4gICAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoYmFzZSwgcHJvcCk7XG4gICAgfSxcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gY29weTtcbiAgICAgIGlmIChwcm9wID09PSByZWNvdmVyU3ltKSByZXR1cm4gcmN2cjtcblxuICAgICAgLy8gbG9va3VwIHZhbHVlIGluIGNhY2hlIGZpcnN0XG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBjYWNoZVtwcm9wXTtcbiAgICAgICAgcmV0dXJuIHZhbHVlICE9PSBERUxFVEVEID8gdmFsdWUgOiB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICAvLyB0aGVuIGdldCBjYWNoZWFibGUgdmFsdWUgZnJvbSBiYXNlXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihiYXNlLCBwcm9wKSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvcHlPbldyaXRlKGJhc2VbcHJvcF0sIG1hcmspO1xuICAgICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gYmFzZVtwcm9wXTtcbiAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgICAgIHJldHVybiAoLi4uYXJnczogYW55KSA9PiB2YWx1ZS5hcHBseShjYWNoZSwgYXJncyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSxcblxuICAgIGhhcyhfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGNhY2hlLCBwcm9wKSkgcmV0dXJuIGNhY2hlW3Byb3BdICE9PSBERUxFVEVEO1xuICAgICAgcmV0dXJuIHByb3AgaW4gYmFzZTtcbiAgICB9LFxuXG4gICAgb3duS2V5cygpIHtcbiAgICAgIGNvbnN0IG91dCA9IFtdO1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoYmFzZSkpIHtcbiAgICAgICAgaWYgKGNhY2hlW2tleV0gPT09IERFTEVURUQpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2FjaGUpKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIGtleSkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoY2FjaGVba2V5XSAhPT0gREVMRVRFRCkgb3V0LnB1c2goa2V5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBvdXQ7XG4gICAgfSxcblxuICAgIHNldChfLCBwcm9wOiBhbnksIHZhbHVlOiBUKSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNvcHlPbldyaXRlQXJyYXk8VD4oYmFzZTogVFtdLCBwYXJlbnQ/OiAoKSA9PiB2b2lkKTogVFtdIHtcbiAgLy8gYnVpbGQgb3VyIGNhY2hlIGluY3JlbWVudGFsbHksIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGNvcHlPbldyaXRlIGNhbGxzIHRvIGEgbWluaW11bVxuICBjb25zdCBjYWNoZSA9IEFycmF5PFQgfCB0eXBlb2YgREVMRVRFRD4oYmFzZS5sZW5ndGgpO1xuICBsZXQgY2xlYW4gPSB0cnVlO1xuICBsZXQgZnVsbCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIG1hcmsoKSB7XG4gICAgaWYgKGNsZWFuKSB7XG4gICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgaWYgKHBhcmVudCkgcGFyZW50KCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZGlydHkxKG46IG51bWJlcil7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZVtuXTtcbiAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgbikpe1xuICAgICAgY29uc3Qgb3V0ID0gY2FjaGVbbl07XG4gICAgICByZXR1cm4gb3V0ICE9PSBERUxFVEVEID8gb3V0IDogdW5kZWZpbmVkO1xuICAgIH1cbiAgICBpZiAoIU9iamVjdC5oYXNPd24oYmFzZSwgbikpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgcm8gPSBjb3B5T25Xcml0ZShiYXNlW25dKTtcbiAgICBjYWNoZVtuXSA9IHJvO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCl7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZTtcbiAgICBmdWxsID0gdHJ1ZTtcbiAgICAvLyB1c2UgT2JqZWN0LmtleXMoKSBpbnN0ZWFkIG9mIC5rZXlzKCkgdG8gcHJlc2VydmUgaG9sZXNcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhiYXNlKSkge1xuICAgICAgaWYgKCFPYmplY3QuaGFzT3duKGNhY2hlLCBrZXkpKSB7XG4gICAgICAgIGNhY2hlW2tleSBhcyBhbnldID0gY29weU9uV3JpdGUoYmFzZVtrZXkgYXMgYW55XSwgbWFyayk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIHRvIG1ha2UgdGhpbmdzIGxpa2UgaXRlcmF0aW9uIGVhc3ksIHdlIHJlbW92ZSBERUxFVEVEIGFmdGVyIHdlIGl0ZXJhdGVcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgIGlmICh2YWx1ZSA9PT0gREVMRVRFRCkgZGVsZXRlIGNhY2hlW2tleSBhcyBhbnldO1xuICAgIH1cbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBjb25zdCBjb3dBcnJheU1ldGhvZHM6IGFueSA9IHtcbiAgICAvLyBzcGVjaWFsXG4gICAgYXQ6IChpbmRleDogbnVtYmVyKSA9PiBkaXJ0eTEoaW5kZXggPiAtMSA/IGluZGV4IDogYmFzZS5sZW5ndGggKyBpbmRleCksXG4gICAgcHVzaDogKC4uLmFyZ3M6IGFueVtdKSA9PiAobWFyaygpLCBjYWNoZS5wdXNoKC4uLmFyZ3MpKSxcblxuXG4gICAgLy8gdGhpbmdzIHdoaWNoIHJlcXVpcmUgZGlydHlBbGwoKSwgdGhlbiBydW4gYWdhaW5zdCB0aGUgZnVsbCBzaGFsbG93IGNvcHlcbiAgICBjb25jYXQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuY29uY2F0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGVudHJpZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZW50cmllcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBldmVyeTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5ldmVyeS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaWx0ZXI6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmlsdGVyLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmluZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kSW5kZXg6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmluZEluZGV4LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmRMYXN0OiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmZpbmRMYXN0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmRMYXN0SW5kZXg6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkuZmluZExhc3RJbmRleC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmbGF0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZsYXQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmxhdE1hcDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mbGF0TWFwLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZvckVhY2g6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZm9yRWFjaC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBtYXA6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UubWFwLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHJlZHVjZTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5yZWR1Y2UuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgcmVkdWNlUmlnaHQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UucmVkdWNlUmlnaHQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgc2xpY2U6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uuc2xpY2UuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgc29tZTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5zb21lLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHRvUmV2ZXJzZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9SZXZlcnNlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1NvcnRlZDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS50b1NvcnRlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1NwbGljZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9TcGxpY2VkLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHZhbHVlczogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS52YWx1ZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgd2l0aDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS53aXRoLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIFtTeW1ib2wuaXRlcmF0b3JdOiAoLi4uYXJnczogYW55KSA9PiBiYXNlW1N5bWJvbC5pdGVyYXRvcl0uYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG5cbiAgICAvLyBtdXRhdG9ycyB0aGF0IHJlcXVpcmUgYSBkaXJ0eUFsbCgpIGR1ZSB0byBwb3NzaWJsZSBpbmRleCBjaGFuZ2VzXG4gICAgcG9wOiAoLi4uYXJnczogYW55KSA9PiAobWFyaygpLCBiYXNlLnBvcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgcmV2ZXJzZTogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5yZXZlcnNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBjb3B5V2l0aGluOiAoLi4uYXJnczogYW55KSA9PiAobWFyaygpLCBiYXNlLmNvcHlXaXRoaW4uYXBwbHkoZGlydHlBbGwoKSwgYXJncykpLFxuICAgIGZpbGw6ICguLi5hcmdzOiBhbnkpID0+IChtYXJrKCksIGJhc2UuZmlsbC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgc29ydDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5zb3J0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBzcGxpY2U6ICguLi5hcmdzOiBhbnkpID0+IChtYXJrKCksIGJhc2Uuc3BsaWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBzaGlmdDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5zaGlmdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgdW5zaGlmdDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS51bnNoaWZ0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcblxuICAgIC8vIGdldHRlcnMgd2hpY2ggZG9uJ3QgSEFWRSB0byBjb3dpZnkgdGhlIHdob2xlIGFycmF5LCBidXQgd291bGQgbmVlZCBzb21ldGhpbmcgYWJvdXQgYXMgZXhwZW5zaXZlXG4gICAgdG9Mb2NhbGVTdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudG9Mb2NhbGVTdHJpbmcuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9TdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudG9TdHJpbmcuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgam9pbjogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5qb2luLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gZ2V0dGVycyB3aGljaCB3b3JrIGFnYWluc3QgY2FjaGUgYXMtaXNcbiAgICBrZXlzOiAoKSA9PiBjYWNoZS5rZXlzKCksXG5cbiAgICAvLyBnZXR0ZXJzIHdoaWNoIGNhbiBvcGVyYXRlIG9uIGEgZnJhbmtlbnN0ZWluIGFycmF5IHdoZXJlIGJhc2UgaXMgcHJvdG90eXBlIG9mIGNhY2hlXG4gICAgaW5jbHVkZXM6ICguLi5hcmdzOiBhbnkpID0+IHtcbiAgICAgIGNvbnN0IG9sZCA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihjYWNoZSk7XG4gICAgICB0cnkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIGJhc2UpO1xuICAgICAgICByZXR1cm4gKGNhY2hlIGFzIGFueSkuaW5jbHVkZXMoLi4uYXJncyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIG9sZCk7XG4gICAgICB9XG4gICAgfSxcbiAgICBpbmRleE9mOiAoLi4uYXJnczogYW55KSA9PiB7XG4gICAgICBjb25zdCBvbGQgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoY2FjaGUpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGNhY2hlLCBiYXNlKTtcbiAgICAgICAgcmV0dXJuIChjYWNoZSBhcyBhbnkpLmluZGV4T2YoLi4uYXJncyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIG9sZCk7XG4gICAgICB9XG4gICAgfSxcbiAgICBsYXN0SW5kZXhPZjogKC4uLmFyZ3M6IGFueSkgPT4ge1xuICAgICAgY29uc3Qgb2xkID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKGNhY2hlKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjYWNoZSwgYmFzZSk7XG4gICAgICAgIHJldHVybiAoY2FjaGUgYXMgYW55KS5sYXN0SW5kZXhPZiguLi5hcmdzKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjYWNoZSwgb2xkKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY293QXJyYXlNZXRob2RzLCBudWxsKTtcblxuICBmdW5jdGlvbiBjb3B5KCkge1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGRlZXBDb3B5KGJhc2UpO1xuICAgIGlmIChmdWxsKSByZXR1cm4gZGVlcENvcHkoY2FjaGUpO1xuICAgIGNvbnN0IG91dCA9IEFycmF5KGNhY2hlLmxlbmd0aCk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoYmFzZSkpIHtcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleSBhcyBhbnldID0gZGVlcENvcHkodmFsdWUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgIGlmICh2YWx1ZSAhPT0gREVMRVRFRCkgb3V0W2tleSBhcyBhbnldID0gZGVlcENvcHkodmFsdWUpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgZnVuY3Rpb24gcmN2cigpIHtcbiAgICAvLyB3YXMgYW55IG1vZGlmaWNhdGlvbiBtYWRlP1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGJhc2U7XG4gICAgaWYgKGZ1bGwpIHtcbiAgICAgIGNvbnN0IG91dCA9IEFycmF5KGNhY2hlLmxlbmd0aClcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgICAgb3V0W2tleSBhcyBhbnldID0gcmVjb3Zlcih2YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgY29uc3Qgb3V0ID0gQXJyYXkoY2FjaGUubGVuZ3RoKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoYmFzZSkpIHtcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleSBhcyBhbnldID0gdmFsO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICBpZiAodmFsICE9PSBERUxFVEVEKSBvdXRba2V5IGFzIGFueV0gPSByZWNvdmVyKHZhbCk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICByZXR1cm4gbmV3IFByb3h5KGJhc2UsIHtcbiAgICBkZWZpbmVQcm9wZXJ0eSgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0ZWQgYnkgY29weU9uV3JpdGVcIik7XG4gICAgfSxcblxuICAgIGRlbGV0ZVByb3BlcnR5KF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKGZ1bGwpIHtcbiAgICAgICAgaWYgKE9iamVjdC5oYXNPd24oYmFzZSwgcHJvcCkpIG1hcmsoKTtcbiAgICAgICAgZGVsZXRlIGNhY2hlW3Byb3BdO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIG1hcmsoKTtcbiAgICAgIGNhY2hlW3Byb3BdID0gREVMRVRFRDtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApO1xuICAgICAgaWYgKGNhY2hlW3Byb3BdID09PSBERUxFVEVEKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApID8/XG4gICAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoYmFzZSwgcHJvcCk7XG4gICAgfSxcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gY29weTtcbiAgICAgIGlmIChwcm9wID09PSByZWNvdmVyU3ltKSByZXR1cm4gcmN2cjtcblxuICAgICAgLy8gc3BlY2lhbCBsb2dpYyBpZiB3ZSBoYXZlIG5vIG1vcmUgREVMRVRFRHMgaW4gY2FjaGVcbiAgICAgIGlmIChmdWxsKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGNhY2hlLCBwcm9wKSkge1xuICAgICAgICAgIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtZXRob2QgPSBjb3dBcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICAgIGlmIChtZXRob2QpIHJldHVybiBtZXRob2Q7XG4gICAgICAgIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIH1cblxuICAgICAgLy8gbG9va3VwIHZhbHVlIGluIGNhY2hlIGZpcnN0XG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBjYWNoZVtwcm9wXTtcbiAgICAgICAgcmV0dXJuIHZhbHVlICE9PSBERUxFVEVEID8gdmFsdWUgOiB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICAvLyB0aGVuIGdldCBjYWNoZWFibGUgdmFsdWUgZnJvbSBiYXNlXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihiYXNlLCBwcm9wKSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvcHlPbldyaXRlKGJhc2VbcHJvcF0sIG1hcmspO1xuICAgICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIC8vIGdldCBtZXRob2RzXG4gICAgICBjb25zdCBtZXRob2QgPSBjb3dBcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IGJhc2VbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoY2FjaGUsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIE9iamVjdC5oYXNPd24oY2FjaGUsIHByb3ApO1xuICAgICAgaWYgKE9iamVjdC5oYXNPd24oY2FjaGUsIHByb3ApKSByZXR1cm4gY2FjaGVbcHJvcF0gIT09IERFTEVURUQ7XG4gICAgICByZXR1cm4gcHJvcCBpbiBiYXNlO1xuICAgIH0sXG5cbiAgICBvd25LZXlzKCkge1xuICAgICAgaWYgKGZ1bGwpIHJldHVybiBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyhjYWNoZSk7XG4gICAgICBjb25zdCBvdXQgPSBbXCJsZW5ndGhcIl07XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhiYXNlKSkge1xuICAgICAgICBpZiAoY2FjaGVba2V5IGFzIGFueV0gPT09IERFTEVURUQpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2FjaGUpKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIGtleSkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoY2FjaGVba2V5IGFzIGFueV0gIT09IERFTEVURUQpIG91dC5wdXNoKGtleSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH0sXG5cbiAgICBzZXQoXywgcHJvcDogYW55LCB2YWx1ZTogVCkge1xuICAgICAgbWFyaygpO1xuICAgICAgY2FjaGVbcHJvcF0gPSB2YWx1ZTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjb3B5T25Xcml0ZU1hcDxLLCBWPihiYXNlOiBNYXA8SywgVj4sIHBhcmVudD86ICgpID0+IHZvaWQpOiBNYXA8SywgVj4ge1xuICAvLyBidWlsZCBvdXIgY2FjaGUgaW5jcmVtZW50YWxseSwgdG8gcmVkdWNlIHRoZSBudW1iZXIgb2YgY29weU9uV3JpdGUgY2FsbHMgdG8gYSBtaW5pbXVtXG4gIGNvbnN0IGNhY2hlOiBNYXA8SywgViB8IHR5cGVvZiBERUxFVEVEPiA9IG5ldyBNYXAoKTtcbiAgbGV0IGNsZWFuID0gdHJ1ZTtcbiAgbGV0IGZ1bGwgPSBmYWxzZTtcbiAgbGV0IG5kZWxldGlvbnMgPSAwO1xuICBsZXQgbm92ZXJsYXAgPSAwO1xuXG4gIGZ1bmN0aW9uIHNpemUoKSB7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZS5zaXplO1xuICAgIHJldHVybiBiYXNlLnNpemUgKyBjYWNoZS5zaXplIC0gbmRlbGV0aW9ucyAtIG5vdmVybGFwO1xuICB9XG5cbiAgZnVuY3Rpb24gbWFyaygpIHtcbiAgICBpZiAoY2xlYW4pIHtcbiAgICAgIGNsZWFuID0gZmFsc2U7XG4gICAgICBpZiAocGFyZW50KSBwYXJlbnQoKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBkaXJ0eTEoazogSykge1xuICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGUuZ2V0KGspO1xuICAgIGlmIChjYWNoZS5oYXMoaykpIHtcbiAgICAgIGNvbnN0IG91dCA9IGNhY2hlLmdldChrKTtcbiAgICAgIHJldHVybiBvdXQgIT09IERFTEVURUQgPyBvdXQgOiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGlmICghYmFzZS5oYXMoaykpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgY293ID0gY29weU9uV3JpdGUoYmFzZS5nZXQoaykhLCBtYXJrKTtcbiAgICBjYWNoZS5zZXQoaywgY293KTtcbiAgICBub3ZlcmxhcCsrO1xuICAgIHJldHVybiBjb3c7XG4gIH1cblxuICBmdW5jdGlvbiBkaXJ0eUFsbCgpe1xuICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGU7XG4gICAgZnVsbCA9IHRydWU7XG4gICAgY29uc3QgZGVsZXRlZCA9IG5ldyBTZXQ8Sz4oKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBjYWNoZSkge1xuICAgICAgaWYgKHYgPT09IERFTEVURUQpIGRlbGV0ZWQuYWRkKGspO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBiYXNlKSB7XG4gICAgICBpZiAoIWNhY2hlLmhhcyhrKSkge1xuICAgICAgICBjYWNoZS5zZXQoaywgY29weU9uV3JpdGUodiwgbWFyaykpO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGsgb2YgZGVsZXRlZCkge1xuICAgICAgY2FjaGUuZGVsZXRlKGspO1xuICAgIH1cbiAgICBuZGVsZXRpb25zID0gMDtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBmdW5jdGlvbiBjb3B5KCkge1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGRlZXBDb3B5KGJhc2UpO1xuICAgIGlmIChmdWxsKSByZXR1cm4gZGVlcENvcHkoY2FjaGUpO1xuICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBiYXNlLmVudHJpZXMoKSkge1xuICAgICAgaWYgKCFjYWNoZS5oYXMoa2V5KSkgb3V0LnNldChrZXksIGRlZXBDb3B5KHZhbHVlKSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGNhY2hlLmVudHJpZXMoKSkge1xuICAgICAgaWYgKHZhbHVlICE9PSBERUxFVEVEKSBvdXQuc2V0KGtleSwgZGVlcENvcHkodmFsdWUpKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJjdnIoKSB7XG4gICAgLy8gd2FzIGFueSBtb2RpZmljYXRpb24gbWFkZT9cbiAgICBpZiAoY2xlYW4pIHJldHVybiBiYXNlO1xuICAgIC8vIGRpZCB3ZSBhbHJlYWR5IGNvcHkgYWxsIGtleXMgYW5kIGVsaW1pbmF0ZSBkZWxldGlvbnM/XG4gICAgaWYgKGZ1bGwpIHtcbiAgICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIGNhY2hlKSB7XG4gICAgICAgIG91dC5zZXQoaywgcmVjb3Zlcih2KSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICAvLyBzdGFydCB3aXRoIGEgc2hhbGxvdyBjb3B5XG4gICAgY29uc3Qgb3V0ID0gbmV3IE1hcChiYXNlKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBjYWNoZSkge1xuICAgICAgaWYgKHYgPT09IERFTEVURUQpIHtcbiAgICAgICAgb3V0LmRlbGV0ZShrKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dC5zZXQoaywgcmVjb3Zlcih2KSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICBsZXQgcHJveHk6IE1hcDxLLCBWPjtcblxuICAvLyBjcmVhdGUgYSBvbmUtb2ZmIG1ldGhvZHMgb2JqZWN0LCBzaW5jZSB3ZSBoYXZlIGEgbG90IG9mIHN0dWZmIHRvIGJpbmQgaW50byBpdFxuICBjb25zdCBjb3dNYXBNZXRob2RzOiBhbnkgPSB7XG4gICAgLy8gc3BlY2lhbFxuICAgIGdldDogKGtleTogSykgPT4gZGlydHkxKGtleSksXG4gICAgaGFzOiAoa2V5OiBLKSA9PiB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKGNhY2hlLmhhcyhrZXkpKSB7XG4gICAgICAgIHJldHVybiBjYWNoZS5nZXQoa2V5KSAhPT0gREVMRVRFRDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBiYXNlLmhhcyhrZXkpO1xuICAgIH0sXG4gICAgY2xlYXIoKSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBmdWxsID0gdHJ1ZTtcbiAgICAgIHJldHVybiBjYWNoZS5jbGVhcigpO1xuICAgIH0sXG5cbiAgICAvLyByZXF1aXJlcyBkaXJ0eUFsbFxuICAgIGtleXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uua2V5cy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBlbnRyaWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmVudHJpZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZm9yRWFjaDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mb3JFYWNoLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHZhbHVlczogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS52YWx1ZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgW1N5bWJvbC5pdGVyYXRvcl06ICguLi5hcmdzOiBhbnkpID0+IGJhc2VbU3ltYm9sLml0ZXJhdG9yXS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcblxuICAgIC8vIG11dGF0b3JzXG4gICAgZGVsZXRlOiAoa2V5OiBLKSA9PntcbiAgICAgIG1hcmsoKTtcbiAgICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGUuZGVsZXRlKGtleSk7XG4gICAgICBjb25zdCBvbGQgPSBjYWNoZS5nZXQoa2V5KTtcbiAgICAgIGlmIChvbGQgPT09IERFTEVURUQpIHJldHVybiBmYWxzZTsgLy8gbm9vcDsgYWxyZWFkeSBtYXJrZWQgYXMgZGVsZXRlZFxuICAgICAgY29uc3QgaW5jYWNoZSA9IG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKCFiYXNlLmhhcyhrZXkpKSB7XG4gICAgICAgIC8vIGtleSBub3QgaW4gYmFzZTogaXMgaXQgbmV3bHkgYWRkZWQgdG8gY2FjaGUsIG9yIHRvdGFsbHkgbWlzc2luZz9cbiAgICAgICAgaWYgKCFpbmNhY2hlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGNhY2hlLmRlbGV0ZShrZXkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIC8vIGtleSBpcyBpbiBiYXNlOyBhZGQgYSBuZXcgZGVsZXRpb24gbWFya2VyXG4gICAgICBjYWNoZS5zZXQoa2V5LCBERUxFVEVEKTtcbiAgICAgIG5kZWxldGlvbnMrKztcbiAgICAgIGlmICghaW5jYWNoZSkge1xuICAgICAgICBub3ZlcmxhcCsrO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICBnZXRPckluc2VydDogKGtleTogSywgZGVmYXVsdFZhbHVlOiBWKSA9PiB7XG4gICAgICBsZXQgb2xkID0gY2FjaGUuZ2V0KGtleSk7XG4gICAgICBpZiAob2xkID09PSBERUxFVEVEKSB7XG4gICAgICAgIC8vIHVuZGVsZXRlIGEgZGVsZXRlZCBrZXlcbiAgICAgICAgY2FjaGUuc2V0KGtleSwgZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgbmRlbGV0aW9ucy0tO1xuICAgICAgICByZXR1cm4gZGVmYXVsdFZhbHVlO1xuICAgICAgfVxuICAgICAgaWYgKG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpKSByZXR1cm4gb2xkO1xuICAgICAgLy8gbm90IGluIGNhY2hlOyBjaGVjayBiYXNlXG4gICAgICBvbGQgPSBiYXNlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCAhPT0gdW5kZWZpbmVkIHx8IGJhc2UuaGFzKGtleSkpIHJldHVybiBvbGQ7XG4gICAgICAvLyBub3QgaW4gYmFzZSBlaXRoZXI7IGRvIGFuIGluc2VydFxuICAgICAgbWFyaygpO1xuICAgICAgY2FjaGUuc2V0KGtleSwgZGVmYXVsdFZhbHVlKTtcbiAgICAgIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gICAgfSxcbiAgICBnZXRPckluc2VydENvbXB1dGVkOiAoa2V5OiBLLCBjYWxsYmFjazogKGtleTogSykgPT4gVikgPT4ge1xuICAgICAgbGV0IG9sZCA9IGNhY2hlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCA9PT0gREVMRVRFRCkge1xuICAgICAgICAvLyB1bmRlbGV0ZSBhIGRlbGV0ZWQga2V5XG4gICAgICAgIGNvbnN0IHZhbHVlID0gY2FsbGJhY2soa2V5KTtcbiAgICAgICAgY2FjaGUuc2V0KGtleSwgdmFsdWUpO1xuICAgICAgICBuZGVsZXRpb25zLS07XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChvbGQgIT09IHVuZGVmaW5lZCB8fCBjYWNoZS5oYXMoa2V5KSkgcmV0dXJuIG9sZDtcbiAgICAgIC8vIG5vdCBpbiBjYWNoZTsgY2hlY2sgYmFzZVxuICAgICAgb2xkID0gYmFzZS5nZXQoa2V5KTtcbiAgICAgIGlmIChvbGQgIT09IHVuZGVmaW5lZCB8fCBiYXNlLmhhcyhrZXkpKSByZXR1cm4gb2xkO1xuICAgICAgLy8gbm90IGluIGJhc2UgZWl0aGVyOyBkbyBhbiBpbnNlcnRcbiAgICAgIG1hcmsoKTtcbiAgICAgIGNvbnN0IHZhbHVlID0gY2FsbGJhY2soa2V5KTtcbiAgICAgIGNhY2hlLnNldChrZXksIHZhbHVlKTtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9LFxuICAgIHNldDogKGtleTogSywgdmFsdWU6IFYpID0+IHtcbiAgICAgIG1hcmsoKTtcbiAgICAgIGNvbnN0IG9sZCA9IGNhY2hlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCA9PT0gREVMRVRFRCkgbmRlbGV0aW9ucy0tO1xuICAgICAgY29uc3QgaW5jYWNoZSA9IG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKCFpbmNhY2hlICYmIGJhc2UuaGFzKGtleSkpIG5vdmVybGFwKys7XG4gICAgICBjYWNoZS5zZXQoa2V5LCB2YWx1ZSk7XG4gICAgICAvLyBkb24ndCByZXR1cm4gdGhlIGNhY2hlIG9yIHRoZSBiYXNlOyByZXR1cm4gdGhlIGNvcHktb24td3JpdGUgcHJveHlcbiAgICAgIHJldHVybiBwcm94eTtcbiAgICB9LFxuICB9O1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY293TWFwTWV0aG9kcywgbnVsbCk7XG5cbiAgcHJveHkgPSBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBzZXQoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuIGNvcHk7XG4gICAgICBpZiAocHJvcCA9PT0gcmVjb3ZlclN5bSkgcmV0dXJuIHJjdnI7XG5cbiAgICAgIGlmIChwcm9wID09PSBcInNpemVcIikgcmV0dXJuIHNpemUoKTtcblxuICAgICAgLy8gZ2V0IG1ldGhvZHNcbiAgICAgIGNvbnN0IG1ldGhvZCA9IGNvd01hcE1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IChiYXNlIGFzIGFueSlbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoY2FjaGUsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICAvLyB3ZSBkb24ndCBzdXBwb3J0IGN1c3RvbSBvd24gcHJvcGVydGllcyBvciBwcm90b3R5cGVzLCBzbyB0aGlzIGlzIHN1ZmZpY2llbnRcbiAgICAgIHJldHVybiBwcm9wIGluIGNhY2hlO1xuICAgIH0sXG5cbiAgICBvd25LZXlzKCkge1xuICAgICAgLy8gd2UgZG9uJ3Qgc3VwcG9ydCBjdXN0b20gb3duIHByb3BlcnRpZXNcbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gcHJveHk7XG59XG5cbmZ1bmN0aW9uIGNvcHlPbldyaXRlU2V0PEs+KGJhc2U6IFNldDxLPiwgcGFyZW50PzogKCkgPT4gdm9pZCkge1xuICAvLyBzaW5jZSB3ZSBoYXZlIG5vIGNoaWxkIGNvdyBvYmplY3RzLCBhcyBzb29uIGFzIHdlIGdldCBhbiB1cGRhdGUgd2UgZG8gYSBmdWxsIGNvcHkgYW5kIHVzZSB0aGF0XG4gIGxldCBjYWNoZTogU2V0PEs+IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBzZXQoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGNhY2hlID8/IGJhc2UpO1xuICAgICAgaWYgKHByb3AgPT09IHJlY292ZXJTeW0pIHJldHVybiAoKSA9PiBjYWNoZSA/PyBiYXNlO1xuXG4gICAgICBpZiAocHJvcCA9PT0gXCJhZGRcIiB8fCBwcm9wID09PSBcImRlbGV0ZVwiIHx8IHByb3AgPT09IFwiY2xlYXJcIikge1xuICAgICAgICBpZiAoY2FjaGUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIC8vIGJyZWFrIHRoZSBnbGFzc1xuICAgICAgICAgIGNhY2hlID0gbmV3IFNldChiYXNlKTtcbiAgICAgICAgICBpZihwYXJlbnQpIHBhcmVudCgpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKChjYWNoZSA/PyBiYXNlKSBhcyBhbnkpW3Byb3BdO1xuICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRnVuY3Rpb24pIHtcbiAgICAgICAgcmV0dXJuICguLi5hcmdzOiBhbnkpID0+IHZhbHVlLmFwcGx5KGNhY2hlID8/IGJhc2UsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICAvLyB3ZSBkb24ndCBzdXBwb3J0IGN1c3RvbSBvd24gcHJvcGVydGllcyBvciBwcm90b3R5cGVzLCBzbyB0aGlzIGlzIHN1ZmZpY2llbnRcbiAgICAgIHJldHVybiBwcm9wIGluIChiYXNlIGFzIGFueSk7XG4gICAgfSxcblxuICAgIG93bktleXMoXykge1xuICAgICAgLy8gd2UgZG9uJ3Qgc3VwcG9ydCBjdXN0b20gb3duIHByb3BlcnRpZXNcbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gZnV0dXJlcyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4vKiBBIEZ1dHVyZSBpcyBhIGZ1bmN0aW9uIHRoYXQgeWllbGRzIG5vdGhpbmcsIGlzIHdva2VuIHVwIHdpdGggbm90aGluZywgYW5kIGV2ZW50dWFsbHkgcmV0dXJucyBUICovXG5leHBvcnQgdHlwZSBGdXR1cmU8VD4gPSBHZW5lcmF0b3I8dm9pZCwgVCwgdm9pZD47XG5cbi8qIEEgRnV0dXJlQ29udGV4dCBjb3JyZXNwb25kcyB0byB0aGUgZmlyc3QgZ2VuZXJhdG9yIGluIG91ciBjYWxsc3RhY2suICBUaG91Z2ggaXQgbWF5IGJlIGRlbGVnYXRpbmdcbiAgIHlpZWxkcyB0byBzb21lIGNoaWxkIGdlbmVyYXRvciB0aHJvdWdoIHlpZWxkKiBzdGF0ZW1lbnRzLCB3aGVuIGEgY29uZGl0aW9uIGlzIG1ldCB0byB3YWtlIHVwIHRoZVxuICAgY2hpbGQsIHRoZSAubmV4dCgpIGhhcyB0byBiZSBzZW50IHRvIHRoZSByb290IGdlbmVyYXRvciwgbm90IHRoZSBjaGlsZCAob3IgZ3JhbmRjaGlsZCkuXG5cbiAgIEZ1dHVyZUNvbnRleHQgbWFrZXMgdGhhdCB0cml2aWFsLiAqL1xuZXhwb3J0IGNsYXNzIEZ1dHVyZUNvbnRleHQge1xuICAjY29ybzogR2VuZXJhdG9yO1xuICAjYXdha2U6IGJvb2xlYW4gPSBmYWxzZTtcblxuICBjb25zdHJ1Y3Rvcihjb3JvOiBHZW5lcmF0b3IpIHtcbiAgICB0aGlzLiNjb3JvID0gY29ybztcbiAgfVxuXG4gIHdha2V1cCgpIHtcbiAgICAvLyBkaXNhbGxvdyBjYWxscyB0byB0aGUgYmFzZSB3YWtldXAgZnJvbSBpbnNpZGUgdGhlIGJhc2Ugd2FrZXVwXG4gICAgaWYgKHRoaXMuI2F3YWtlKSByZXR1cm47XG4gICAgdGhpcy4jYXdha2UgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICB0aGlzLiNjb3JvLm5leHQoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy4jYXdha2UgPSBmYWxzZTtcbiAgICB9XG4gIH1cblxuICB0aHJvdyhlOiBFcnJvcikge1xuICAgIC8vIGlmIHdlJ3JlIGFjdHVhbGx5IGluc2lkZSB0aGUgY29ybywgdGhyb3cgdGhlIGVycm9yIG5vd1xuICAgIGlmICh0aGlzLiNhd2FrZSkgdGhyb3coZSk7XG4gICAgdGhpcy4jYXdha2UgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICB0aGlzLiNjb3JvLnRocm93KGUpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLiNhd2FrZSA9IGZhbHNlO1xuICAgIH1cbiAgfVxufVxuXG4vLyBzdG9yYWdlIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbi8vIGFuIGluZGV4ZWRkYi1jb21wYXRpYmxlLCB0cmFuc2FjdGlvbmFsIGtleS12YWx1ZSBzdG9yZSBidWlsdCBhcm91bmQgZ2VuZXJhdG9ycy5cbi8vXG4vLyBBIG5vdGUgYWJvdXQgdHlwaW5nOiB0aGUgU3RvcmFnZSBpbnRlcmZhY2UgbXVzdCByZWNlaXZlIGEgdmFsdWUgd2l0aCAuc2V0KCkgYW5kIHJldHVybiB0aGUgc2FtZVxuLy8gdHlwZSB2YWx1ZSB3aXRoIC5nZXQoKS4gIEl0IG11c3Qgbm90IG1hdHRlciB3aGljaCBpbXBsZW1lbnRhdGlvbiBvZiBTdG9yYWdlIGlzIGluIHVzZS4gIEhvd2V2ZXIsXG4vLyBtb3N0IG9mIHRoZSBhY2Nlc3MgdG8gc3RvcmFnZSBpcyB1bnR5cGVkLiAgU28gc3RvcmFnZSBjYW5ub3QgZ2V0KCkgYW5kIHNldCgpIHRoZSByZWFsIHByb3RvXG4vLyB2YWx1ZXMuICBJbnN0ZWFkLCBhIFN0b3JhZ2UgaW1wbGVtZW50YXRpb24gd2hpY2ggc3RvcmVzIGFueXdoZXJlIG90aGVyIHRoYW4gaW4tbWVtb3J5IG11c3QgZG9cbi8vIHRoZSB0eXBlLXRvLXN0b3JhZ2UgY29udmVyc2lvbiBpbnRlcm5hbGx5LiAgVGhlbiBhbnkgZ2VuZXJhdGVkIHR5cGVkIGdldHRlcnMgYnVpbHQgYXJvdW5kIHRoZVxuLy8gU3RvcmFnZSBpbnRlcmZhY2Ugc2hhbGwgYmUgbWVyZWx5IHR5cGVjYXN0aW5nIHdyYXBwZXJzLlxuXG4vLyBTdG9yYWdlIGlzIHRoZSBpbnRlcmZhY2UgZm9yIGNyZWF0aW5nIHJlYWQgYW5kIHdyaXRlIHRyYW5zYXNjdGlvbnMuICBBbiBpbXBsZW1lbnRhdGlvbiBvZiBTdG9yYWdlXG4vLyBpcyBjYWxsYmFjay1iYXNlZCBhbmQgc2hvdWxkIHN1cHBvcnQgbXVsdGlwbGUgcGFyYWxsZWwgZ2V0cyBhbmQgc2V0cyBhdCB0aGUgQVBJIGxldmVsLCBldmVuIGlmXG4vLyB0aGV5IG11c3QgYmUgc2VyaWFsaXplZCBpbnRlcm5hbGx5LiAgVGhlIHJ1blR4biBmdW5jdGlvbiBpcyB1c2VkIHRvIGNvbnZlcnQgdGhlIGNhbGxiYWNrXG4vLyBpbnRlcmZhY2Ugb2YgV1R4biBhbmQgUlR4biB0byB0aGUgU3RvcmFnZUdlbmVyYXRvciBwcm90b2NvbC5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZSB7XG4gIHdpdGhXVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+O1xuICB3aXRoUlR4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFJUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPjtcbn1cblxuZXhwb3J0IHR5cGUgU3RvcmFnZVZhbHVlID0ge3ZhbHVlOiB1bmtub3dufSB8IHtlcnI6IEVycm9yfTtcbmV4cG9ydCB0eXBlIFN0b3JhZ2VEb25lID0ge3ZhbHVlOiB0cnVlfSB8IHtlcnI6IEVycm9yfTtcblxuZXhwb3J0IGludGVyZmFjZSBXVHhuIHtcbiAgZ2V0KGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKTogdm9pZDtcbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZDtcbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkO1xufTtcblxuZXhwb3J0IGludGVyZmFjZSBSVHhuIHtcbiAgZ2V0KGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKTogdm9pZDtcbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZDtcbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkO1xufTtcblxuZXhwb3J0IHR5cGUgV1N0b3JhZ2VRdWVzdGlvbiA9IHtcbiAgLy8ga2V5cyB0byBsb29rIHVwXG4gIGdldD86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxuICAvLyBrZXktdmFsdWVzIHRvIHNldFxuICBzZXQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgLy8ga2V5LXZhbHVlcyB0byBkZWxldGVcbiAgZGVsPzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG59O1xuXG5leHBvcnQgdHlwZSBSU3RvcmFnZVF1ZXN0aW9uID0ge1xuICAvLyBrZXlzIHRvIGxvb2sgdXBcbiAgZ2V0PzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG59O1xuXG5leHBvcnQgdHlwZSBTdG9yYWdlQW5zd2VyID0ge1xuICAvLyBrZXktdmFsdWUgbG9va3VwIHJlc3VsdHNcbiAgZ2V0OiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXlzIGRvbmUgc2V0dGluZ1xuICBzZXQ6IFJlY29yZDxzdHJpbmcsIFN0b3JhZ2VEb25lPixcbiAgLy8ga2V5cyBkb25lIGRlbGV0aW5nXG4gIGRlbDogUmVjb3JkPHN0cmluZywgU3RvcmFnZURvbmU+LFxufTtcblxuZXhwb3J0IHR5cGUgV1N0b3JhZ2VHZW5lcmF0b3I8VD4gPSBHZW5lcmF0b3I8V1N0b3JhZ2VRdWVzdGlvbiwgVCwgU3RvcmFnZUFuc3dlcj47XG5leHBvcnQgdHlwZSBSU3RvcmFnZUdlbmVyYXRvcjxUPiA9IEdlbmVyYXRvcjxSU3RvcmFnZVF1ZXN0aW9uLCBULCBTdG9yYWdlQW5zd2VyPjtcblxuLy8gZnVuY3Rpb24gdG8gaW50ZXJhY3Qgd2l0aCB0aGUgU3RvcmFnZUdlbmVyYXRvclxuZXhwb3J0IGZ1bmN0aW9uICp0eG5HZXQoa2V5OiBzdHJpbmcpOiBSU3RvcmFnZUdlbmVyYXRvcjx1bmtub3duPntcbiAgY29uc3QgYW5zID0gKHlpZWxkIHtcImdldFwiOiB7W2tleV06IHRydWV9fSkuZ2V0W2tleV07XG4gIGlmIChcImVyclwiIGluIGFucykge1xuICAgIHRocm93IGFucy5lcnI7XG4gIH1cbiAgcmV0dXJuIGFucy52YWx1ZTtcbn1cblxuLy8gYSBmdW5jdGlvbiB0byBpbnRlcmFjdCB3aXRoIHRoZSBTdG9yYWdlR2VuZXJhdG9yXG5leHBvcnQgZnVuY3Rpb24gKnR4blNldChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBXU3RvcmFnZUdlbmVyYXRvcjx2b2lkPiB7XG4gIGNvbnN0IGFucyA9ICh5aWVsZCB7XCJzZXRcIjoge1trZXldOiB2YWx1ZX19KS5zZXRba2V5XTtcbiAgaWYgKFwiZXJyXCIgaW4gYW5zKSB7XG4gICAgdGhyb3cgYW5zLmVycjtcbiAgfVxufVxuXG4vLyBhIGZ1bmN0aW9uIHRvIGludGVyYWN0IHdpdGggdGhlIFN0b3JhZ2VHZW5lcmF0b3JcbmV4cG9ydCBmdW5jdGlvbiAqdHhuRGVsKGtleTogc3RyaW5nKTogV1N0b3JhZ2VHZW5lcmF0b3I8dm9pZD4ge1xuICBjb25zdCBhbnMgPSAoeWllbGQge1wiZGVsXCI6IHtba2V5XTogdHJ1ZX19KS5kZWxba2V5XTtcbiAgaWYgKFwiZXJyXCIgaW4gYW5zKSB7XG4gICAgdGhyb3cgYW5zLmVycjtcbiAgfVxufVxuXG4vLyBhIGZ1bmN0aW9uIHRvIGhpZGUgc29tZSBvZiB0aGUgYm9pbGVycGxhdGUgb2Ygb3BlbmluZyBhIFdUeG5cbmV4cG9ydCBmdW5jdGlvbiAqd2l0aFdUeG48VD4oXG4gIGZ4OiBGdXR1cmVDb250ZXh0LCBzOiBTdG9yYWdlLCBmbjogKCkgPT4gV1N0b3JhZ2VHZW5lcmF0b3I8VD4sXG4pOiBGdXR1cmU8VD4ge1xuICByZXR1cm4geWllbGQqIHMud2l0aFdUeG4oZngsIGZ1bmN0aW9uKih0eG4pe1xuICAgIHJldHVybiB5aWVsZCogcnVuVHhuKGZ4LCB0eG4sIGZuKCkpO1xuICB9KTtcbn1cblxuLy8gYSBmdW5jdGlvbiB0byBoaWRlIHNvbWUgb2YgdGhlIGJvaWxlcnBsYXRlIG9mIG9wZW5pbmcgYSBSVHhuXG5leHBvcnQgZnVuY3Rpb24gKndpdGhSVHhuPFQ+KFxuICBmeDogRnV0dXJlQ29udGV4dCwgczogU3RvcmFnZSwgZm46ICgpID0+IFJTdG9yYWdlR2VuZXJhdG9yPFQ+LFxuKTogRnV0dXJlPFQ+IHtcbiAgcmV0dXJuIHlpZWxkKiBzLndpdGhSVHhuKGZ4LCBmdW5jdGlvbioodHhuKXtcbiAgICByZXR1cm4geWllbGQqIHJ1blR4bihmeCwgdHhuLCBmbigpKTtcbiAgfSk7XG59XG5cbi8vIHJ1biBhIFN0b3JhZ2VHZW5lcmF0b3IgdG8gY29tcGxldGlvbiwgY29udmVydGluZyBwb3RlbnRpYWxseSBtYW55IHBhcmFsbGVsIGNhbGxiYWNrcyBpbnRvIGFcbi8vIGdlbmVyYXRvciBpbnRlcmZhY2UuXG5mdW5jdGlvbiAqcnVuVHhuPFQ+KFxuICBmeDogRnV0dXJlQ29udGV4dCwgdHhuOiBXVHhuLCBnOiBXU3RvcmFnZUdlbmVyYXRvcjxUPixcbik6IEZ1dHVyZTxUPiB7XG4gIC8vIGlnbm9yZSBsYXRlIGNhbGxiYWNrc1xuICBsZXQgdmFsaWQgPSB0cnVlO1xuICB0cnkge1xuICAgIGxldCBhbnM6IFN0b3JhZ2VBbnN3ZXIgPSB7Z2V0OiB7fSwgc2V0OiB7fSwgZGVsOiB7fX07XG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBnLm5leHQoYW5zKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgIGFucyA9IHtnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICAgIHJlYWR5ID0gZmFsc2U7XG5cbiAgICAgIC8vIHN0YXJ0IGdldHNcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLmdldCA/PyB7fSkpIHtcbiAgICAgICAgdHhuLmdldChrZXksIChyZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoIXZhbGlkKSByZXR1cm47ICAvLyBpZ25vcmUgbGF0ZSBjYWxsYmFja1xuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHJlc3VsdDtcbiAgICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICAgICAgZngud2FrZXVwKCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBzdGFydCBzZXRzXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUuc2V0ID8/IHt9KSkge1xuICAgICAgICB0eG4uc2V0KGtleSwgdmFsLCAocmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKCF2YWxpZCkgcmV0dXJuOyAgLy8gaWdub3JlIGxhdGUgY2FsbGJhY2tcbiAgICAgICAgICBhbnMuc2V0W2tleV0gPSByZXN1bHQ7XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICAgIGZ4Lndha2V1cCgpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gc3RhcnQgZGVsZXRlc1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuZGVsID8/IHt9KSkge1xuICAgICAgICB0eG4uZGVsKGtleSwgKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGlmICghdmFsaWQpIHJldHVybjsgIC8vIGlnbm9yZSBsYXRlIGNhbGxiYWNrXG4gICAgICAgICAgYW5zLmRlbFtrZXldID0gcmVzdWx0O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICBmeC53YWtldXAoKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIHdhaXQgZm9yIGEgcmVzdWx0XG4gICAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgdmFsaWQgPSBmYWxzZTtcbiAgfVxufVxuXG50eXBlIFN0b3JhZ2VDb2RlcnMgPSB7XG4gIGVuY29kZXI6IChrZXk6IHN0cmluZywgdmFsOiB1bmtub3duKSA9PiB1bmtub3duLFxuICBkZWNvZGVyOiAoa2V5OiBzdHJpbmcsIHZhbDogdW5rbm93bikgPT4gdW5rbm93bixcbn07XG5cbmV4cG9ydCBjbGFzcyBJbmRleGVkREJTdG9yYWdlIHtcbiAgI2RiOiBJREJEYXRhYmFzZTtcbiAgI3N0b3JlOiBzdHJpbmc7XG4gICNjb2RlcnM6IFN0b3JhZ2VDb2RlcnM7XG5cbiAgY29uc3RydWN0b3IoZGI6IElEQkRhdGFiYXNlLCBzdG9yZTogc3RyaW5nLCBjb2RlcnM6IFN0b3JhZ2VDb2RlcnMpIHtcbiAgICB0aGlzLiNkYiA9IGRiO1xuICAgIHRoaXMuI3N0b3JlID0gc3RvcmU7XG4gICAgdGhpcy4jY29kZXJzID0gY29kZXJzXG4gIH1cblxuICAqI3dpdGhUeG48VD4oXG4gICAgZng6IEZ1dHVyZUNvbnRleHQsIG1vZGU6IElEQlRyYW5zYWN0aW9uTW9kZSwgZm46ICh0eG46IFdUeG4pID0+IEZ1dHVyZTxUPixcbiAgKTogRnV0dXJlPFQ+IHtcbiAgICAvLyBjcmVhdGUgdGhlIHRyYW5zYWN0aW9uXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XG4gICAgY29uc3QgdHhuID0gdGhpcy4jZGIudHJhbnNhY3Rpb24oW3RoaXMuI3N0b3JlXSwgbW9kZSk7XG4gICAgdHhuLm9uZXJyb3IgPSAoLypldmVudCovKSA9PiB7XG4gICAgICAvLyBub2JvZHkgdG8gc2VuZCB0aGUgZXJyb3IgdG8sIHNvIGp1c3QgY3Jhc2ggdGhlIGNvcm91dGluZVxuICAgICAgZngudGhyb3cobmV3IEVycm9yKFwidHhuIGZhaWxlZFwiKSk7XG4gICAgfTtcbiAgICB0eG4ub25hYm9ydCA9ICgvKmV2ZW50Ki8pID0+IHtcbiAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgIGZ4Lndha2V1cCgpO1xuICAgIH07XG4gICAgdHhuLm9uY29tcGxldGUgPSAoLypldmVudCovKSA9PiB7XG4gICAgICByZWFkeSA9IHRydWU7XG4gICAgICBmeC53YWtldXAoKTtcbiAgICB9O1xuICAgIGNvbnN0IHN0b3JlID0gdHhuLm9iamVjdFN0b3JlKHRoaXMuI3N0b3JlKTtcbiAgICBjb25zdCBpbmRleGVkREJUeG4gPSBuZXcgSW5kZXhlZERCVHhuKHN0b3JlLCB0aGlzLiNjb2RlcnMpO1xuXG4gICAgLy8gcnVuIHRoZSB1c2VyIGZ1bmN0aW9uXG4gICAgbGV0IHJlc3VsdDogVDtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0geWllbGQqIGZuKGluZGV4ZWREQlR4bik7XG4gICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgdHhuLmFib3J0KCk7XG4gICAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICAgIHR4bi5jb21taXQoKTtcbiAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgKndpdGhXVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZngsIFwicmVhZHdyaXRlXCIsIGZuKTtcbiAgfVxuXG4gICp3aXRoUlR4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFJUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPiB7XG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiN3aXRoVHhuKGZ4LCBcInJlYWRvbmx5XCIsIGZuKTtcbiAgfVxufVxuXG5jbGFzcyBJbmRleGVkREJUeG4ge1xuICAjc3RvcmU6IElEQk9iamVjdFN0b3JlO1xuICAjY29kZXJzOiBTdG9yYWdlQ29kZXJzO1xuXG4gIGNvbnN0cnVjdG9yKHN0b3JlOiBJREJPYmplY3RTdG9yZSwgY29kZXJzOiBTdG9yYWdlQ29kZXJzKSB7XG4gICAgdGhpcy4jc3RvcmUgPSBzdG9yZTtcbiAgICB0aGlzLiNjb2RlcnMgPSBjb2RlcnM7XG4gIH1cblxuICBnZXQoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBjb25zdCByZXEgPSB0aGlzLiNzdG9yZS5nZXQoa2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0aGlzLiNjb2RlcnMuZGVjb2RlcihrZXksIHJlcS5yZXN1bHQpfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIGxvb2sgdXAgXCIke2tleX1cImApfSk7XG4gICAgfTtcbiAgfVxuXG4gIHNldChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGNvbnN0IHJlcSA9IHRoaXMuI3N0b3JlLnB1dCh0aGlzLiNjb2RlcnMuZW5jb2RlcihrZXksIHZhbHVlKSwga2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIHNldCBcIiR7a2V5fVwiYCl9KTtcbiAgICB9O1xuICB9XG5cbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBjb25zdCByZXEgPSB0aGlzLiNzdG9yZS5kZWxldGUoa2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIGRlbGV0ZSBcIiR7a2V5fVwiYCl9KTtcbiAgICB9O1xuICB9XG59XG5cbi8vIEluTWVtb3J5U3RvcmFnZSBkb2VzIG5vdCByZXF1aXJlIGFueSBTdG9yYWdlQ29kZXJzIGJlY2F1c2UgaXQgbmV2ZXIgZW5jb2RlcyBvciBkZWNvZGVzLlxuZXhwb3J0IGNsYXNzIEluTWVtU3RvcmFnZSB7XG4gICNkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA7XG5cbiAgY29uc3RydWN0b3IoZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgdGhpcy4jZGF0YSA9IGRhdGEgIT09IHVuZGVmaW5lZCA/IGRhdGEgOiB7fTtcbiAgfVxuXG4gICojd2l0aFR4bjxUPihmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICBjb25zdCB1cGRhdGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgIGNvbnN0IHR4biA9IG5ldyBJbk1lbVR4bih0aGlzLiNkYXRhLCB1cGRhdGVzKTtcbiAgICAvLyBhYm9ydCBjYXNlIGlzIHRoYXQgd2UgZG9uJ3QgY2F0Y2ggdGhlIGV4Y2VwdGlvbiBoZXJlOlxuICAgIGNvbnN0IHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgIC8vIGNvbW1pdCBjYXNlXG4gICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKHVwZGF0ZXMpKSB7XG4gICAgICBpZiAodmFsID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHRoaXMuI2RhdGFba2V5XTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuI2RhdGFba2V5XSA9IHZhbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gICp3aXRoV1R4bjxUPihfZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBXVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmbik7XG4gIH1cblxuICAqd2l0aFJUeG48VD4oX2Z4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogUlR4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZm4pO1xuICB9XG59XG5cbmNsYXNzIEluTWVtVHhuIHtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAjdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgY29uc3RydWN0b3IoZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHVwZGF0ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgdGhpcy4jZGF0YSA9IGRhdGE7XG4gICAgdGhpcy4jdXBkYXRlcyA9IHVwZGF0ZXM7XG4gIH1cblxuICBnZXQoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBpZiAoa2V5IGluIHRoaXMuI3VwZGF0ZXMpIHtcbiAgICAgIGNiKHt2YWx1ZTogdGhpcy4jdXBkYXRlc1trZXldfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNiKHt2YWx1ZTogdGhpcy4jZGF0YVtrZXldfSk7XG4gICAgfVxuICB9XG5cbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy4jdXBkYXRlc1trZXldID0gdmFsdWU7XG4gICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gIH1cblxuICBkZWwoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMuI3VwZGF0ZXNba2V5XSA9IHVuZGVmaW5lZDtcbiAgICBjYih7dmFsdWU6IHRydWV9KTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgT3ZlcmxheVN0b3JhZ2Uge1xuICAjYmFzZTogU3RvcmFnZTtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgY29uc3RydWN0b3IoYmFzZTogU3RvcmFnZSkge1xuICAgIHRoaXMuI2Jhc2UgPSBiYXNlO1xuICB9XG5cbiAga2V5cygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRoaXMuI2RhdGEpO1xuICB9XG5cbiAgKiN3aXRoVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICAvLyByZWdhcmRsZXNzIG9mIHJlYWQvd3JpdGUgc3RhdHVzIG9uIHRoZSBvdmVybGF5IHR4biwgd2Ugb25seSBldmVyIG9wZW4gYSByZWFkIHR4biBvbiAjYmFzZVxuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jYmFzZS53aXRoUlR4bihmeCwgZnVuY3Rpb24qKGJhc2VUeG4pe1xuICAgICAgY29uc3QgdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgIGNvbnN0IHR4biA9IG5ldyBPdmVybGF5VHhuKGJhc2VUeG4sIHNlbGYuI2RhdGEsIHVwZGF0ZXMpO1xuICAgICAgLy8gYWJvcnQgY2FzZSBpcyB0aGF0IHdlIGRvbid0IGNhdGNoIHRoZSBleGNlcHRpb24gaGVyZTpcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgICAgLy8gY29tbWl0IGNhc2VcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsXSBvZiBPYmplY3QuZW50cmllcyh1cGRhdGVzKSkge1xuICAgICAgICAvLyBub3RlOiB3ZSBtdXN0IGtlZXAgdW5kZWZpbmVkIHZhbHVlcyByYXRoZXIgdGhhbiBwcm9wYWdhdGUgZGVsZXRpb25zIHRvIGJhc2VcbiAgICAgICAgc2VsZi4jZGF0YVtrZXldID0gdmFsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9KTtcbiAgfVxuXG4gICp3aXRoV1R4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFdUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPiB7XG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiN3aXRoVHhuKGZ4LCBmbik7XG4gIH1cblxuICAqd2l0aFJUeG48VD4oZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBSVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmeCwgZm4pO1xuICB9XG59XG5cbmNsYXNzIE92ZXJsYXlUeG4ge1xuICAjYmFzZTogUlR4bjtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAjdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5cblxuICBjb25zdHJ1Y3RvcihiYXNlOiBSVHhuLCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICB0aGlzLiNiYXNlID0gYmFzZTtcbiAgICB0aGlzLiNkYXRhID0gZGF0YTtcbiAgICB0aGlzLiN1cGRhdGVzID0gdXBkYXRlcztcbiAgfVxuXG4gIGdldChrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VWYWx1ZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGlmIChrZXkgaW4gdGhpcy4jdXBkYXRlcykge1xuICAgICAgY2Ioe3ZhbHVlOiB0aGlzLiN1cGRhdGVzW2tleV19KTtcbiAgICB9IGVsc2UgaWYgKGtleSBpbiB0aGlzLiNkYXRhKSB7XG4gICAgICBjYih7dmFsdWU6IHRoaXMuI2RhdGFba2V5XX0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLiNiYXNlLmdldChrZXksIGNiKTtcbiAgICB9XG4gIH1cblxuICBzZXQoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLiN1cGRhdGVzW2tleV0gPSB2YWx1ZTtcbiAgICBjYih7dmFsdWU6IHRydWV9KTtcbiAgfVxuXG4gIGRlbChrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy4jdXBkYXRlc1trZXldID0gdW5kZWZpbmVkO1xuICAgIGNiKHt2YWx1ZTogdHJ1ZX0pO1xuICB9XG59XG5cbi8vXG5cbi8qIEV4dGVybmFsQ2FsbGJhY2tTdG9yYWdlIGltcGxlbWVudHMgc3RvcmFnZSBlbnRpcmVseSB2aWEgY2FsbGJhY2sgZnVuY3Rpb25zLiAqL1xuZXhwb3J0IGNsYXNzIEV4dGVybmFsQ2FsbGJhY2tTdG9yYWdlIHtcbiAgI3R4bjogKHdyaXRhYmxlOiBib29sZWFuLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKSA9PiB1bmtub3duO1xuICAjY29tbWl0OiAodHhuOiB1bmtub3duLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpID0+IHZvaWQ7XG4gICNhYm9ydDogKHR4bjogdW5rbm93biwgY2I6ICgpID0+IHZvaWQpID0+IHZvaWQ7XG4gICNnZXQ6ICh0eG46IHVua25vd24sIGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAjc2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZDtcbiAgI2RlbDogKHR4bjogdW5rbm93biwga2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICAvLyB0eG4gcmV0dXJucyBhbiBvcGFxdWUgdmFsdWUgdGhhdCBnZXRzIHBhc3NlZCB0byB0aGUgb3RoZXIgY2FsbGJhY2tzXG4gICAgdHhuOiAod3JpdGFibGU6IGJvb2xlYW4sIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpID0+IHVua25vd24sXG4gICAgLy8gY29tbWl0IGNvbW1pdHMgYSB0cmFuc2FjdGlvbiwgb3IgcmV0dXJucyBhbiBlcnJvci5cbiAgICBjb21taXQ6ICh0eG46IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBhYm9ydCBhYm9ydHMgdGhlIHRyYW5zYWN0aW9uLiAgSXQgaXMgbm90IGFsbG93ZWQgdG8gcmV0dXJuIGFuIGVycm9yLlxuICAgIGFib3J0OiAodHhuOiB1bmtub3duLCBjYjogKCkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBnZXQgZ2V0cyBhIHZhbHVlXG4gICAgZ2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VWYWx1ZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBzZXQgc2V0cyBhIHZhbHVlXG4gICAgc2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBkZWwgZGVsZXRlcyBhIHZhbHVlXG4gICAgZGVsOiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKSA9PiB2b2lkLFxuICApIHtcbiAgICB0aGlzLiN0eG4gPSB0eG47XG4gICAgdGhpcy4jY29tbWl0ID0gY29tbWl0O1xuICAgIHRoaXMuI2Fib3J0ID0gYWJvcnQ7XG4gICAgdGhpcy4jZ2V0ID0gZ2V0O1xuICAgIHRoaXMuI3NldCA9IHNldDtcbiAgICB0aGlzLiNkZWwgPSBkZWw7XG4gIH1cblxuICAqI3dpdGhUeG48VD4oXG4gICAgZng6IEZ1dHVyZUNvbnRleHQsIHdyaXRhYmxlOiBib29sZWFuLCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+LFxuICApOiBGdXR1cmU8VD4ge1xuICAgIC8vIGNyZWF0ZSB0aGUgdHJhbnNhY3Rpb25cbiAgICBsZXQgdHhuVmFsOiB1bmtub3duO1xuICAgIGxldCB0eG5SZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMuI3R4bih3cml0YWJsZSwgKHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKFwiZXJyXCIgaW4gcmVzdWx0KSB7XG4gICAgICAgIGZ4LnRocm93KHJlc3VsdC5lcnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHhuVmFsID0gcmVzdWx0LnZhbHVlO1xuICAgICAgICB0eG5SZWFkeSA9IHRydWU7XG4gICAgICAgIGZ4Lndha2V1cCgpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHdoaWxlICghdHhuUmVhZHkpIHlpZWxkO1xuXG4gICAgY29uc3QgdHhuOiBXVHhuID0ge1xuICAgICAgZ2V0OiAoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuI2dldCh0eG5WYWwsIGtleSwgY2IpO1xuICAgICAgfSxcbiAgICAgIHNldDogKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLiNzZXQodHhuVmFsLCBrZXksIHZhbHVlLCBjYik7XG4gICAgICB9LFxuICAgICAgZGVsOiAoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy4jZGVsKHR4blZhbCwga2V5LCBjYik7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGxldCByZXN1bHQ6IFQ7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgIH0gY2F0Y2ggKGU6IHVua25vd24pIHtcbiAgICAgIC8vIGFib3J0IGFuZCByZS10aHJvdyBlcnJvclxuICAgICAgbGV0IGFib3J0UmVhZHkgPSBmYWxzZTtcbiAgICAgIHRoaXMuI2Fib3J0KHR4blZhbCwgKCkgPT4ge1xuICAgICAgICBhYm9ydFJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgZngud2FrZXVwKCk7XG4gICAgICB9KVxuICAgICAgd2hpbGUoIWFib3J0UmVhZHkpIHlpZWxkO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG5cbiAgICAvLyB0cnkgdG8gY29tbWl0XG4gICAgbGV0IGNvbW1pdFJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy4jY29tbWl0KHR4blZhbCwgKHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKFwiZXJyXCIgaW4gcmVzdWx0KSB7XG4gICAgICAgIGZ4LnRocm93KHJlc3VsdC5lcnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29tbWl0UmVhZHkgPSB0cnVlO1xuICAgICAgICBmeC53YWtldXAoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB3aGlsZSAoIWNvbW1pdFJlYWR5KSB5aWVsZDtcblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAqd2l0aFdUeG48VD4oZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBXVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmeCwgdHJ1ZSwgZm4pO1xuICB9XG5cbiAgKndpdGhSVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogUlR4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZngsIGZhbHNlLCBmbik7XG4gIH1cbn1cblxuLy8gcmVkdWNlcnMgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuZXhwb3J0IHR5cGUgUmVkdWNlclF1ZXN0aW9uID0ge1xuICAvLyBrZXlzIHRvIGxvb2sgdXBcbiAgb2xkPzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG4gIC8vIGtleXMgdG8gbG9vayB1cFxuICBnZXQ/OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgLy8ga2V5LXZhbHVlcyB0byBzZXRcbiAgc2V0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIC8vIGtleS12YWx1ZXMgdG8gZGVsZXRlXG4gIGRlbD86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxufTtcblxuZXhwb3J0IHR5cGUgUmVkdWNlckFuc3dlciA9IHtcbiAgb2xkOiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXktdmFsdWUgbG9va3VwIHJlc3VsdHNcbiAgZ2V0OiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXlzIGRvbmUgc2V0dGluZ1xuICBzZXQ6IFJlY29yZDxzdHJpbmcsIFN0b3JhZ2VEb25lPixcbiAgLy8ga2V5cyBkb25lIGRlbGV0aW5nXG4gIGRlbDogUmVjb3JkPHN0cmluZywgU3RvcmFnZURvbmU+LFxufTtcblxuZXhwb3J0IHR5cGUgUmVkdWNlcjxUPiA9IEdlbmVyYXRvcjxSZWR1Y2VyUXVlc3Rpb24sIFQsIFJlZHVjZXJBbnN3ZXI+O1xuLy8gUmVkdWNlckNvbnRleHQgbG9va3MgbGlrZTpcbi8vIHlpZWxkKiByeC5zZXQucHJvamVjdChrZXksIHZhbCk6IHNldCBuZXcgdmFsdWUgKHlvdSBvbmx5IGdldCB0byBzZXQgaXQgb25jZSBwZXIgdHhuKVxuLy8geWllbGQqIHJ4LmdldC5wcm9qZWN0KGtleSk6IGdldCB0aGUgY3VycmVudCB2YWx1ZSBmb3Iga2V5LCBwb3NzaWJseSBzZXR0aW5nIGl0IGZyb20gb2xkXG4vLyB5aWVsZCogcngub2xkLnByb2plY3Qoa2V5KTogZXhwbGljaXRseSBnZXQgdGhlIG9sZCB2YWx1ZSBmb3Iga2V5XG5cbi8vIHdyYXAgYSBSZWR1Y2VyIHNvIGl0IGFjdHMgbGlrZSBhIFdTdG9yYWdlR2VuZXJhdG9yLCByZXR1cm5pbmcgYSBzZXQgb2YgdXBkYXRlZCBrZXlzXG5leHBvcnQgZnVuY3Rpb24gKnJ1blJlZHVjZXIoZzogUmVkdWNlcjxhbnlbXSB8IHZvaWQ+LCBzaW11bGF0ZT86IGJvb2xlYW4pOiBXU3RvcmFnZUdlbmVyYXRvcjxbc3RyaW5nW10sIGFueVtdXT4ge1xuICAvLyBvdXIgY2FjaGUgb2YgZ2V0J3Mgd2UndmUgYWxyZWFkeSBjb21wbGV0ZWRcbiAgY29uc3Qgb2xkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gIC8vIG91ciBwbGFubmVkIHNldHMgYW5kIGRlbHMgdGhhdCB3ZSBzdWJtaXQgYXQgdGhlIGVuZFxuICBjb25zdCBjdXI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuICBmdW5jdGlvbiAqZmluaXNoKHJldFZhbDogYW55W10pOiBXU3RvcmFnZUdlbmVyYXRvcjxbc3RyaW5nW10sIGFueVtdXT4ge1xuICAgIGNvbnN0IHVwZGF0ZXMgPSBbXTtcbiAgICBjb25zdCBxdWVzdGlvbjogV1N0b3JhZ2VRdWVzdGlvbiA9IHtnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhjdXIpKSB7XG4gICAgICBpZiAodiA9PT0gREVMRVRFRCkge1xuICAgICAgICBxdWVzdGlvbi5kZWwhW2tdID0gdHJ1ZTtcbiAgICAgICAgdXBkYXRlcy5wdXNoKGspO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gZGUtY29weU9uV3JpdGUtaWZ5IHRoZSB2YWx1ZVxuICAgICAgICBjb25zdCByID0gcmVjb3Zlcih2KTtcbiAgICAgICAgLy8gZ2V0IHRoZSBvbGQgdmFsdWVcbiAgICAgICAgY29uc3QgbyA9IG9sZFtrXTtcbiAgICAgICAgLy8gZGV0ZWN0IG5vb3BcbiAgICAgICAgaWYgKHIgPT09IG8pIGNvbnRpbnVlO1xuICAgICAgICAvLyBvdGhlcndpc2Ugd3JpdGUgdGhlIHZhbHVlIHRvIHN0b3JhZ2VcbiAgICAgICAgdXBkYXRlcy5wdXNoKGspO1xuICAgICAgICBxdWVzdGlvbi5zZXQhW2tdID0gcjtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gaXMgdGhlcmUgYW55IHN0b3JhZ2UgdXBkYXRlcyB0byBtYWtlP1xuICAgIGlmICh1cGRhdGVzLmxlbmd0aCA9PT0gMCB8fCBzaW11bGF0ZSkgcmV0dXJuIFt1cGRhdGVzLCByZXRWYWxdO1xuICAgIGxldCBudXBkYXRlZCA9IDA7XG4gICAgd2hpbGUgKG51cGRhdGVkIDwgdXBkYXRlcy5sZW5ndGgpIHtcbiAgICAgIC8vIGFjdHVhbGx5IHlpZWxkIHRoZSB3cml0ZSByZXF1ZXN0IHRvIHN0b3JhZ2VcbiAgICAgIGNvbnN0IGFucyA9IHlpZWxkIHF1ZXN0aW9uO1xuICAgICAgLy8gY2hlY2sgZXZlcnkgcmVzdWx0XG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhhbnMuc2V0ID8/IHt9KSkge1xuICAgICAgICBpZiAoXCJlcnJcIiBpbiB2KSB0aHJvdyBuZXcgRXJyb3IoYHNldHRpbmcgXCIke2t9XCIgYWZ0ZXIgcmVkdWNlcjogJHt2LmVycn1gKVxuICAgICAgICBudXBkYXRlZCsrO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoYW5zLmRlbCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKFwiZXJyXCIgaW4gdikgdGhyb3cgbmV3IEVycm9yKGBkZWxldGluZyBcIiR7a31cIiBhZnRlciByZWR1Y2VyOiAke3YuZXJyfWApXG4gICAgICAgIG51cGRhdGVkKys7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbdXBkYXRlcywgcmV0VmFsXTtcbiAgfVxuXG4gIGxldCBhbnM6IFJlZHVjZXJBbnN3ZXIgPSB7b2xkOiB7fSwgZ2V0OiB7fSwgc2V0OiB7fSwgZGVsOiB7fX07XG4gIC8vIGluZmxpZ2h0IGlzIGZvciBnZXRzIHdlIGhhdmUgc3VibWl0dGVkIGJ1dCBoYXZlbid0IHJlY2VpdmVkXG4gIC8vICh5b3UgY2FuIGhhdmUgbWFueSBvbGRzIG9yIGdldHMgaW4gZmxpZ2h0IHNpbXVsdGFuZW91c2x5LCBidXQgb25seSBvbmUgc2V0LCBhbmQgaXQgY2Fubm90IGJlXG4gIC8vICBzaW11bHRhbmVvdXMgd2l0aCBhbnkgZ2V0cylcbiAgbGV0IGluZmxpZ2h0OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAvLyBwZW5kaW5nIGlzIGZvciBhbnN3ZXJzIHdlJ3JlIHRyeWluZyB0byBkZWxpdmVyXG4gIC8vIHtrZXk6IHBlbmRpbmdfb3BzfVxuICBsZXQgcGVuZGluZzogUmVjb3JkPHN0cmluZywge29sZD86IHRydWUsIGdldD86IHRydWV9PiA9IHt9O1xuICBsZXQgc3RvcmFnZVF1ZXN0aW9uOiBXU3RvcmFnZVF1ZXN0aW9uID0ge2dldDoge30sIHNldDoge30sIGRlbDoge319O1xuXG4gIC8vIHJ1biB0aGUgcmVkdWNlciB0byBjb21wbGV0aW9uXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgbGV0IHJlYWR5ID0gdHJ1ZTtcbiAgICB3aGlsZSAocmVhZHkpIHtcbiAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBnLm5leHQoYW5zKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm4geWllbGQqIGZpbmlzaCh2YWx1ZSA/PyBbXSk7XG5cbiAgICAgIGFucyA9IHtvbGQ6IHt9LCBnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICAgIHJlYWR5ID0gZmFsc2U7XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLm9sZCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKGtleSBpbiBvbGQpIHtcbiAgICAgICAgICAvLyB3ZSBhbHJlYWR5IGtub3cgdGhpcyBvbmVcbiAgICAgICAgICAvLyBub3RlIHRoYXQgY29weU9uV3JpdGUoKSBpcyBhcHBsaWVkIGluc2lkZSB0aGUgUmVkdWNlckNvbnRleHQ7IG5vdCBoZXJlXG4gICAgICAgICAgYW5zLm9sZFtrZXldID0ge3ZhbHVlOiBvbGRba2V5XX07XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKCFpbmZsaWdodFtrZXldKSB7XG4gICAgICAgICAgaW5mbGlnaHRba2V5XSA9IHRydWU7XG4gICAgICAgICAgc3RvcmFnZVF1ZXN0aW9uLmdldCFba2V5XSA9IHRydWU7XG4gICAgICAgICAgc2V0ZGVmYXVsdChwZW5kaW5nLCBrZXksIHt9KS5vbGQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLmdldCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKGtleSBpbiBjdXIpIHtcbiAgICAgICAgICAvLyB2YWx1ZSB3YXMgYWxyZWFkeSBzZXRcbiAgICAgICAgICAvLyBUT0RPOiBsZXQgY29weU9uV3JpdGUoKSBmb3JrIGFuIGV4aXN0aW5nIGNvcHlPbldyaXRlIG9iamVjdCwgc28gd2UgZG9uJ3QgaGF2ZSB0b1xuICAgICAgICAgIC8vICAgICAgIG1hdGVyaWFsaXplIHRoZSB1cGRhdGVkIG9iamVjdCB1bnRpbCB3ZSBjYWxsIGZpbmlzaCgpXG4gICAgICAgICAgY29uc3QgY2FjaGVkID0gY3VyW2tleV07XG4gICAgICAgICAgYW5zLmdldFtrZXldID0ge3ZhbHVlOiByZWNvdmVyKGNhY2hlZCAhPT0gREVMRVRFRCA/IGNhY2hlZCA6IHVuZGVmaW5lZCl9O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChrZXkgaW4gb2xkKSB7XG4gICAgICAgICAgLy8gd2UgbG9va2VkIHRoaXMgdXAgYmVmb3JlXG4gICAgICAgICAgLy8gbm90ZSB0aGF0IGNvcHlPbldyaXRlKCkgaXMgYXBwbGllZCBpbnNpZGUgdGhlIFJlZHVjZXJDb250ZXh0OyBub3QgaGVyZVxuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHt2YWx1ZTogb2xkW2tleV19O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmICghaW5mbGlnaHRba2V5XSkge1xuICAgICAgICAgIGluZmxpZ2h0W2tleV0gPSB0cnVlO1xuICAgICAgICAgIHN0b3JhZ2VRdWVzdGlvbi5nZXQhW2tleV0gPSB0cnVlO1xuICAgICAgICAgIHNldGRlZmF1bHQocGVuZGluZywga2V5LCB7fSkuZ2V0ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUuc2V0ID8/IHt9KSkge1xuICAgICAgICAvLyBqdXN0IHN0b3JlIHRoaXMgaW4gbWVtb3J5IGZvciBub3dcbiAgICAgICAgY3VyW2tleV0gPSB2YWw7XG4gICAgICAgIGFucy5zZXRba2V5XSA9IHt2YWx1ZTogdHJ1ZX07XG4gICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuZGVsID8/IHt9KSkge1xuICAgICAgICAvLyBqdXN0IHN0b3JlIHRoaXMgaW4gbWVtb3J5IGZvciBub3dcbiAgICAgICAgY3VyW2tleV0gPSBERUxFVEVEO1xuICAgICAgICBhbnMuZGVsW2tleV0gPSB7dmFsdWU6IHRydWV9O1xuICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gaW50ZXJhY3Qgd2l0aCBzdG9yYWdlIHVudGlsIHdlIGhhdmUgYW4gYW5zd2VyIHRvIHJldHVybiB0byB0aGUgcmVkdWNlcnNcbiAgICB3aGlsZSAoIXJlYWR5KSB7XG4gICAgICBjb25zdCBzdG9yYWdlQW5zd2VyID0geWllbGQgc3RvcmFnZVF1ZXN0aW9uO1xuICAgICAgc3RvcmFnZVF1ZXN0aW9uID0ge2dldDoge30sIHNldDoge30sIGRlbDoge319O1xuXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmFnZUFuc3dlci5nZXQpKSB7XG4gICAgICAgIC8vIGNhY2hlIHN1Y2Nlc3NmdWwgcmVzdWx0c1xuICAgICAgICBpZiAoXCJ2YWx1ZVwiIGluIHZhbCkgb2xkW2tleV0gPSB2YWwudmFsdWU7XG4gICAgICAgIC8vIGRvbmUgd2l0aCB0aGlzIHF1ZXJ5XG4gICAgICAgIGRlbGV0ZSBpbmZsaWdodFtrZXldO1xuICAgICAgICBjb25zdCBwbmQgPSBwZW5kaW5nW2tleV07XG4gICAgICAgIC8vIHdoeSBkaWQgd2UgbmVlZCB0aGlzIGFnYWluP1xuICAgICAgICBpZiAocG5kLm9sZCkge1xuICAgICAgICAgIC8vIG5vdGUgdGhhdCBjb3B5T25Xcml0ZSgpIGlzIGFwcGxpZWQgaW5zaWRlIHRoZSBSZWR1Y2VyQ29udGV4dDsgbm90IGhlcmVcbiAgICAgICAgICBhbnMub2xkW2tleV0gPSB2YWw7XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwbmQuZ2V0KSB7XG4gICAgICAgICAgLy8gbm90ZSB0aGF0IGNvcHlPbldyaXRlKCkgaXMgYXBwbGllZCBpbnNpZGUgdGhlIFJlZHVjZXJDb250ZXh0OyBub3QgaGVyZVxuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHZhbDtcbiAgICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHBlbmRpbmdba2V5XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuLy8gcXVlcmllcyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4vKiBFeGFtcGxlIHF1ZXJ5IGZvciBsb2FkaW5nIGFsbCBjb21tZW50cyBpbiBhIHRvcGljOlxuXG4gICAgICBsZXQgbXlUb3BpYyA9IC4uLjtcbiAgICAgIGNvbnN0IHEgPSBmcmFtZXdvcmsubmV3UXVlcnkoZnVuY3Rpb24qKHF4OiBRWCkgPT4ge1xuICAgICAgICBjb25zdCB1dWlkcyA9IHlpZWxkKiBxeC5nZXQudG9waWNDb21tZW50cyhteVRvcGljKTtcbiAgICAgICAgY29uc3QgY29tbWVudHMgPSB7fTtcbiAgICAgICAgY29uc3QgdG9wbGV2ZWxzID0gW107XG4gICAgICAgIGZvciAoY29uc3QgdXVpZCBvZiB1dWlkcykge1xuICAgICAgICAgIGNvbW1lbnRzW3V1aWRdID0geWllbGQqIHF4LmdldC5jb21tZW50cyh1dWlkKTtcbiAgICAgICAgICBpZiAoIWNvbW1lbnQucGFyZW50KSB0b3BsZXZlbHMucHVzaCh1dWlkKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge2NvbW1lbnRzLCB0b3BsZXZlbHN9O1xuICAgICAgfSlcbiovXG5cbi8vIHVzZXItZmFjaW5nIHF1ZXJ5IGFwaVxuZXhwb3J0IGludGVyZmFjZSBRdWVyeTxUPiB7XG4gIC8vIGxhdGVzdCBob2xkcyB0aGUgbW9zdCByZWNlbnQgdmFsdWUgcGFzc2VkIHRvIHN1YnNjcmliZSBjYWxsYmFjay4gIEl0IGlzIHVwZGF0ZWQgaW1tZWRpYXRlbHlcbiAgLy8gYWZ0ZXIgc3Vic2NyaWJlIGNhbGxiYWNrcyBhcmUgbWFkZSwgb24gYSBwZXItUXVlcnkgYmFzaXMuXG4gIGxhdGVzdDogVCB8IHVuZGVmaW5lZDtcbiAgLy8gYXdhaXRSZXN1bHQgaGFzIG5vIGVmZmVjdCB3aGVuIGV4ZWN1dGVkIG91dHNpZGUgb2YgYSBxdWVyeSBmdW5jdGlvblxuICBhd2FpdFJlc3VsdCgpOiBRdWVyeUdlbmVyYXRvcjxUPlxuICAvLyBzdWJzY3JpYmUgcmV0dXJucyBhbiB1bnN1YnNjcmliZSBmdW5jdGlvblxuICBzdWJzY3JpYmUoY2FsbGJhY2s6ICh2YWw6IFQpID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvLyBzdGFydCB3aWxsIHN0YXJ0IHRoZSBxdWVyeSwgaWYgaXQgd2Fzbid0IGNyZWF0ZWQgd2l0aCBzdGFydD10cnVlLiAgVGhpcyBpcyBtb3N0bHkgZm9yIHdyYXBwZXJzXG4gIC8vIHdyaXR0ZW4gaW4gb3RoZXIgbGFuZ3VhZ2VzLCB3aGVyZSB0aGUgZXZlbnQtbG9vcCB3aWxsIGJlIG1hbmFnZWQgYXV0b21hdGljYWxseSwgYW5kIHRoZSBjYWxsZXJcbiAgLy8gbmVlZHMgYSB3YXkgdG8gY3JlYXRlIHRoZSBxdWVyeSBhbmQgc3Vic2NyaWJlIHRvIGl0IGJlZm9yZSBsZXR0aW5nIGl0IHJ1biB0aGUgZmlyc3QgdGltZS5cbiAgc3RhcnQoKTogdm9pZDtcbiAgLy8gY2xvc2Ugd2lsbCBzdG9wIHRoZSBxdWVyeSBmcm9tIHJ1bm5pbmcgYWdhaW4uXG4gIC8vIERlcGVuZGVudCBxdWVyaWVzIHdoaWNoIGFyZSBub3QgYWxzbyBjbG9zZWQgd2lsbCBzdGFydCBjcmFzaGluZy5cbiAgY2xvc2UoKTogdm9pZDtcbn1cblxuZXhwb3J0IHR5cGUgUXVlcnlRdWVzdGlvbiA9IHtcbiAgLy8gd2hpY2gga2V5cyB0byBsb29rIHVwIGluIHN0b3JhZ2VcbiAgc3RvcmU/OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgLy8gd2hpY2ggcXVlcnkgaWRzIHRvIGF3YWl0IHRoZWlyIHJlc3VsdFxuICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxufTtcblxuZXhwb3J0IHR5cGUgUXVlcnlBbnN3ZXIgPSB7XG4gIC8vIHRoZSB2YWx1ZSBmb3IgZWFjaCBzdG9yYWdlIGxvb2t1cFxuICBzdG9yZTogUmVjb3JkPHN0cmluZywgU3RvcmFnZVZhbHVlPixcbiAgLy8gdGhlIFtyZXN1bHQsIGRpcnR5XSBmb3IgZWFjaCBhc2tlZCBxdWVyeVxuICBxdWVyeTogUmVjb3JkPHN0cmluZywgW3Vua25vd24sIGJvb2xlYW5dPixcbn07XG5cbmV4cG9ydCB0eXBlIFF1ZXJ5R2VuZXJhdG9yPFQ+ID0gR2VuZXJhdG9yPFF1ZXJ5UXVlc3Rpb24sIFQsIFF1ZXJ5QW5zd2VyPjtcblxuZXhwb3J0IHR5cGUgUXVlcnlGdW5jdGlvbjxRWCwgVD4gPSAocXg6IFFYLCBwcmV2OiBUIHwgdW5kZWZpbmVkLCBwcmV2SXNWYWxpZDogYm9vbGVhbikgPT4gUXVlcnlHZW5lcmF0b3I8VD47XG5cbi8vIGdyYXBoLWZhY2luZyBhcGksIHdoaWNoIGhpZGVzIHR5cGluZyBpbmZvIGZyb20gdGhlIGdyYXBoXG5pbnRlcmZhY2UgUXVlcnlXcmFwcGVyPFFYPiB7XG4gIC8vIHRoZSBpZCBvZiB0aGlzIHF1ZXJ5XG4gIGlkOiBzdHJpbmc7XG4gIGNsb3NlZDogYm9vbGVhbjsgLy8gVE9ETzogc29tZWhvdyB1c2UgdGhpcyB0byBmYWlsIGRlcGVuZGVudCBxdWVyaWVzIGFmdGVyIGEgcXVlcnkgaXMgY2xvc2VkXG4gIC8vIHJldHVybnMgYFtyZXN1bHQsIGRpcnR5XWAgaW5kaWNhdGluZyBpZiB0aGUgcmVzdWx0IGFuZCBpZiBpdCBjaGFuZ2VkXG4gIHJ1bihxeDogUVgsIGNvbW1pdEtleXM6IFJlY29yZDxzdHJpbmcsIHRydWU+KTogUXVlcnlHZW5lcmF0b3I8W3Vua25vd24sIGJvb2xlYW5dPjtcbiAgLy8gY2FsbCBzdWJzY3JpYmVycyB3aXRoIHRoZSBsYXRlc3QgcmVzdWx0XG4gIG5vdGlmeSgpOiB2b2lkO1xufVxuXG5jbGFzcyBfUXVlcnk8UVgsIFQ+IHtcbiAgaWQ6IHN0cmluZztcbiAgbGF0ZXN0OiBUIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuICBjbG9zZWQ6IGJvb2xlYW4gPSBmYWxzZTtcblxuICAjc3ViczogKCh2YWw6IFQpID0+IHZvaWQpW10gPSBbXTtcblxuICAvLyB7a2V5OiB0cnVlfVxuICAja2V5RGVwczogUmVjb3JkPHN0cmluZywgdHJ1ZT4gPSB7fTtcbiAgLy8ge3F1ZXJ5X2lkOiB0cnVlfVxuICAjcXVlcnlEZXBzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAjcnVuczogbnVtYmVyID0gMDtcbiAgI3Jlc3VsdDogVCB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcbiAgI2ZuOiAocXg6IFFYLCBwcmV2OiBUIHwgdW5kZWZpbmVkLCBwcmV2SXNWYWxpZDogYm9vbGVhbikgPT4gUXVlcnlHZW5lcmF0b3I8VD47XG4gICNvblN0YXJ0OiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG5cbiAgY29uc3RydWN0b3IoaWQ6IHN0cmluZywgZm46IFF1ZXJ5RnVuY3Rpb248UVgsIFQ+LCBvblN0YXJ0OiAoKSA9PiB2b2lkKSB7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuI2ZuID0gZm47XG4gICAgdGhpcy4jb25TdGFydCA9IG9uU3RhcnQ7XG4gIH1cblxuICAvLyBwYXJ0IG9mIHB1YmxpYyBhcGlcbiAgKmF3YWl0UmVzdWx0KCk6IFF1ZXJ5R2VuZXJhdG9yPFQ+IHtcbiAgICBpZiAodGhpcy4jb25TdGFydCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY2Fubm90IGF3YWl0IHJlc3VsdCBvZiB1bnN0YXJ0ZWQgUXVlcnlcIik7XG4gICAgfVxuICAgIC8vIGRvbid0IHRyeSB0byBjb29yZGluYXRlIG91ciBvd24gI3Jlc3VsdCB2YXVsZSB3aXRoIHRoZSBncmFwaCBiZWluZyBleGVjdXRlZDsganVzdCB1c2UgdGhpcyBhc1xuICAgIC8vIGFuIGlkaW9tYXRpYyB3YXkgdG8gYXNrIHRoZSBncmFwaCBydW4gZm9yIHRoZSByZXN1bHQgZnJvbSBvdXIgLmlkLlxuICAgIGNvbnN0IGFucyA9IHlpZWxkIHtxdWVyeToge1t0aGlzLmlkXTogdHJ1ZX19O1xuICAgIGNvbnN0IFtyZXN1bHRdID0gYW5zLnF1ZXJ5W3RoaXMuaWRdO1xuICAgIHJldHVybiByZXN1bHQgYXMgVDtcbiAgfVxuXG4gIC8vIHBhcnQgb2YgcHVibGljIGFwaVxuICBzdWJzY3JpYmUoY2FsbGJhY2s6ICh2YWw6IFQpID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgICB0aGlzLiNzdWJzLnB1c2goY2FsbGJhY2spO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICB0aGlzLiNzdWJzID0gdGhpcy4jc3Vicy5maWx0ZXIoKHgpID0+IHggIT09IGNhbGxiYWNrKTtcbiAgICB9O1xuICB9XG5cbiAgc3RhcnQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuY2xvc2VkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjYWxsIHRvIFF1ZXJ5LnN0YXJ0KCkgb24gY2xvc2VkIHF1ZXJ5XCIpO1xuICAgIH1cbiAgICBpZiAodGhpcy4jb25TdGFydCkge1xuICAgICAgdGhpcy4jb25TdGFydCgpO1xuICAgICAgdGhpcy4jb25TdGFydCA9IHVuZGVmaW5lZFxuICAgIH1cbiAgfVxuXG4gIC8vIHBhcnQgb2YgcHVibGljIGFwaVxuICBjbG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNsb3NlZCA9IHRydWU7XG4gIH1cblxuICAqI3Nob3VsZFNraXAoY29tbWl0S2V5czogUmVjb3JkPHN0cmluZywgdHJ1ZT4pOiBRdWVyeUdlbmVyYXRvcjxib29sZWFuPiB7XG4gICAgaWYgKHRoaXMuI3J1bnMgPT09IDEpIHtcbiAgICAgIC8vIHRoaXMgaXMgb3VyIGZpcnN0IHRpbWU7IGFsd2F5cyBydW5cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBjaGVjayBpZiBhIGtleSBkZXBlbmRlbmN5IHdhcyB1cGRhdGVkXG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModGhpcy4ja2V5RGVwcykpIHtcbiAgICAgIGlmIChrZXkgaW4gY29tbWl0S2V5cykgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIGNoZWNrIGlmIGFueSBxdWVyeSBkZXBlbmRlbmN5IGNoYW5nZWQgaXRzIHJlc3VsdFxuICAgIGZvciAoY29uc3QgcWlkIG9mIE9iamVjdC5rZXlzKHRoaXMuI3F1ZXJ5RGVwcykpIHtcbiAgICAgIGNvbnN0IGFucyA9IHlpZWxkIHtcInF1ZXJ5XCI6IHtbcWlkXTogdHJ1ZX19O1xuICAgICAgY29uc3QgWywgZGlydHldID0gYW5zW1wicXVlcnlcIl1bcWlkXTtcbiAgICAgIGlmIChkaXJ0eSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gcGFydCBvZiBncmFwaCBhcGlcbiAgKnJ1bihxeDogUVgsIGNvbW1pdEtleXM6IFJlY29yZDxzdHJpbmcsIHRydWU+KTogUXVlcnlHZW5lcmF0b3I8W3Vua25vd24sIGJvb2xlYW5dPiB7XG4gICAgLy8gc2hpZnQgY3VycmVudCB2YWx1ZXMgdG8gb2xkIHZhbHVlc1xuICAgIGNvbnN0IG9sZFJlc3VsdCA9IHRoaXMuI3Jlc3VsdDtcbiAgICB0aGlzLiNydW5zKys7XG5cbiAgICBpZiAoeWllbGQqIHRoaXMuI3Nob3VsZFNraXAoY29tbWl0S2V5cykpIHtcbiAgICAgIHJldHVybiBbdGhpcy4jcmVzdWx0LCBmYWxzZV1cbiAgICB9XG5cbiAgICAvLyByZWJ1aWxkIGRlcHNcbiAgICB0aGlzLiNrZXlEZXBzID0ge307XG4gICAgdGhpcy4jcXVlcnlEZXBzID0ge307XG5cbiAgICBjb25zdCBnID0gdGhpcy4jZm4ocXgsIG9sZFJlc3VsdCwgdGhpcy4jcnVucyA+IDEpO1xuICAgIGxldCBhbnM6IFF1ZXJ5QW5zd2VyID0ge3F1ZXJ5OiB7fSwgc3RvcmU6IHt9fTtcbiAgICAvLyBydW4gcXVlcnkgZnVuY3Rpb24gdG8gY29tcGxldGlvblxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAvLyBwYXNzIHRoZSBjdXJyZW50IGFuc3dlciB0byB0aGUgY29yb3V0aW5lXG4gICAgICBjb25zdCB7dmFsdWUsIGRvbmV9ID0gZy5uZXh0KGFucyk7XG4gICAgICBpZiAoZG9uZSkge1xuICAgICAgICB0aGlzLiNyZXN1bHQgPSB2YWx1ZTtcbiAgICAgICAgY29uc3QgZGlydHkgPSAodGhpcy4jcnVucyA9PT0gMSkgfHwgKHRoaXMuI3Jlc3VsdCAhPT0gb2xkUmVzdWx0KTtcbiAgICAgICAgcmV0dXJuIFt0aGlzLiNyZXN1bHQsIGRpcnR5XTtcbiAgICAgIH1cbiAgICAgIC8vIGNhcHR1cmUgZGVwZW5kZW5jaWVzIGJlZm9yZSB5aWVsZGluZyB1cCB0byB0aGUgZ3JhcGggZm9yIGFuc3dlcnNcbiAgICAgIC8vIHtzdG9yZToge3N0b3JhZ2Vfa2V5OiB0cnVlfSwgcXVlcnk6IHtxdWVyeV9pZDogdHJ1ZX19XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyh2YWx1ZS5zdG9yZSA/PyB7fSkpIHtcbiAgICAgICAgdGhpcy4ja2V5RGVwc1trZXldID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgcWlkIG9mIE9iamVjdC5rZXlzKHZhbHVlLnF1ZXJ5ID8/IHt9KSkge1xuICAgICAgICB0aGlzLiNxdWVyeURlcHNbcWlkXSA9IHRydWU7XG4gICAgICB9XG4gICAgICAvLyBsZXQgdGhlIGdyYXBoIHByb3ZpZGUgYW5zd2Vyc1xuICAgICAgYW5zID0geWllbGQgdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgLy8gcGFydCBvZiBncmFwaCBhcGlcbiAgbm90aWZ5KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmNsb3NlZCkgcmV0dXJuO1xuICAgIGZvciAoY29uc3Qgc3ViIG9mIHRoaXMuI3N1YnMpIHtcbiAgICAgIHN1Yih0aGlzLiNyZXN1bHQhKTtcbiAgICB9XG4gICAgdGhpcy5sYXRlc3QgPSB0aGlzLiNyZXN1bHQ7XG4gIH1cbn1cblxuLyogR3JhcGhSdW4gcmVwcmVzZW50cyBvbmUgcnVuIG9mIHRoZSBRdWVyeUdyYXBoLiAgSGF2aW5nIGl0IGFzIGEgc2VwYXJhdGUgb2JqZWN0IHJhdGhlciB0aGFuIGFcbiAgIHNpbmdsZSBnZW5lcmF0b3IgZnVuY3Rpb24gKGFzIGl0IG9uY2Ugd2FzIHdyaXR0ZW4pIGFsbG93cyBhIGdyYXBoIHRvIGJlIGV4dGVuZGVkIGlmIG5ldyBxdWVyaWVzXG4gICBhcnJpdmUgKi9cbmNsYXNzIEdyYXBoUnVuPFFYPiB7XG4gICNxeDogUVg7XG4gIC8vIHtrZXk6IHRydWV9XG4gICNjb21taXRLZXlzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPjtcblxuICAvLyB0aGUgW3Jlc3VsdCwgZGlydHldIG9mIHF1ZXJpZXMgd2hpY2ggaGF2ZSByYW5cbiAgLy8ge3F1ZXJ5X2lkOiBbdmFsdWUsIGRpcnR5XX1cbiAgI3JhbjogUmVjb3JkPHN0cmluZywgW3Vua25vd24sIGJvb2xlYW5dPiA9IHt9O1xuXG4gIGNvbnN0cnVjdG9yKHF4OiBRWCwgY29tbWl0S2V5czogUmVjb3JkPHN0cmluZywgdHJ1ZT4pIHtcbiAgICB0aGlzLiNxeCA9IHF4O1xuICAgIHRoaXMuI2NvbW1pdEtleXMgPSBjb21taXRLZXlzO1xuICB9XG5cbiAgLy8gUnVuIHRoZSBxdWVyeSBncmFwaCB0byBjb21wbGV0aW9uLlxuICAvL1xuICAvLyBydW4oKSBtYXkgYmUgY2FsbGVkIG9uY2UgYWZ0ZXIgY29uc3RydWN0aW9uIGFnYWluc3QgYWxsIGV4aXN0aW5nIHF1ZXJpZXMsIHRoZW4gbWF5IGJlIGNhbGxlZFxuICAvLyBhZGRpdGlvbmFsIHRpbWVzIGFzIG5ldyBxdWVyaWVzIGFyZSBhZGRlZCB0byB0aGUgUXVlcnlHcmFwaC5cbiAgLy8geWllbGRzOiBsaXN0IG9mIGtleXMsIHJldHVybnMgY2FsbGJhY2sgZm9yIHVzZXJzLCByZWNlaXZlczogbWFwIG9mIGtleXMgdG8gdmFsdWVzXG4gICpydW4ocXVlcmllczogUXVlcnlXcmFwcGVyPFFYPltdKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8vIGZyZWV6ZSBjdXJyZW50IHF1ZXJ5IGxpc3QsIGluIGNhc2Ugb3VyIGNhbGxlciBldmVyIGdpdmVzIHVzIHNvbWV0aGluZyB0aGV5IGludGVuZCB0byBtdXRhdGVcbiAgICBxdWVyaWVzID0gWy4uLnF1ZXJpZXNdO1xuXG4gICAgLy8gZXZlcnkgcXVlcnkgd2hpY2ggaXMgY3VycmVudGx5IHJ1bm5pbmdcbiAgICAvLyB7cXVlcnlfaWQ6IGdlbmVyYXRvcn1cbiAgICBjb25zdCBhY3RpdmU6IFJlY29yZDxzdHJpbmcsIFF1ZXJ5R2VuZXJhdG9yPFt1bmtub3duLCBib29sZWFuXT4+ID0ge307XG4gICAgLy8gYSByZWNvcmQgb2Yge3F1ZXJ5X2lkOiBhbnN3ZXJ9IHRvIGZlZWQgdG8gY29yb3V0aW5lc1xuICAgIGxldCBydW5uYWJsZTogUmVjb3JkPHN0cmluZywgUXVlcnlBbnN3ZXI+ID0ge307XG4gICAgLy8gd2hpY2ggcXVlcmllcyBhcmUgdW5ibG9ja2VkIGJ5IGEgZ2l2ZW4gYW5zd2VyXG4gICAgLy8ge2Fuc3dlcl9rZXk6IHF1ZXJ5X2lkW119XG4gICAgY29uc3Qgd2FudEFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHt9O1xuICAgIC8vIHdoaWNoIHF1ZXJpZXMgYXJlIHVuYmxvY2tlZCBieSBhIGdpdmVuIHF1ZXJ5IHJlc3VsdFxuICAgIC8vIHtxdWVyeV9pZDogcXVlcnlfaWRbXX1cbiAgICBjb25zdCB3YW50UmVzdWx0czogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG5cbiAgICAvLyBzdGFydCBldmVyeSBxdWVyeSBpbiBwYXJhbGxlbFxuICAgIGZvciAoY29uc3QgcSBvZiBxdWVyaWVzKSB7XG4gICAgICBjb25zdCBnID0gcS5ydW4odGhpcy4jcXgsIHRoaXMuI2NvbW1pdEtleXMpO1xuICAgICAgYWN0aXZlW3EuaWRdID0gZztcbiAgICAgIC8vIHByb3ZpZGUgYSBwaG9ueSBmaXJzdCBhbnN3ZXIgdG8gc3RhcnQgdGhlIGdlbmVyYXRvciBvZmZcbiAgICAgIHJ1bm5hYmxlW3EuaWRdID0ge3N0b3JlOiB7fSwgcXVlcnk6IHt9fTtcbiAgICB9XG5cbiAgICAvLyBydW4gdGhlIGdyYXBoIHRvIGNvbXBsZXRpb25cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgLy8gcnVuIHJ1bm5hYmxlcyB1bnRpbCB3ZSBydW4gb3V0OyBlYWNoIHJ1bm5hYmxlIG1heSB1bmxvY2sgb3RoZXIgcnVubmFibGVzXG4gICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICBjb25zdCBhbnN3ZXJzID0gT2JqZWN0LmVudHJpZXMocnVubmFibGUpO1xuICAgICAgICBpZiAoYW5zd2Vycy5sZW5ndGggPT09IDApIGJyZWFrO1xuICAgICAgICBydW5uYWJsZSA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IFtxaWQsIGFuc10gb2YgYW5zd2Vycykge1xuICAgICAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBhY3RpdmVbcWlkXS5uZXh0KGFucyk7XG4gICAgICAgICAgaWYgKGRvbmUpIHtcbiAgICAgICAgICAgIC8vIHF1ZXJ5IGZpbmlzaGVkXG4gICAgICAgICAgICBkZWxldGUgYWN0aXZlW3FpZF07XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSB2YWx1ZTtcbiAgICAgICAgICAgIHRoaXMuI3JhbltxaWRdID0gcmVzdWx0O1xuICAgICAgICAgICAgLy8gdW5ibG9jayBhbnlib2R5IHdhaXRpbmcgZm9yIHRoaXMgcmVzdWx0XG4gICAgICAgICAgICBjb25zdCB3YWl0aW5nID0gd2FudFJlc3VsdHNbcWlkXTtcbiAgICAgICAgICAgIGlmICh3YWl0aW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgZGVsZXRlIHdhbnRSZXN1bHRzW3FpZF07XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgaWQgb2Ygd2FpdGluZykge1xuICAgICAgICAgICAgICAgIHNldGRlZmF1bHQocnVubmFibGUsIGlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5xdWVyeVtxaWRdID0gcmVzdWx0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gcXVlcnkgaXMgYmxvY2tlZDsgaGFuZGxlIGl0cyBzdG9yZSBhbmQgcXVlcnkgcXVlc3Rpb25zXG4gICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuc3RvcmUgPz8ge30pKSB7XG4gICAgICAgICAgICBzZXRkZWZhdWx0KHdhbnRBbnN3ZXJzLCBrZXksIFtdKS5wdXNoKHFpZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGZvciAoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModmFsdWUucXVlcnkgPz8ge30pKSB7XG4gICAgICAgICAgICAvLyBoYXMgdGhpcyBxdWVyeSByYW4geWV0P1xuICAgICAgICAgICAgaWYgKGlkIGluIHRoaXMuI3Jhbikge1xuICAgICAgICAgICAgICAvLyB3ZSBhbHJlYWR5IGhhdmUgdGhpcyByZXN1bHRcbiAgICAgICAgICAgICAgc2V0ZGVmYXVsdChydW5uYWJsZSwgcWlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5xdWVyeVtpZF0gPSB0aGlzLiNyYW5baWRdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gd2FrZSB0aGlzIHF1ZXJ5IHVwIHdoZW4gdGhlIG90aGVyIHF1ZXJ5IGZpbmlzaGVzXG4gICAgICAgICAgICAgIHNldGRlZmF1bHQod2FudFJlc3VsdHMsIGlkLCBbXSkucHVzaChxaWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBhcmUgd2UgYWxsIGRvbmU/XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYWN0aXZlKS5sZW5ndGggPT09IDApIGJyZWFrO1xuXG4gICAgICAvLyBzZW5kIGFsbCBwZW5kaW5nIHF1ZXN0aW9ucyB0byBzdG9yYWdlXG4gICAgICBjb25zdCBnZXRzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMod2FudEFuc3dlcnMpKSB7XG4gICAgICAgIGdldHNba2V5XSA9IHRydWU7XG4gICAgICB9XG4gICAgICBjb25zdCBhbnN3ZXJzID0gKHlpZWxkIHtnZXQ6IGdldHN9KS5nZXQ7XG5cbiAgICAgIC8vIHByb2Nlc3MgYW5zd2Vyc1xuICAgICAgY29uc3QgYW5zd2VyRW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGFuc3dlcnMpO1xuICAgICAgaWYgKGFuc3dlckVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImVtcHR5IGFuc3dlclwiKTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGFuc3dlckVudHJpZXMpe1xuICAgICAgICBmb3IgKGNvbnN0IHFpZCBvZiB3YW50QW5zd2Vyc1trZXldKSB7XG4gICAgICAgICAgc2V0ZGVmYXVsdChydW5uYWJsZSwgcWlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5zdG9yZVtrZXldID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHdhbnRBbnN3ZXJzW2tleV07XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gcmV0dXJuIGEgY2FsbGJhY2sgdG8gbm90aWZ5IHF1ZXJ5IHN1YnNjcmliZXJzXG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgcSBvZiBxdWVyaWVzKSB7XG4gICAgICAgIGNvbnN0IFssZGlydHldID0gdGhpcy4jcmFuW3EuaWRdO1xuICAgICAgICBpZiAoZGlydHkpIHEubm90aWZ5KCk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxufVxuXG4vKiBRdWVyeUdyYXBoIGlzIHJlc3BvbnNpYmxlIGZvciB0cmFja2luZyBxdWVyaWVzIGdlbmVyYXRlZCBieSB0aGUgVUkgYW5kIHJlcnVubmluZyB0aGVtIHdoZW4gbmV3XG4gICBkYXRhIGlzIHByZXNlbnQuICBJdCB0cmFja3MgZGVwZW5kZW5jaWVzIG9mIGEgcXVlcnkgZnVuY3Rpb24gYnkgaW5qZWN0aW5nIGEgcXVlcnkgY29udGV4dCwgd2hpY2hcbiAgIHByb3ZpZGVzIHRoZSBhY3R1YWwga2V5LXZhbHVlIGxvb2t1cCBjYXBhYmlsaXR5IHRvIHRoZSBmdW5jdGlvbi4gIEl0IGlzIGluZm9ybWVkIG9mIGNoYW5nZXMgdG9cbiAgIHN0b3JhZ2UgYnkgdGhlIE1pZGVuZCwgc3VjaCBhcyBzb21lIGtleXMgYmVpbmcgdXBkYXRlZCBieSB0aGUgVUksIGtleXMgb2YgYW4gb2xkIG92ZXJsYXkgYmVpbmdcbiAgIGRpc2NhcmRlZCwgb3IgbmV3IGZvcmVjYXN0IGRhdGEgZnJvbSB0aGUgVUkgaXRzZWxmLiAqL1xuZXhwb3J0IGNsYXNzIFF1ZXJ5R3JhcGg8UVg+IHtcbiAgI3F4OiBRWDtcbiAgI2RpcnR5OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAjcXVlcmllczogUmVjb3JkPHN0cmluZywgUXVlcnlXcmFwcGVyPFFYPj4gPSB7fTtcbiAgI25ld1F1ZXJpZXM6IFF1ZXJ5V3JhcHBlcjxRWD5bXSA9IFtdO1xuICAjaWQ6IG51bWJlciA9IDE7XG5cbiAgI3J1bjogR3JhcGhSdW48UVg+O1xuXG4gIGNvbnN0cnVjdG9yKHF4OiBRWCkge1xuICAgIHRoaXMuI3F4ID0gcXg7XG4gICAgLy8gc3RhcnQgd2l0aCBhbiBlbXB0eSBncmFwaHJ1blxuICAgIHRoaXMuI3J1biA9IG5ldyBHcmFwaFJ1bih0aGlzLiNxeCwge30pO1xuICB9XG5cbiAgbmV3UXVlcnk8VD4oZm46IFF1ZXJ5RnVuY3Rpb248UVgsIFQ+LCBtYW51YWxTdGFydDogYm9vbGVhbiwgb25TdGFydDogKCkgPT4gdm9pZCk6IFF1ZXJ5PFQ+IHtcbiAgICBjb25zdCBpZCA9IGAke3RoaXMuI2lkKyt9YDtcbiAgICBjb25zdCBxID0gbmV3IF9RdWVyeShpZCwgZm4sICgpID0+IHtcbiAgICAgIG9uU3RhcnQoKTtcbiAgICAgIHRoaXMuI3F1ZXJpZXNbaWRdID0gcTtcbiAgICAgIHRoaXMuI25ld1F1ZXJpZXMucHVzaChxKTtcbiAgICB9KTtcbiAgICBpZiAoIW1hbnVhbFN0YXJ0KSBxLnN0YXJ0KCk7XG4gICAgcmV0dXJuIHE7XG4gIH1cblxuICBkaXJ0eShrZXlzOiBzdHJpbmdbXSk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcbiAgICAgIHRoaXMuI2RpcnR5W2tleV0gPSB0cnVlO1xuICAgIH1cbiAgfVxuXG4gICpydW4oKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8vIHN0YXJ0IGEgbmV3IGdyYXBoIHJ1blxuICAgIGNvbnN0IGNvbW1pdEtleXMgPSB0aGlzLiNkaXJ0eTtcbiAgICB0aGlzLiNkaXJ0eSA9IHt9O1xuICAgIHRoaXMuI3J1biA9IG5ldyBHcmFwaFJ1bih0aGlzLiNxeCwgY29tbWl0S2V5cyk7XG5cbiAgICAvLyBydW4gYWdhaW5zdCBhbGwgcXVlcmllc1xuICAgIGNvbnN0IHF1ZXJpZXMgPSBPYmplY3QudmFsdWVzKHRoaXMuI3F1ZXJpZXMpO1xuICAgIHRoaXMuI25ld1F1ZXJpZXMgPSBbXTtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI2V4ZWN1dGUocXVlcmllcyk7XG4gIH1cblxuICAqZXh0ZW5kKCk6IFJTdG9yYWdlR2VuZXJhdG9yPCgpID0+IHZvaWQ+IHtcbiAgICAvLyBleHRlbmQgYW4gZXhpc3RpbmcgZ3JhcGggcnVuIHdpdGggb25seSBuZXcgcXVlcmllc1xuICAgIGNvbnN0IHF1ZXJpZXMgPSB0aGlzLiNuZXdRdWVyaWVzO1xuICAgIHRoaXMuI25ld1F1ZXJpZXMgPSBbXTtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI2V4ZWN1dGUocXVlcmllcyk7XG4gIH1cblxuICAqI2V4ZWN1dGUocXVlcmllczogUXVlcnlXcmFwcGVyPFFYPltdKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8qIFRPRE86IHB1dCBhIGdyYXBoLXdpZGUgc3RvcmFnZSBjYWNoZSBoZXJlLiAgV2UgY2FuIGtlZXAgYSBuZXcgY2FjaGUgYW5kIGFuIG9sZCBjYWNoZS4gIFdoZW5cbiAgICAgICB0aGUgbmV3IGNhY2hlIGlzIGhpdCB3ZSByZXR1cm4gaXQgaW1tZWRpYXRlbHkuICBXaGVuIHRoZSBvbGQgY2FjaGUgaXMgaGl0LCB3ZSBwb3AgZnJvbSBvbGQsXG4gICAgICAgcGxhY2UgaW4gbmV3LCB0aGVuIHJldHVybi4gIFdoZW4gd2Ugc3RhcnQgYSBuZXcgZ3JhcGggcnVuIHdlIGRpc2NhcmQgdGhlIG9sZCBvbGQsIG1ha2UgdGhlXG4gICAgICAgb2xkIG5ldyBpbnRvIHRoZSBuZXcgb2xkLCBhbmQgY3JlYXRlIGEgbmV3LCBlbXB0eSBuZXcuICAgV2UnbGwgbmVlZCBzb21ldGhpbmcgbGlrZSB0aGVcbiAgICAgICB3aGlsZSBsb29wIGluIEdyYXBoUnVuIHRvIHJldHVybiBwYXJ0aWFsIGFuc3dlcnMgdW50aWwgd2UgYXJlIGZ1bGx5IGJsb2NrZWQuXG5cbiAgICAgICBBZGRpdGlvbmFsIGlkZWFzIG1pZ2h0IGJlOlxuICAgICAgICAgLSBncmFudCBpbmRpdmlkdWFsIGxvb2t1cHMgYSBjYWNoZSBjb250cm9sIGZsYWcgKHRydWUvZmFsc2UvdW5kZWZpbmVkKVxuICAgICAgICAgLSBhbGxvdyBjb25maWd1cmluZyB0aGUgZ3JhcGgtd2lkZSBxdWVyeSBkZWZhdWx0IGNhY2hlIGRpc3Bvc2l0aW9uICh0cnVlL2ZhbHNlKVxuICAgICAgICAgLSBtYXliZSBhIGZyZXF1ZW50IHVzZSBjYWNoZSBtb2RlLCB3aGVyZSB3ZSB0cmFjayBzdGF0cyBvZiBrZXkgbG9va3VwIHVzYWdlIGFuZCBjYWNoZVxuICAgICAgICAgICB0aGUgbW9zdCBmcmVxdWVudGx5IHVzZWQga2V5c1xuICAgICAgICAgLSBuYWgsIGp1c3QgbGV0IHRoZSBjYWNoZSBiZSBhIGNvbmZpZ3VyYWJsZSBleHRyYSBsYXllci4gIFRvbyBtYW55IHdheXMgdG8gZG8gaXQuXG4gICAgICAgICAtIHByb2JhYmx5IGZvcmNlIHlvdXJzZWxmIHRvIHNraXAgdGhpcyBmb3Igbm93LlxuICAgICovXG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiNydW4ucnVuKHF1ZXJpZXMpO1xuICB9XG59XG5cbi8vIGZyYW1ld29ya3MgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuLy8gRXZlbnQgd3JhcHMgYSBwcm90byB0eXBlIFQgd2l0aCBhIGNsaWVudCBpZC4gIEFuIEV2ZW50IG1heSBoYXZlIG9yaWdpbmF0ZWQgZnJvbSBLdXJyZW50REIsIG9yXG4vLyBpdCBtYXkgaGF2ZSBiZWVuIGVtaXR0ZWQgYnkgYSBmb3JlY2FzdGVyLCBvciBpdCBtYXkgYmUgYSBjb21tYW5kIHdlIGFyZSBhYm91dCB0byBzZW5kLlxuZXhwb3J0IHR5cGUgRXZlbnQ8VD4gPSB7XG4gIGlkOiBzdHJpbmcsXG4gIGRhdGE6IFQsXG59O1xuXG4vLyBSZWFsRXZlbnQgZXh0ZW5kcyBFdmVudCB3aXRoIHN0cmVhbSBwb3NpdGlvbiBkYXRhIHRoYXQgb3JpZ2luYXRlcyBmcm9tIEt1cnJlbnREQi5cbmV4cG9ydCB0eXBlIFJlYWxFdmVudDxUPiA9IEV2ZW50PFQ+ICYge1xuICBwb3NpdGlvbjogbnVtYmVyLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZVJlYWxFdmVudDxUPih2YWw6IGFueSwgc3ViZGVjb2RlcjogKHZhbDogYW55KSA9PiBUKTogUmVhbEV2ZW50PFQ+IHtcbiAgcmV0dXJuIHsgLi4udmFsLCBkYXRhOiBzdWJkZWNvZGVyKHZhbC5kYXRhKSB9IGFzIFJlYWxFdmVudDxUPjtcbn1cblxuZnVuY3Rpb24gbWF0Y2hTZW50PEM+KHRwbDogYW55LCBjbWQ6IEMpOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiB0cGwgIT09IHR5cGVvZiBjbWQpIHJldHVybiBmYWxzZTtcbiAgc3dpdGNoICh0eXBlb2YgdHBsKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICByZXR1cm4gdHBsID09PSBjbWQ7XG5cbiAgICBjYXNlIFwiZnVuY3Rpb25cIjpcbiAgICAgIHJldHVybiB0cGwoY21kKTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAodHBsID09PSBudWxsKSByZXR1cm4gY21kID09PSBudWxsO1xuICAgICAgLy8gZ2VuZXJhbCBvYmplY3RzIGhhbmRsZWQgYmVsb3dcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcInN5bWJvbFwiOlxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG1hcmsgb2YgdHlwZSBcIiR7dHlwZW9mIHRwbH1cIiBub3QgaGFuZGxlZCBieSBtYXRjaFNlbnRgKTtcbiAgfVxuXG4gIGlmIChBcnJheS5pc0FycmF5KHRwbCkpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY21kKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0cGwubGVuZ3RoICE9PSBjbWQubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRwbC5ldmVyeSgodiwgaSkgPT4gbWF0Y2hTZW50KHYsIGNtZFtpXSkpO1xuICB9XG5cbiAgaWYgKHRwbCBpbnN0YW5jZW9mIE1hcCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgbWFyayBvZiB0eXBlIE1hcCBub3QgaGFuZGxlZCBieSBtYXRjaFNlbnRgKTtcbiAgfVxuICBpZiAodHBsIGluc3RhbmNlb2YgU2V0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBtYXJrIG9mIHR5cGUgU2V0IG5vdCBoYW5kbGVkIGJ5IG1hdGNoU2VudGApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHRwbCkuZXZlcnkoKFtrLCB2XSkgPT4gbWF0Y2hTZW50KHYsIChjbWQgYXMgUmVjb3JkPHN0cmluZywgYW55Pilba10pKTtcbn1cblxuLy8gXCJSXCJlZHVjZXJDb250ZVwieFwidFxuLy8gXCJRXCJ1ZXJ5Q29udGVcInhcInRcbi8vIFwiRVwidmVudHNcbi8vIFwiQ1wib21tYW5kc1xuZXhwb3J0IGNsYXNzIEZyYW1ld29yazxRWCwgUlgsIEUsIEM+IHtcbiAgI3J4OiBSWDtcbiAgI3N0b3JhZ2U6IFN0b3JhZ2U7XG4gICNkZWNvZGVFdmVudDogKHJhdzogYW55KSA9PiBFO1xuICAjbWlncmF0ZTogbnVsbCB8ICgocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+KTtcbiAgI3JlZHVjZXI6IChyeDogUlgsIGV2ZW50czogRVtdKSA9PiBSZWR1Y2VyPGFueVtdIHwgdm9pZD47XG4gICNmb3JlY2FzdGVyOiBudWxsIHwgKChjb21tYW5kczogQykgPT4gRVtdKTtcbiAgI2RlY29kZUNvbW1hbmQ6IG51bGwgfCAoKHJhdzogYW55KSA9PiBDKTtcbiAgI29uQ29tbWFuZHM6IG51bGwgfCAoKGNvbW1hbmRzOiBFdmVudDxhbnk+W10pID0+IHZvaWQpO1xuXG4gICNsaXZlOiBib29sZWFuID0gZmFsc2U7XG4gICNzZXRMaXZlOiBib29sZWFuID0gZmFsc2U7XG4gICNvdmVybGF5OiBPdmVybGF5U3RvcmFnZTtcbiAgI2dyYXBoOiBRdWVyeUdyYXBoPFFYPjtcbiAgI2Nvcm86IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPjtcbiAgI2Z4OiBGdXR1cmVDb250ZXh0O1xuXG4gICNzY2hlZHVsZWQ6IGJvb2xlYW4gPSBmYWxzZTtcblxuICAvLyAjcmVjb25uZWN0cyBpcyBhIGxpc3Qgb2YgcHJvbWlzZSByZXNvbHZlIGZ1bmN0aW9uc1xuICAjcmVjb25uZWN0czogKFxuICAgICh2YWx1ZToge2NoZWNrcG9pbnQ6IG51bWJlciB8IHVuZGVmaW5lZCwgY29tbWFuZHM6IEV2ZW50PGFueT5bXX0pID0+IHZvaWRcbiAgKVtdID0gW107XG4gICNyZWN2ZEV2ZW50czogUmVhbEV2ZW50PEU+W10gPSBbXTtcbiAgLy8gY29tbWFuZHMgdGhhdCBjYW1lIHRvIHVzIGZyb20gdGhlIGNsaWVudFxuICAjc2VuZENvbW1hbmRzOiBDW10gPSBbXTtcbiAgLy8gY29tbWFuZCBpZHMgdGhlIHVzZXIgZXhwbGljaXRseSBtYXJrcyBhcyBjb21wbGV0ZWRcbiAgI3JvdW5kVHJpcHBlZDogc3RyaW5nW10gPSBbXTtcbiAgLy8gb3JkZXJlZCBtYXAgb2YgY29tbWFuZCBpZHMgdG8gdGhlIGZvcmVjYXN0ZWQgZXZlbnRzIGZyb20gdGhhdCBjb21tYW5kXG4gICN1bnNlbnQ6IE1hcDxzdHJpbmcsIEVbXT4gPSBuZXcgTWFwKCk7XG4gIC8vIGp1c3QgYSBmbGFnIGlmIG5ldyBxdWVyaWVzIGV4aXN0IHRvIGJlIHJ1bjsgd2UgZG9uJ3Qgc3RvcmUgdGhlbSBoZXJlIGZvciB0eXBpbmcgcHVycG9zZXMuXG4gICNuZXdRdWVyaWVzOiBib29sZWFuID0gZmFsc2U7XG4gICNzaW11bGF0ZXM6ICgoKSA9PiBSZWR1Y2VyPHZvaWQ+KVtdID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcXg6IFFYLFxuICAgIHJ4OiBSWCxcbiAgICAvLyBpZiBzdG9yYWdlIGlzIG51bGwsIEluTWVtU3RvcmFnZSBpcyB1c2VkXG4gICAgc3RvcmFnZTogU3RvcmFnZSB8IG51bGwsXG4gICAgY2FsbGJhY2tzOiB7XG4gICAgICAvLyByZXF1aXJlZDogY29udmVydCBmcm9tIGpzb24gZm9ybWF0IHRvIGZ1bGwgdHlwZVxuICAgICAgZGVjb2RlRXZlbnQ6IChyYXc6IGFueSkgPT4gRSxcbiAgICAgIC8vIHJlcXVpcmVkIGlmIHVzaW5nIHNlbmRDb21tYW5kczogY29udmVydCBmcm9tIHN0b3JhZ2Uvd2lyZSBmb3JtYXRcbiAgICAgIGRlY29kZUNvbW1hbmQ6IChyYXc6IGFueSkgPT4gQyxcbiAgICAgIC8vIG9wdGlvbmFsOiBjb25maWd1cmUgc3RvcmFnZSBiZWZvcmUgYW55IGV2ZW50cyBhcnJpdmVcbiAgICAgIG1pZ3JhdGU/OiAocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+LFxuICAgICAgLy8gcmVxdWlyZWQ6IHJlZHVjZSBhIGJhdGNoIG9mIGV2ZW50cyBpbnRvIHRoZSByZWFkIG1vZGVsXG4gICAgICByZWR1Y2VyOiAocng6IFJYLCBldmVudHM6IEVbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgICAgLy8gb3B0aW9uYWw6IGZvcmVjYXN0IHRoZSBldmVudHMgYSBzZXJ2ZXIgd2lsbCBzZW5kIGZvciBhIGJhdGNoIG9mIGNvbW1hbmRzXG4gICAgICBmb3JlY2FzdGVyPzogKGNvbW1hbmRzOiBDKSA9PiBFW10sXG4gICAgICAvLyByZXF1aXJlZCBpZiB1c2luZyBzZW5kQ29tbWFuZHM6IHJlY2VpdmUgZXZlbnRzIHRvIHNlbmQgb24gdGhlIHdpcmVcbiAgICAgIG9uQ29tbWFuZHM/OiAoY29tbWFuZHM6IGFueVtdKT0+IHZvaWQsXG4gICAgfSxcbiAgKSB7XG4gICAgdGhpcy4jcnggPSByeDtcbiAgICB0aGlzLiNzdG9yYWdlID0gc3RvcmFnZSA/PyBuZXcgSW5NZW1TdG9yYWdlKCk7XG4gICAgdGhpcy4jZGVjb2RlRXZlbnQgPSBjYWxsYmFja3MuZGVjb2RlRXZlbnQ7XG4gICAgdGhpcy4jZGVjb2RlQ29tbWFuZCA9IGNhbGxiYWNrcy5kZWNvZGVDb21tYW5kID8/IG51bGw7XG4gICAgdGhpcy4jbWlncmF0ZSA9IGNhbGxiYWNrcy5taWdyYXRlID8/IG51bGw7XG4gICAgdGhpcy4jcmVkdWNlciA9IGNhbGxiYWNrcy5yZWR1Y2VyO1xuICAgIHRoaXMuI2ZvcmVjYXN0ZXIgPSBjYWxsYmFja3MuZm9yZWNhc3RlciA/PyBudWxsO1xuICAgIHRoaXMuI29uQ29tbWFuZHMgPSBjYWxsYmFja3Mub25Db21tYW5kcyA/PyBudWxsO1xuXG4gICAgdGhpcy4jb3ZlcmxheSA9IG5ldyBPdmVybGF5U3RvcmFnZSh0aGlzLiNzdG9yYWdlKTtcbiAgICB0aGlzLiNncmFwaCA9IG5ldyBRdWVyeUdyYXBoKHF4KTtcblxuICAgIHRoaXMuI2Nvcm8gPSB0aGlzLiNhZHZhbmNlcigpO1xuICAgIHRoaXMuI2Z4ID0gbmV3IEZ1dHVyZUNvbnRleHQodGhpcy4jY29ybyk7XG4gICAgLy8gbGV0IHRoZSBhZHZhbmNlciBiZWdpbiBpbml0aWFsaXppbmdcbiAgICB0aGlzLiNmeC53YWtldXAoKTtcbiAgfVxuXG4gIC8vLy8gcHVibGljIGFwaSAvLy8vXG5cbiAgLy8gcmVxdWVzdCBpbmZvIG5lZWRlZCB0byByZXN1bWUgYSBjb25uZWN0aW9uOiBsYXN0IGNvbW1pdHRlZCBjaGVja3BvaW50IGFuZCB1bnNlbnQgY29tbWFuZHNcbiAgcmVjb25uZWN0KFxuICAgIGNiOiAocmVzdWx0OiB7Y2hlY2twb2ludDogbnVtYmVyIHwgdW5kZWZpbmVkLCBjb21tYW5kczogRXZlbnQ8YW55PltdfSkgPT4gdm9pZCxcbiAgKTogdm9pZCB7XG4gICAgdGhpcy4jcmVjb25uZWN0cy5wdXNoKGNiKTtcbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgLy8gbmV3IGV2ZW50cyBmcm9tIHRoZSB3aXJlIGNvbWUgaGVyZVxuICByZWN2RXZlbnRzKHJhdzogUmVhbEV2ZW50PGFueT5bXSk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgciBvZiByYXcpIHtcbiAgICAgIGNvbnN0IGV2ZW50ID0gRGVjb2RlUmVhbEV2ZW50KHIsIHRoaXMuI2RlY29kZUV2ZW50KTtcbiAgICAgIHRoaXMuI3JlY3ZkRXZlbnRzLnB1c2goZXZlbnQpO1xuICAgIH1cbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgZmVsbEJlaGluZCgpOiB2b2lkIHtcbiAgICB0aGlzLiNzZXRMaXZlID0gZmFsc2U7XG4gICAgdGhpcy4jc2NoZWR1bGUoKTtcbiAgfVxuXG4gIGNhdWdodFVwKCk6IHZvaWQge1xuICAgIHRoaXMuI3NldExpdmUgPSB0cnVlO1xuICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gIH1cblxuICAvLyBhZnRlciBmb3JlY2FzdGluZyBhbmQgc2F2aW5nIHRvIHN0b3JhZ2UsIHRoZXNlIHdpbGwgYXBwZWFyIGluIGFuIG9uQ29tbWFuZHMoKSBjYWxsYmFja1xuICBzZW5kQ29tbWFuZHMoY29tbWFuZHM6IENbXSk6IHZvaWQge1xuICAgIGlmICghdGhpcy4jb25Db21tYW5kcyB8fCAhdGhpcy4jZGVjb2RlQ29tbWFuZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcImlmIHNlbmRDb21tYW5kcygpIGlzIHVzZWQsIHRoZSBmb2xsb3dpbmcgY2FsbGJhY2tzIG11c3QgYmUgZGVmaW5lZDogXCJcbiAgICAgICAgKyBcIm9uQ29tbWFuZHMgYW5kIGRlY29kZUNvbW1hbmRcIlxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy4jc2VuZENvbW1hbmRzLnB1c2guYXBwbHkodGhpcy4jc2VuZENvbW1hbmRzLCBjb21tYW5kcyk7XG4gICAgdGhpcy4jc2NoZWR1bGUoKTtcbiAgfVxuXG4gIC8vIG5vcm1hbGx5IGZvcmVjYXN0ZWQgZXZlbnRzIGFyZSBkaXNjYXJkZWQgd2hlbiB0aGUgZXZlbnQgaWQgdGhhdCB3YXMgc3VibWl0dGVkIGlzIG9ic2VydmVkIGluXG4gIC8vIHJlY3ZFdmVudHMoKS4gIEJ1dCBpZiB0aGUgY29tbWFuZCB3YXMgcmVqZWN0ZWQsIHRoZW4gaXQgbWF5IGJlIG5lY2Vzc2FyeSB0byBleHBsaWNpdGx5IGZsYWcgdGhlXG4gIC8vIGNvbW1hbmQgYXMgc2VudCwgc28gdGhlIGZvcmVjYXN0ZWQgZXZlbnRzIGZyb20gdGhhdCByZWplY3RlZCBjb21tYW5kIGNhbiBiZSBkaXNjYXJkZWQuXG4gIG1hcmtTZW50KC4uLmlkOiBzdHJpbmdbXSk6IHZvaWQge1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZC5wdXNoKC4uLmlkKTtcbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgLy8gYWRkIGEgbmV3IFF1ZXJ5IHRvIHRoZSBncmFwaFxuICBuZXdRdWVyeTxUPihmbjogUXVlcnlGdW5jdGlvbjxRWCwgVD4sIG1hbnVhbFN0YXJ0PzogYm9vbGVhbik6IFF1ZXJ5PFQ+IHtcbiAgICByZXR1cm4gdGhpcy4jZ3JhcGgubmV3UXVlcnkoZm4sIG1hbnVhbFN0YXJ0ID8/IGZhbHNlLCAoKSA9PiB7XG4gICAgICB0aGlzLiNuZXdRdWVyaWVzID0gdHJ1ZTtcbiAgICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gICAgfSk7XG4gIH1cblxuICBzaW11bGF0ZTxUPihcbiAgICBmbjogKHJ4OiBSWCwgZGVjb2RlZEV2ZW50czogRVtdKSA9PiBSZWR1Y2VyPFQ+LFxuICAgIGNiOiAocmVzdWx0OiBUKSA9PiB2b2lkLFxuICAgIHVuZGVjb2RlZEV2ZW50cz86IEV2ZW50PGFueT5bXSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgdGhpcy4jc2ltdWxhdGVzLnB1c2goZnVuY3Rpb24qKCkge1xuICAgICAgLy8gdW53cmFwIGFuZCBkZWNvZGUgZXZlbnRzXG4gICAgICBjb25zdCBkZWNvZGVkID0gKHVuZGVjb2RlZEV2ZW50cyA/PyBbXSkubWFwKCh1KSA9PiBzZWxmLiNkZWNvZGVFdmVudCh1LmRhdGEpKTtcbiAgICAgIC8vIHJ1biBwcm92aWRlZCBmdW5jdGlvblxuICAgICAgY29uc3QgcmVzdWx0ID0geWllbGQqIGZuKHNlbGYuI3J4LCBkZWNvZGVkKTtcbiAgICAgIC8vIHNlbmQgcmVzdWx0XG4gICAgICBjYihyZXN1bHQpO1xuICAgIH0pO1xuICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gIH1cblxuICAvLy8vIGVuZCBvZiBwdWJsaWMgYXBpIC8vLy9cblxuICAjc2NoZWR1bGUoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuI3NjaGVkdWxlZCkgcmV0dXJuO1xuICAgIHRoaXMuI3NjaGVkdWxlZCA9IHRydWU7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLiNzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuI2Z4Lndha2V1cCgpO1xuICAgIH0pO1xuICB9XG5cbiAgKiNpbml0aWFsaXplKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBydW4gbWlncmF0aW9uIGxvZ2ljIG9uIHRoZSBkYXRhIHN0b3JlXG4gICAgaWYgKHNlbGYuI21pZ3JhdGUpIHtcbiAgICAgIHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCkge1xuICAgICAgICB5aWVsZCogcnVuUmVkdWNlcihzZWxmLiNtaWdyYXRlIShzZWxmLiNyeCkpO1xuICAgICAgICAvLyBpZ25vcmUgdXBkYXRlZCBrZXlzIGFuZCBkb24ndCB0cmlnZ2VyIGEgcnVuIG9mIHRoZSBncmFwaFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gbG9hZCB1bnNlbnQgY29tbWFuZHMgZnJvbSBzdG9yYWdlXG4gICAgY29uc3QgY29tbWFuZHM6IEV2ZW50PGFueT5bXSA9IFtdO1xuICAgIHlpZWxkKiB3aXRoUlR4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCkge1xuICAgICAgY29uc3QgaW5kZXggPSAoeWllbGQqIHR4bkdldChcIi5jb21tYW5kc1wiKSkgYXMgc3RyaW5nW10gPz8gW107XG4gICAgICBmb3IgKGNvbnN0IGlkIG9mIGluZGV4KSB7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSAoeWllbGQqIHR4bkdldChgLmNvbW1hbmQtJHtpZH1gKSkgYXMgRXZlbnQ8YW55PjtcbiAgICAgICAgY29tbWFuZHMucHVzaChjb21tYW5kKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoY29tbWFuZHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBpZiAoIXRoaXMuI2ZvcmVjYXN0ZXIpIHtcbiAgICAgIC8vIHJlbG9hZCBqdXN0IHRoZSBsaXN0IG9mIHVuc2V0IGV2ZW50IGlkc1xuICAgICAgZm9yIChjb25zdCBjb21tYW5kIG9mIGNvbW1hbmRzKSB7XG4gICAgICAgIHRoaXMuI3Vuc2VudC5zZXQoY29tbWFuZC5pZCwgW10pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIHJlbG9hZCBmb3JlY2FzdGVkIHN0YXRlXG5cbiAgICBjb25zdCBmb3JlY2FzdHM6IEVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgLy8gbm90ZSB0aGF0IHNpbmNlIHN0b3JhZ2UgbWF5IGJlIGluLW1lbW9yeSwgd2UgbXVzdCB0YWtlIGNhcmUgdG8gcHJlc2VydmUgY29tbWFuZC5kYXRhXG4gICAgICBjb25zdCBjID0gY29weU9uV3JpdGUodGhpcy4jZGVjb2RlQ29tbWFuZCEoY29tbWFuZC5kYXRhKSk7XG4gICAgICBjb25zdCBmcyA9IHJlY292ZXIodGhpcy4jZm9yZWNhc3RlcihjKSk7XG4gICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIGZzKTtcbiAgICAgIGZvcmVjYXN0cy5wdXNoKC4uLmZzKTtcbiAgICB9XG4gICAgaWYgKGZvcmVjYXN0cy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIC8vIHBvcHVsYXRlIHRoZSBpbml0aWFsIG92ZXJsYXlcbiAgICB5aWVsZCogd2l0aFdUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpIHtcbiAgICAgIHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGZvcmVjYXN0cykpO1xuICAgICAgLy8gaWdub3JlIHVwZGF0ZWQga2V5cyBhbmQgZG9uJ3QgdHJpZ2dlciBhIHJ1biBvZiB0aGUgZ3JhcGhcbiAgICB9KTtcbiAgfVxuXG4gIC8vIG91ciBtYWluIGxvZ2ljIGlzIGltcGxlbWVudGVkIGFzIGEgY29yb3V0aW5lXG4gICojYWR2YW5jZXIoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICB5aWVsZCogdGhpcy4jaW5pdGlhbGl6ZSgpO1xuXG4gICAgLy8gd2hhdCBhcmUgdGhlIGRpZmZlcmVudCB0aGluZ3Mgd2UgY2FuIGhhdmUgdG8gZG8/XG4gICAgLy8gLSByZWNlaXZlIGV2ZW50cyxcbiAgICAvLyAgICAgLSB0aGVuIHNoYXBlIHRoZW0sXG4gICAgLy8gICAgIC0gdGhlbiBwYXNzIHNoYXBlZCBldmVudHMgaW50byByZWR1Y2VycyxcbiAgICAvLyAgICAgLSB0aGVuIGNvbW1pdCB0aGF0IHJlc3VsdCBhbG9uZyB3aXRoIHRoZSBjaGVja3BvaW50LFxuICAgIC8vICAgICAtIHRoZW4gdGFrZSB0aGUgY29tbWl0IGFuZCBwYXNzIGl0IHRvIHRoZSBxdWVyeSBncmFwaFxuICAgIC8vIC0gcmVjaWV2ZSBzZW50Q29tbWFuZHMgYW5kIHVwZGF0ZSBjb21tYW5kcyBpbiBzdG9yYWdlXG4gICAgLy8gLSByZWNlaXZlIHNlbmRDb21tYW5kc1xuICAgIC8vICAgICAtIHRoZW4gY29tbWl0IHRoZW0gdG8gc3RvcmFnZSxcbiAgICAvLyAgICAgICAgIC0gdGhlbiBzZW5kIHRob3NlIHRvIG9uQ29tbWFuZCBob29rXG4gICAgLy8gICAgIC0gdGhlbiBmb3JlY2FzdCBldmVudHMsXG4gICAgLy8gICAgIC0gdGhlbiBwYXNzIHRoZW0gdG8gcmVkdWNlcnMsXG4gICAgLy8gICAgIC0gdGhlbiBjb21taXQgdGhhdCByZXN1bHQgdG8gdGhlIG92ZXJsYXlcbiAgICAvLyAgICAgLSB0aGVuIHBhc3MgdGhhdCBjb21taXQgdG8gdGhlIHF1ZXJ5IGdyYXBoXG4gICAgLy8gLSByZWNpZXZlIGEgbmV3IHF1ZXJ5XG4gICAgLy8gICAgIC0gZXh0ZW5kIHRoZSBncmFwaFxuICAgIC8vIC0gcmVjaWV2ZSBhIHJlY29ubmVjdCByZXF1ZXN0XG4gICAgLy8gICAgIC0gdGhlbiByZXR1cm4gdGhlIGNoZWNrcG9pbnQgaW4gc3RvcmFnZVxuICAgIHdoaWxlKHRydWUpe1xuICAgICAgaWYgKHRoaXMuI2xpdmUgJiYgIXRoaXMuI3NldExpdmUpIHtcbiAgICAgICAgLy8gd2UgZmVsbCBiZWhpbmQ7IGZyZWV6ZSBncmFwaCBhbmQgb3ZlcmxheSwgYW5kIHdoZW4gY2F1Z2h0VXAoKSBpcyBjYWxsZWQsIHdlJ2xsIHByb2Nlc3NcbiAgICAgICAgLy8gYWxsIGNoYW5nZXMgZnJvbSBub3cgdW50aWwgdGhlbiB3aXRoIGEgc2luZ2xlIHJ1biBvZiB0aGUgZ3JhcGhcbiAgICAgICAgdGhpcy4jbGl2ZSA9IGZhbHNlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jcmVjdmRFdmVudHMubGVuZ3RoID4gMCkge1xuICAgICAgICB5aWVsZCogdGhpcy4jb25SZWN2RXZlbnRzKCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jcm91bmRUcmlwcGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uUm91bmRUcmlwcGVkKCk7XG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIGlmICghdGhpcy4jbGl2ZSAmJiB0aGlzLiNzZXRMaXZlKSB7XG4gICAgICAgIC8vIHdlIGNhdWdodCB1cCBhbmQgcHJvY2Vzc2VkIGFsbCByZWN2ZEV2ZW50cygpOyB0aW1lIHRvIHJlc3RhcnQgdGhlIHF1ZXJ5IGdyYXBoc1xuICAgICAgICB0aGlzLiNsaXZlID0gdHJ1ZTtcbiAgICAgICAgeWllbGQqIHRoaXMuI3JlYnVpbGRPdmVybGF5KCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jc2VuZENvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uU2VuZENvbW1hbmRzKCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jbmV3UXVlcmllcyAmJiB0aGlzLiNsaXZlKSB7XG4gICAgICAgIHlpZWxkKiB0aGlzLiNvbk5ld1F1ZXJpZXMoKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLiNyZWNvbm5lY3RzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uUmVjb25uZWN0cygpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMuI3NpbXVsYXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHlpZWxkKiB0aGlzLiNvblNpbXVsYXRlcygpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gaWYgd2UgZ290IGhlcmUgd2UgcHJvYmFibHkgaGFkIGEgc3B1cmlvdXMgd2FrZXVwLCBvciBwZXJoYXBzIGEgbmV3UXVlcnkoKSB3aGlsZSBub3QgI2xpdmVcbiAgICAgIHlpZWxkXG4gICAgfVxuICB9XG5cbiAgKiNvblJlY3ZFdmVudHMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAvLyB0YWtlIGV2ZW50cyBhbmQgbGF0ZXN0IGNoZWNrcG9pbnRcbiAgICBjb25zdCBldmVudHMgPSB0aGlzLiNyZWN2ZEV2ZW50cztcbiAgICBjb25zdCBjaGVja3BvaW50ID0gZXZlbnRzLmF0KC0xKSEucG9zaXRpb247XG4gICAgdGhpcy4jcmVjdmRFdmVudHMgPSBbXTtcblxuICAgIC8vIG9wZW4gYSB3cml0ZSB0eG4gdG8gcmVhbCBzdG9yYWdlXG4gICAgY29uc3QgdXBkYXRlcyA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICAvLyB1cGRhdGUgb3VyIGNoZWNrcG9pbnQgd2hlbiB0aGlzIHR4biBmaW5pc2hlc1xuICAgICAgeWllbGQqIHR4blNldChcIi5jaGVja3BvaW50XCIsIGNoZWNrcG9pbnQpO1xuXG4gICAgICAvLyBydW4gdGhlIHJlZHVjZXIgd2l0aCBvdXIgbmV3IGV2ZW50c1xuICAgICAgY29uc3QgZXZlbnRzRGF0YSA9IGV2ZW50cy5tYXAoKGV2ZW50KSA9PiBldmVudC5kYXRhKTtcbiAgICAgIGNvbnN0IFt1cGRhdGVzLCBtYXJrZWRTZW50XSA9IHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGV2ZW50c0RhdGEpKTtcblxuICAgICAgLy8gZGlzY2FyZCB1bnNlbnQgY29tbWFuZHMgdGhhdCB3ZSBub3cga25vdyBhcmUgc2VudFxuICAgICAgaWYgKHNlbGYuI3Vuc2VudC5zaXplID4gMCkge1xuICAgICAgICAvLyBkaXNjYXJkIGNvbW1hbmRzIHdlIG9ic2VydmVkIHJvdW5kLXRyaXAgYnkgbWF0Y2hpbmcgZXZlbnQgaWRzXG4gICAgICAgIGZvciAoY29uc3QgZXZlbnQgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgaWYgKHNlbGYuI3Vuc2VudC5oYXMoZXZlbnQuaWQpKSB7XG4gICAgICAgICAgICBzZWxmLiNyb3VuZFRyaXBwZWQucHVzaChldmVudC5pZCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIGRpc2NhcmQgY29tbWFuZHMgdGhhdCBtYXRjaCB3aGF0IHRoZSByZWR1Y2VyIHNheXMgd2FzIHNlbnRcbiAgICAgICAgaWYgKG1hcmtlZFNlbnQubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvSWdub3JlID0gc2VsZi4jcm91bmRUcmlwcGVkLnJlZHVjZShcbiAgICAgICAgICAgIChhY2MsIGlkKSA9PiAoYWNjW2lkXSA9IHRydWUsIGFjYyksXG4gICAgICAgICAgICB7fSBhcyBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgICAgICAgICApO1xuICAgICAgICAgIGZvciAoY29uc3QgaWQgb2Ygc2VsZi4jdW5zZW50LmtleXMoKSkge1xuICAgICAgICAgICAgaWYgKGlkIGluIHRvSWdub3JlKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IGV2ZW50ID0gKHlpZWxkKiB0eG5HZXQoYC5jb21tYW5kLSR7aWR9YCkpIGFzIEV2ZW50PGFueT47XG4gICAgICAgICAgICBjb25zdCBjbWQgPSBzZWxmLiNkZWNvZGVDb21tYW5kIShldmVudC5kYXRhKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbSBvZiBtYXJrZWRTZW50KSB7XG4gICAgICAgICAgICAgIGlmICghbWF0Y2hTZW50KG0sIGNtZCkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICBzZWxmLiNyb3VuZFRyaXBwZWQucHVzaChldmVudC5pZCk7XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gZGlzY2FyZCBjb21tYW5kcyBiYXNlZCBvbiBjYWxscyB0byBGcmFtZXdvcmsubWFya1NlbnQoKVxuICAgICAgeWllbGQqIHNlbGYuI2Rpc2NhcmRSb3VuZFRyaXBwZWQoKTtcblxuICAgICAgcmV0dXJuIHVwZGF0ZXM7XG4gICAgfSlcbiAgICB0aGlzLiNncmFwaC5kaXJ0eSh1cGRhdGVzKTtcbiAgICB0aGlzLiNyb3VuZFRyaXBwZWQubWFwKChpZCkgPT4gdGhpcy4jdW5zZW50LmRlbGV0ZShpZCkpO1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZCA9IFtdO1xuXG4gICAgaWYgKHRoaXMuI2xpdmUpIHtcbiAgICAgIHlpZWxkKiB0aGlzLiNyZWJ1aWxkT3ZlcmxheSgpO1xuICAgIH1cbiAgfVxuXG4gICojcmVidWlsZE92ZXJsYXkoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcblxuICAgIC8vIGRpc2NhcmQgb2xkIG92ZXJsYXksIHN0YXJ0IGEgbmV3IG9uZVxuICAgIHRoaXMuI2dyYXBoLmRpcnR5KHRoaXMuI292ZXJsYXkua2V5cygpKTtcbiAgICB0aGlzLiNvdmVybGF5ID0gbmV3IE92ZXJsYXlTdG9yYWdlKHRoaXMuI3N0b3JhZ2UpO1xuXG4gICAgLy8gcmVidWlsZCBvdmVybGF5IHdpdGggY3VycmVudCBmb3JlY2FzdHNcbiAgICBjb25zdCBmb3JlY2FzdHMgPSBbLi4udGhpcy4jdW5zZW50LnZhbHVlcygpXS5mbGF0KCk7XG4gICAgaWYgKGZvcmVjYXN0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBbdXBkYXRlcywgX21hcmtlZFNlbnRdID0geWllbGQqIHdpdGhXVHhuKHRoaXMuI2Z4LCB0aGlzLiNvdmVybGF5LCBmdW5jdGlvbiooKXtcbiAgICAgICAgcmV0dXJuIHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGZvcmVjYXN0cykpO1xuICAgICAgfSk7XG4gICAgICBzZWxmLiNncmFwaC5kaXJ0eSh1cGRhdGVzKTtcbiAgICB9XG5cbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgLy8gdGhpcyB3aWxsIHJ1biBhbGwgcXVlcmllcywgZXZlbiBuZXcgb25lc1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5ydW4oKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gICojb25TZW5kQ29tbWFuZHMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAvLyBnZW5lcmF0ZSBhIHV1aWQgbm93IGZvciBlYWNoIGV2ZW50XG4gICAgY29uc3QgY29tbWFuZHM6IEV2ZW50PEM+W10gPSB0aGlzLiNzZW5kQ29tbWFuZHMubWFwKChjKSA9PiAoeyBpZDogZ2VuZXJhdGVVdWlkKCksIGRhdGE6IGMgfSkpO1xuICAgIHRoaXMuI3NlbmRDb21tYW5kcyA9IFtdO1xuXG4gICAgLy8gZW5jb2RlIG9uY2UgZm9yIGJvdGggc3RvcmFnZSBhbmQgc2VuZGluZyBvdmVyIHRoZSB3aXJlXG4gICAgY29uc3QgZW5jb2RlZDogRXZlbnQ8YW55PltdID0gY29tbWFuZHMubWFwKChjKSA9PiAoeyBpZDogYy5pZCwgZGF0YTogRW5jb2RlUHJvdG8oYy5kYXRhKSB9KSk7XG5cbiAgICAvLyBvcGVuIGEgd3JpdGUgdHhuIHRvIHJlYWwgc3RvcmFnZVxuICAgIHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICBjb25zdCBhZGRlZCA9IFtdO1xuICAgICAgLy8gd3JpdGUgZWFjaCBjb21tYW5kIHRvIHN0b3JhZ2VcbiAgICAgIGZvciAoY29uc3QgZWMgb2YgZW5jb2RlZCkge1xuICAgICAgICB5aWVsZCogdHhuU2V0KGAuY29tbWFuZC0ke2VjLmlkfWAsIGVjKTtcbiAgICAgICAgYWRkZWQucHVzaChlYy5pZCk7XG4gICAgICB9XG4gICAgICAvLyB1cGRhdGUgdGhlIGluZGV4XG4gICAgICBjb25zdCBpbmRleCA9ICh5aWVsZCogdHhuR2V0KFwiLmNvbW1hbmRzXCIpKSBhcyBzdHJpbmdbXSA/PyBbXTtcbiAgICAgIHlpZWxkKiB0eG5TZXQoXCIuY29tbWFuZHNcIiwgWy4uLmluZGV4LCAuLi5hZGRlZF0pO1xuICAgIH0pO1xuXG4gICAgLy8gc2NoZWR1bGUgYSBjYWxsYmFjayBmb3IgdGhlIHVzZXIgdG8ga25vdyBpdCBpcyB0aW1lIHRvIHNlbmQgdGhlc2UgY29tbWFuZHNcbiAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuI29uQ29tbWFuZHMhKGNvbW1hbmRzKSk7XG5cbiAgICAvLyBzdG9yZSB0aG9zZSBjb21tYW5kcyBhcyB1bnNlbnRcblxuICAgIC8vIG5vdyBmb3JlY2FzdCBldmVudHMgYmFzZWQgb24gdGhvc2UgY29tbWFuZHNcbiAgICBpZiAoIXRoaXMuI2ZvcmVjYXN0ZXIpIHtcbiAgICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIFtdKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBmb3JlY2FzdHM6IEVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgY29uc3QgYyA9IGNvcHlPbldyaXRlKGNvbW1hbmQuZGF0YSk7XG4gICAgICBjb25zdCBmcyA9IHJlY292ZXIodGhpcy4jZm9yZWNhc3RlcihjKSk7XG4gICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIGZzKTtcbiAgICAgIGZvcmVjYXN0cy5wdXNoKC4uLmZzKTtcbiAgICB9XG5cbiAgICBpZiAoZm9yZWNhc3RzLmxlbmd0aCA9PT0gMCB8fCAhdGhpcy4jbGl2ZSkgcmV0dXJuO1xuXG4gICAgLy8gb3BlbiBhIHdyaXRlIHR4biBhZ2FpbnN0IHRoZSBleGlzdGluZyBvdmVybGF5XG4gICAgY29uc3QgW3VwZGF0ZXMsIF9tYXJrZWRTZW50XSA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jb3ZlcmxheSwgZnVuY3Rpb24qKCl7XG4gICAgICByZXR1cm4geWllbGQqIHJ1blJlZHVjZXIoc2VsZi4jcmVkdWNlcihzZWxmLiNyeCwgZm9yZWNhc3RzKSk7XG4gICAgfSk7XG4gICAgdGhpcy4jZ3JhcGguZGlydHkodXBkYXRlcyk7XG5cbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgLy8gdGhpcyB3aWxsIHJ1biBhbGwgcXVlcmllcywgZXZlbiBuZXcgb25lc1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5ydW4oKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gIC8vIGRpc2NhcmQgdGhpcy4jcm91bmRUcmlwcGVkIHdpdGhpbiBzb21lIGV4dGVybmFsbHktcHJvdmlkZWQgV1R4blxuICAvLyAoeW91J2xsIGhhdmUgdG8gZXJhc2UgdGhpcy4jcm91bmRUcmlwcGVkIGFmdGVyIHRoZSB0eG4gY29tbWl0cylcbiAgLy8gcmV0dXJuIHRydWUgaWYgc29tZXRoaW5nIHdhcyBkZWxldGVkIChidXQgaXQgYWx3YXlzIHByb2Nlc3NlcyB0aGlzLiNyb3VuZFRyaXBwZWQpXG4gICojZGlzY2FyZFJvdW5kVHJpcHBlZCgpOiBXU3RvcmFnZUdlbmVyYXRvcjxib29sZWFuPiB7XG4gICAgaWYgKHRoaXMuI3JvdW5kVHJpcHBlZC5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCByb3VuZFRyaXBwZWQ6IFJlY29yZDxzdHJpbmcsIHRydWU+ID0ge307XG4gICAgZm9yIChjb25zdCBpZCBvZiB0aGlzLiNyb3VuZFRyaXBwZWQpIHtcbiAgICAgIHJvdW5kVHJpcHBlZFtpZF0gPSB0cnVlO1xuICAgIH1cbiAgICAvLyBsb2FkIHRoZSBpbmRleCBvZiBiYXRjaGVzIG9mIGNvbW1hbmRzXG4gICAgY29uc3QgaW5kZXggPSAoeWllbGQqIHR4bkdldChcIi5jb21tYW5kc1wiKSkgYXMgc3RyaW5nW10gPz8gW107XG4gICAgLy8gZGVjaWRlIHdoYXQgdG8gZGVsZXRlXG4gICAgY29uc3QgdG9EZWxldGUgPSBpbmRleC5maWx0ZXIoKGlkKSA9PiByb3VuZFRyaXBwZWRbaWRdKTtcbiAgICBpZiAodG9EZWxldGUubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBpZCBvZiB0b0RlbGV0ZSkge1xuICAgICAgeWllbGQgKnR4bkRlbChgLmNvbW1hbmQtJHtpZH1gKTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHRoZSBpbmRleFxuICAgIGNvbnN0IHRvS2VlcCA9IGluZGV4LmZpbHRlcigoaWQpID0+ICFyb3VuZFRyaXBwZWRbaWRdKTtcbiAgICB5aWVsZCogdHhuU2V0KFwiLmNvbW1hbmRzXCIsIHRvS2VlcCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAqI29uUm91bmRUcmlwcGVkKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgY29uc3QgY2hhbmdlZCA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICByZXR1cm4geWllbGQqIHNlbGYuI2Rpc2NhcmRSb3VuZFRyaXBwZWQoKTtcbiAgICB9KTtcbiAgICB0aGlzLiNyb3VuZFRyaXBwZWQubWFwKChpZCkgPT4gdGhpcy4jdW5zZW50LmRlbGV0ZShpZCkpO1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZCA9IFtdO1xuICAgIGlmIChjaGFuZ2VkICYmIHRoaXMuI2xpdmUpIHtcbiAgICAgIHlpZWxkKiB0aGlzLiNyZWJ1aWxkT3ZlcmxheSgpXG4gICAgfVxuICB9XG5cbiAgKiNvbk5ld1F1ZXJpZXMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5leHRlbmQoKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gICojb25SZWNvbm5lY3RzKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qge2NoZWNrcG9pbnQsIGNvbW1hbmRzfSA9IHlpZWxkKiB3aXRoUlR4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICBjb25zdCBjaGVja3BvaW50ID0gKHlpZWxkKiB0eG5HZXQoXCIuY2hlY2twb2ludFwiKSkgYXMgKG51bWJlciB8IHVuZGVmaW5lZCk7XG4gICAgICBjb25zdCBjb21tYW5kczogRXZlbnQ8YW55PltdID0gW107XG4gICAgICBjb25zdCBpbmRleCA9ICh5aWVsZCogdHhuR2V0KFwiLmNvbW1hbmRzXCIpKSBhcyBzdHJpbmdbXSA/PyBbXTtcbiAgICAgIGZvciAoY29uc3QgaWQgb2YgaW5kZXgpIHtcbiAgICAgICAgY29uc3QgY29tbWFuZCA9ICh5aWVsZCogdHhuR2V0KGAuY29tbWFuZC0ke2lkfWApKSBhcyBFdmVudDxhbnk+O1xuICAgICAgICBjb21tYW5kcy5wdXNoKGNvbW1hbmQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtjaGVja3BvaW50LCBjb21tYW5kc307XG4gICAgfSk7XG4gICAgZm9yIChjb25zdCByZXNvbHZlIG9mIHRoaXMuI3JlY29ubmVjdHMpIHtcbiAgICAgIHJlc29sdmUoeyBjaGVja3BvaW50LCBjb21tYW5kcyB9KTtcbiAgICB9XG4gICAgdGhpcy4jcmVjb25uZWN0cyA9IFtdO1xuICB9XG5cbiAgKiNvblNpbXVsYXRlcygpOiBHZW5lcmF0b3I8dm9pZCwgdm9pZCwgdm9pZD4ge1xuICAgIGNvbnN0IHNpbXVsYXRlcyA9IHRoaXMuI3NpbXVsYXRlcztcbiAgICB0aGlzLiNzaW11bGF0ZXMgPSBbXTtcbiAgICAvLyB1c2UgYSBzaW5nbGUgcmVhZCB0eG4gZm9yIGFsbCBzaW11bGF0aW9ucywgc2luY2UgcnVuUmVkdWNlcigpIHdpdGggc2ltdWxhdGU9dHJ1ZSBkb2Vzbid0IHdyaXRlXG4gICAgeWllbGQqIHdpdGhSVHhuKHRoaXMuI2Z4LCB0aGlzLiNzdG9yYWdlLCBmdW5jdGlvbiooKSB7XG4gICAgICBmb3IgKGNvbnN0IGZuIG9mIHNpbXVsYXRlcykge1xuICAgICAgICB5aWVsZCogcnVuUmVkdWNlcihmbigpLCB0cnVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUmVkdWNlclRlc3RlcjxSWCwgRSwgUz4ge1xuICAjcng6IFJYO1xuICAjcmVkdWNlcjogKHJ4OiBSWCwgZXZlbnRzOiBFW10pID0+IFJlZHVjZXI8dm9pZCB8IGFueVtdPjtcbiAgI3N0b3JhZ2U6IEluTWVtU3RvcmFnZTtcbiAgZGF0YTogUztcblxuICBjb25zdHJ1Y3RvcihcbiAgICByeDogUlgsXG4gICAgbWlncmF0ZTogbnVsbCB8ICgocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+KSxcbiAgICByZWR1Y2VyOiAocng6IFJYLCBldmVudHM6IEVbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgIHN0b3JhZ2U6IEluTWVtU3RvcmFnZSxcbiAgICB0ZXN0RGF0YTogUyxcbiAgKSB7XG4gICAgdGhpcy4jcnggPSByeDtcbiAgICB0aGlzLiNyZWR1Y2VyID0gcmVkdWNlcjtcbiAgICB0aGlzLiNzdG9yYWdlID0gc3RvcmFnZTtcbiAgICB0aGlzLmRhdGEgPSB0ZXN0RGF0YTtcblxuICAgIGlmIChtaWdyYXRlKSB7XG4gICAgICB0aGlzLiNydW4obWlncmF0ZShyeCkpO1xuICAgIH1cbiAgfVxuXG4gICNydW4oZzogUmVkdWNlcjx2b2lkIHwgYW55W10+KTogW3N0cmluZ1tdLCBhbnlbXV0ge1xuICAgIC8vIGRvIHRoZSBcIkZ1dHVyZUNvbnRleHRcIiBkYW5jZS5cbiAgICBsZXQgZng6IEZ1dHVyZUNvbnRleHQ7XG4gICAgbGV0IHJlc3VsdDogW3N0cmluZ1tdLCBhbnlbXV0gfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgY29uc3QgY29ybyA9IGZ1bmN0aW9uKigpIHtcbiAgICAgIHJlc3VsdCA9IHlpZWxkKiB3aXRoV1R4bihmeCEsIHNlbGYuI3N0b3JhZ2UsIGZ1bmN0aW9uKigpIHtcbiAgICAgICAgcmV0dXJuIHlpZWxkKiBydW5SZWR1Y2VyKGcsIGZhbHNlKTtcbiAgICAgIH0pO1xuICAgIH0oKTtcbiAgICBmeCA9IG5ldyBGdXR1cmVDb250ZXh0KGNvcm8pO1xuXG4gICAgLy8gd2l0aCBJbk1lbVN0b3JhZ2UsIHRoaXMgc2hvdWxkIGFsd2F5cyBiZSBjb21wbGV0ZWQgaW4gYSBzaW5nbGUgc2hvdFxuICAgIGZ4Lndha2V1cCgpO1xuICAgIGlmICghcmVzdWx0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHBlY3RlZCB0ZXN0IGNvcm91dGluZSB0byBjb21wbGV0ZSBpbiBvbmUgc2hvdFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIHJ1biBldmVudHMgYWdhaW5zdCBwcm92aWRlZCByZWR1Y2VyXG4gIHJ1bihldmVudHM6IEVbXSk6IHt1cGRhdGVzOiBzdHJpbmdbXSwgbWFya2VkU2VudDogYW55W119IHtcbiAgICBjb25zdCBnID0gdGhpcy4jcmVkdWNlcih0aGlzLiNyeCwgZXZlbnRzKTtcbiAgICBjb25zdCBbIHVwZGF0ZXMsIG1hcmtlZFNlbnQgXSA9IHRoaXMuI3J1bihnKTtcbiAgICB1cGRhdGVzLnNvcnQoKTtcbiAgICByZXR1cm4geyB1cGRhdGVzLCBtYXJrZWRTZW50IH07XG4gIH1cbn1cblxuLy8gZW5kIG9mIHNrZWxldG9uIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG5leHBvcnQgdHlwZSBMaXN0ID0ge2lkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgaXRlbXM6IHN0cmluZ1tdLCBhcmNoaXZlZDogYm9vbGVhbn07XG5cbmV4cG9ydCB0eXBlIEl0ZW0gPSB7aWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBkb25lOiBib29sZWFuLCBhcmNoaXZlZDogYm9vbGVhbn07XG5cbmV4cG9ydCB0eXBlIE5ld0xpc3QgPSB7dHlwZTogXCJuZXctbGlzdFwiLCBpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmd9O1xuXG5leHBvcnQgdHlwZSBSZW5hbWVMaXN0ID0ge3R5cGU6IFwicmVuYW1lLWxpc3RcIiwgaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nfTtcblxuZXhwb3J0IHR5cGUgQXJjaGl2ZUxpc3QgPSB7dHlwZTogXCJhcmNoaXZlLWxpc3RcIiwgaWQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIE5ld0l0ZW0gPSB7dHlwZTogXCJuZXctaXRlbVwiLCBpZDogc3RyaW5nLCBsaXN0OiBzdHJpbmcsIHRleHQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIEVkaXRJdGVtID0ge3R5cGU6IFwiZWRpdC1pdGVtXCIsIGlkOiBzdHJpbmcsIHRleHQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIE1hcmtJdGVtID0ge3R5cGU6IFwibWFyay1pdGVtXCIsIGlkOiBzdHJpbmcsIGRvbmU6IGJvb2xlYW59O1xuXG5leHBvcnQgdHlwZSBBcmNoaXZlSXRlbSA9IHt0eXBlOiBcImFyY2hpdmUtaXRlbVwiLCBpZDogc3RyaW5nfTtcblxuZXhwb3J0IHR5cGUgVG9kb0V2ZW50cyA9IE5ld0xpc3QgfCBSZW5hbWVMaXN0IHwgQXJjaGl2ZUxpc3QgfCBOZXdJdGVtIHwgRWRpdEl0ZW0gfCBNYXJrSXRlbSB8IEFyY2hpdmVJdGVtO1xuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlTGlzdCh2YWw6IGFueSk6IExpc3Qge1xuICByZXR1cm4gdmFsIGFzIExpc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVJdGVtKHZhbDogYW55KTogSXRlbSB7XG4gIHJldHVybiB2YWwgYXMgSXRlbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZU5ld0xpc3QodmFsOiBhbnkpOiBOZXdMaXN0IHtcbiAgcmV0dXJuIHZhbCBhcyBOZXdMaXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlUmVuYW1lTGlzdCh2YWw6IGFueSk6IFJlbmFtZUxpc3Qge1xuICByZXR1cm4gdmFsIGFzIFJlbmFtZUxpc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVBcmNoaXZlTGlzdCh2YWw6IGFueSk6IEFyY2hpdmVMaXN0IHtcbiAgcmV0dXJuIHZhbCBhcyBBcmNoaXZlTGlzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZU5ld0l0ZW0odmFsOiBhbnkpOiBOZXdJdGVtIHtcbiAgcmV0dXJuIHZhbCBhcyBOZXdJdGVtO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlRWRpdEl0ZW0odmFsOiBhbnkpOiBFZGl0SXRlbSB7XG4gIHJldHVybiB2YWwgYXMgRWRpdEl0ZW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVNYXJrSXRlbSh2YWw6IGFueSk6IE1hcmtJdGVtIHtcbiAgcmV0dXJuIHZhbCBhcyBNYXJrSXRlbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZUFyY2hpdmVJdGVtKHZhbDogYW55KTogQXJjaGl2ZUl0ZW0ge1xuICByZXR1cm4gdmFsIGFzIEFyY2hpdmVJdGVtO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlVG9kb0V2ZW50cyh2YWw6IGFueSk6IFRvZG9FdmVudHMge1xuICByZXR1cm4gdmFsIGFzIFRvZG9FdmVudHM7XG59XG5cbmZ1bmN0aW9uICpxdWVyeUdldDxUPihrZXk6IHN0cmluZyk6IFF1ZXJ5R2VuZXJhdG9yPFQ+IHtcbiAgY29uc3QgYW5zID0geWllbGQgeydzdG9yZSc6IHtba2V5XTogdHJ1ZX19O1xuICBjb25zdCBzdiA9IGFucy5zdG9yZVtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIHJlYWRPbmx5KHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyT2xkPFQ+KGtleTogc3RyaW5nKTogUmVkdWNlcjxUPiB7XG4gIGNvbnN0IGFucyA9IHlpZWxkIHsnb2xkJzoge1trZXldOiB0cnVlfX07XG4gIGNvbnN0IHN2ID0gYW5zLm9sZFtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIGNvcHlPbldyaXRlKHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyR2V0PFQ+KGtleTogc3RyaW5nKTogUmVkdWNlcjxUPiB7XG4gIGNvbnN0IGFucyA9IHlpZWxkIHsnZ2V0Jzoge1trZXldOiB0cnVlfX07XG4gIGNvbnN0IHN2ID0gYW5zLmdldFtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIGNvcHlPbldyaXRlKHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyU2V0PFQ+KGtleTogc3RyaW5nLCB2YWx1ZTogVCk6IFJlZHVjZXI8dm9pZD4ge1xuICBjb25zdCBhbnMgPSB5aWVsZCB7J3NldCc6IHtba2V5XTogdmFsdWV9fTtcbiAgY29uc3Qgc3YgPSBhbnMuc2V0W2tleV07XG4gIGlmICgnZXJyJyBpbiBzdikgdGhyb3cgc3YuZXJyO1xufVxuZnVuY3Rpb24gKnJlZHVjZXJEZWwoa2V5OiBzdHJpbmcpOiBSZWR1Y2VyPHZvaWQ+IHtcbiAgY29uc3QgYW5zID0geWllbGQgeydkZWwnOiB7W2tleV06IHRydWV9fTtcbiAgY29uc3Qgc3YgPSBhbnMuZGVsW2tleV07XG4gIGlmICgnZXJyJyBpbiBzdikgdGhyb3cgc3YuZXJyO1xufVxuZnVuY3Rpb24gKnJlZHVjZXJVcGRhdGU8VCwgUj4oa2V5OiBzdHJpbmcsIGZuOiAodDogVCkgPT4gUik6IFJlZHVjZXI8Uj4ge1xuICBjb25zdCBvYmogPSB5aWVsZCogcmVkdWNlckdldDxUPihrZXkpO1xuICBjb25zdCBvdXQgPSBmbihvYmopO1xuICB5aWVsZCogcmVkdWNlclNldChrZXksIG9iaik7XG4gIHJldHVybiBvdXQ7XG59XG5leHBvcnQgdHlwZSBOb1NldDxUIGV4dGVuZHMge1xuICBcImdldFwiOiB1bmtub3duLCBcIm9sZFwiOiB1bmtub3duLCBcImRlbFwiOiB1bmtub3duLCBcInVwZGF0ZVwiOiB1bmtub3duXG59PiA9IFBpY2s8VCwgXCJnZXRcInxcIm9sZFwifFwiZGVsXCJ8XCJ1cGRhdGVcIj47XG5cbmV4cG9ydCBjb25zdCBUb2RvUXVlcnlDb250ZXh0ID0ge1xuICBnZXQ6IHtcbiAgICBhbGxfbGlzdHM6ICgpID0+IHF1ZXJ5R2V0PHN0cmluZ1tdPihgYWxsX2xpc3RzYCksXG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcXVlcnlHZXQ8SXRlbT4oYGl0ZW0uJHtpdGVtX2lkfWApLFxuICAgIGxpc3Q6IChsaXN0X2lkOiBzdHJpbmcpID0+IHF1ZXJ5R2V0PExpc3Q+KGBsaXN0LiR7bGlzdF9pZH1gKSxcbiAgfSxcbn07XG5cblxuZXhwb3J0IHR5cGUgVG9kb1FYID0gdHlwZW9mIFRvZG9RdWVyeUNvbnRleHQ7XG5leHBvcnQgY29uc3QgVG9kb1JlZHVjZXJDb250ZXh0ID0ge1xuICBvbGQ6IHtcbiAgICBhbGxfbGlzdHM6ICgpID0+IHJlZHVjZXJPbGQ8c3RyaW5nW10+KGBhbGxfbGlzdHNgKSxcbiAgICBpdGVtOiAoaXRlbV9pZDogc3RyaW5nKSA9PiByZWR1Y2VyT2xkPEl0ZW0+KGBpdGVtLiR7aXRlbV9pZH1gKSxcbiAgICBsaXN0OiAobGlzdF9pZDogc3RyaW5nKSA9PiByZWR1Y2VyT2xkPExpc3Q+KGBsaXN0LiR7bGlzdF9pZH1gKSxcbiAgfSxcbiAgZ2V0OiB7XG4gICAgYWxsX2xpc3RzOiAoKSA9PiByZWR1Y2VyR2V0PHN0cmluZ1tdPihgYWxsX2xpc3RzYCksXG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcmVkdWNlckdldDxJdGVtPihgaXRlbS4ke2l0ZW1faWR9YCksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZykgPT4gcmVkdWNlckdldDxMaXN0PihgbGlzdC4ke2xpc3RfaWR9YCksXG4gIH0sXG4gIHNldDoge1xuICAgIGFsbF9saXN0czogKHZhbHVlOiBzdHJpbmdbXSkgPT4gcmVkdWNlclNldChgYWxsX2xpc3RzYCwgdmFsdWUpLFxuICAgIGl0ZW06IChpdGVtX2lkOiBzdHJpbmcsIHZhbHVlOiBJdGVtKSA9PiByZWR1Y2VyU2V0KGBpdGVtLiR7aXRlbV9pZH1gLCB2YWx1ZSksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZywgdmFsdWU6IExpc3QpID0+IHJlZHVjZXJTZXQoYGxpc3QuJHtsaXN0X2lkfWAsIHZhbHVlKSxcbiAgfSxcbiAgZGVsOiB7XG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcmVkdWNlckRlbChgaXRlbS4ke2l0ZW1faWR9YCksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZykgPT4gcmVkdWNlckRlbChgbGlzdC4ke2xpc3RfaWR9YCksXG4gIH0sXG4gIHVwZGF0ZToge1xuICAgIGFsbF9saXN0czogPFI+KGZuOiAodmFsdWU6IHN0cmluZ1tdKSA9PiBSKSA9PiByZWR1Y2VyVXBkYXRlKGBhbGxfbGlzdHNgLCBmbiksXG4gICAgaXRlbTogPFI+KGl0ZW1faWQ6IHN0cmluZywgZm46ICh2YWx1ZTogSXRlbSkgPT4gUikgPT4gcmVkdWNlclVwZGF0ZShgaXRlbS4ke2l0ZW1faWR9YCwgZm4pLFxuICAgIGxpc3Q6IDxSPihsaXN0X2lkOiBzdHJpbmcsIGZuOiAodmFsdWU6IExpc3QpID0+IFIpID0+IHJlZHVjZXJVcGRhdGUoYGxpc3QuJHtsaXN0X2lkfWAsIGZuKSxcbiAgfSxcbn07XG5cbmV4cG9ydCB0eXBlIFRvZG9SWCA9IHR5cGVvZiBUb2RvUmVkdWNlckNvbnRleHQ7XG5cbmV4cG9ydCBjbGFzcyBUb2RvRnJhbWV3b3JrIGV4dGVuZHMgRnJhbWV3b3JrPFRvZG9RWCwgVG9kb1JYLCBUb2RvRXZlbnRzLCBUb2RvRXZlbnRzPiB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHN0b3JhZ2U6IFN0b3JhZ2UsXG4gICAgY2FsbGJhY2tzOiB7XG4gICAgICAvLyBvcHRpb25hbDogY29uZmlndXJlIHN0b3JhZ2UgYmVmb3JlIGFueSBldmVudHMgYXJyaXZlXG4gICAgICBtaWdyYXRlPzogKHJ4OiBUb2RvUlgpID0+IFJlZHVjZXI8dm9pZD4sXG4gICAgICAvLyByZXF1aXJlZDogcmVkdWNlIGEgYmF0Y2ggb2YgZXZlbnRzIGludG8gdGhlIHJlYWQgbW9kZWxcbiAgICAgIHJlZHVjZXI6IChyeDogVG9kb1JYLCBldmVudHM6IFRvZG9FdmVudHNbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgICAgLy8gb3B0aW9uYWw6IGZvcmVjYXN0IHRoZSBldmVudHMgYSBzZXJ2ZXIgd2lsbCBzZW5kIGZvciBhIGNvbW1hbmRcbiAgICAgIGZvcmVjYXN0ZXI/OiAoY29tbWFuZHM6IFRvZG9FdmVudHMpID0+IFRvZG9FdmVudHNbXSxcbiAgICAgIC8vIHJlcXVpcmVkIGlmIHVzaW5nIHNlbmRDb21tYW5kczogcmVjZWl2ZSBldmVudHMgdG8gc2VuZCBvbiB0aGUgd2lyZVxuICAgICAgb25Db21tYW5kcz86IChjb21tYW5kczogRXZlbnQ8YW55PltdKT0+IHZvaWQsXG4gICAgfSxcbiAgICAvLyB1c2VkIGluIGNyb3NzLWxhbmd1YWdlIHN1cHBvcnQ6IGluamVjdCBhbiBhcmJpdHJhcnkgb2JqZWN0IGFzIHRoZSBRdWVyeUNvbnRleHRcbiAgICBxeD86IGFueSxcbiAgKSB7XG4gICAgc3VwZXIocXggPz8gVG9kb1F1ZXJ5Q29udGV4dCwgVG9kb1JlZHVjZXJDb250ZXh0LCBzdG9yYWdlLCB7XG4gICAgICAgIC4uLmNhbGxiYWNrcyxcbiAgICAgICAgZGVjb2RlRXZlbnQ6IERlY29kZVRvZG9FdmVudHMsXG4gICAgICAgIGRlY29kZUNvbW1hbmQ6IERlY29kZVRvZG9FdmVudHMsXG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFRvZG9UZXN0RGF0YSB7XG4gIGRhdGE6IFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgY29uc3RydWN0b3IoZGF0YTogUmVjb3JkPHN0cmluZywgYW55Pil7XG4gICAgdGhpcy5kYXRhID0gZGF0YTtcbiAgfVxuXG4gIGFsbF9saXN0cygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHRoaXMuZGF0YVtgYWxsX2xpc3RzYF0gYXMgc3RyaW5nW11cbiAgfVxuXG4gIGl0ZW0oaXRlbV9pZDogc3RyaW5nKTogSXRlbSB7XG4gICAgcmV0dXJuIHRoaXMuZGF0YVtgaXRlbS4ke2l0ZW1faWR9YF0gYXMgSXRlbVxuICB9XG5cbiAgbGlzdChsaXN0X2lkOiBzdHJpbmcpOiBMaXN0IHtcbiAgICByZXR1cm4gdGhpcy5kYXRhW2BsaXN0LiR7bGlzdF9pZH1gXSBhcyBMaXN0XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFRvZG9SZWR1Y2VyVGVzdGVyIGV4dGVuZHMgUmVkdWNlclRlc3RlcjxUb2RvUlgsIFRvZG9FdmVudHMsIFRvZG9UZXN0RGF0YT4ge1xuICBjb25zdHJ1Y3RvcihcbiAgICBtaWdyYXRlT3JJbml0aWFsRGF0YTogKChyeDogVG9kb1JYKSA9PiBSZWR1Y2VyPHZvaWQ+KSB8IFJlY29yZDxzdHJpbmcsIGFueT4sXG4gICAgcmVkdWNlcjogKHJ4OiBUb2RvUlgsIGV2ZW50czogVG9kb0V2ZW50c1tdKSA9PiBSZWR1Y2VyPHZvaWQgfCBhbnlbXT4sXG4gICkge1xuICAgIGxldCBtaWdyYXRlOiBudWxsIHwgKChyeDogVG9kb1JYKSA9PiBSZWR1Y2VyPHZvaWQ+KTtcbiAgICBsZXQgZGF0YTogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICBpZiAobWlncmF0ZU9ySW5pdGlhbERhdGEgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICBtaWdyYXRlID0gbWlncmF0ZU9ySW5pdGlhbERhdGE7XG4gICAgICAgIGRhdGEgPSB7fTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBtaWdyYXRlID0gbnVsbDtcbiAgICAgICAgZGF0YSA9IG1pZ3JhdGVPckluaXRpYWxEYXRhO1xuICAgIH1cbiAgICBzdXBlcihUb2RvUmVkdWNlckNvbnRleHQsIG1pZ3JhdGUsIHJlZHVjZXIsIG5ldyBJbk1lbVN0b3JhZ2UoZGF0YSksIG5ldyBUb2RvVGVzdERhdGEoZGF0YSkpO1xuICB9XG59XG5cbiIsImltcG9ydCB7XG4gIFJlZHVjZXIsXG4gIFRvZG9FdmVudHMsXG4gIFRvZG9SWCxcbn0gZnJvbSAnLi9tb2RlbC5nZW4nO1xuXG5cbmV4cG9ydCBmdW5jdGlvbiAqbWlncmF0ZVRvZG9zKHJ4OiBUb2RvUlgpOiBSZWR1Y2VyPHZvaWQ+IHtcbiAgLy8ganVzdCBzZXQgXCJhbGxfbGlzdHNcIiBrZXkgdG8gYW4gZW1wdHkgbGlzdCBpZiBpdCBkb2Vzbid0IGV4aXN0IHlldFxuICB5aWVsZCogcnguc2V0LmFsbF9saXN0cyhcbiAgICAoeWllbGQqIHJ4LmdldC5hbGxfbGlzdHMoKSkgPz8gW11cbiAgKTtcbn1cblxuXG5leHBvcnQgZnVuY3Rpb24gKnJlZHVjZVRvZG9zKHJ4OiBUb2RvUlgsIGV2ZW50czogVG9kb0V2ZW50c1tdKTogUmVkdWNlcjx2b2lkPiB7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpIHtcbiAgICBzd2l0Y2ggKGUudHlwZSkge1xuICAgICAgY2FzZSBcIm5ldy1saXN0XCI6XG4gICAgICAgIHlpZWxkKiByeC51cGRhdGUuYWxsX2xpc3RzKChhbGxfbGlzdHMpID0+IGFsbF9saXN0cy5wdXNoKGUuaWQpKTtcbiAgICAgICAgeWllbGQqIHJ4LnNldC5saXN0KGUuaWQsIHsgaWQ6IGUuaWQsIG5hbWU6IGUubmFtZSwgaXRlbXM6IFtdLCBhcmNoaXZlZDogZmFsc2UgfSk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwicmVuYW1lLWxpc3RcIjpcbiAgICAgICAgeWllbGQqIHJ4LnVwZGF0ZS5saXN0KGUuaWQsIChsaXN0KSA9PiBsaXN0Lm5hbWUgPSBlLm5hbWUpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcImFyY2hpdmUtbGlzdFwiOlxuICAgICAgICB5aWVsZCogcngudXBkYXRlLmxpc3QoZS5pZCwgKGxpc3QpID0+IGxpc3QuYXJjaGl2ZWQgPSB0cnVlKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJuZXctaXRlbVwiOlxuICAgICAgICB5aWVsZCogcnguc2V0Lml0ZW0oZS5pZCwgeyBpZDogZS5pZCwgdGV4dDogZS50ZXh0LCBkb25lOiBmYWxzZSwgYXJjaGl2ZWQ6IGZhbHNlIH0pO1xuICAgICAgICB5aWVsZCogcngudXBkYXRlLmxpc3QoZS5saXN0LCAobGlzdCkgPT4gbGlzdC5pdGVtcy5wdXNoKGUuaWQpKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJlZGl0LWl0ZW1cIjpcbiAgICAgICAgeWllbGQqIHJ4LnVwZGF0ZS5pdGVtKGUuaWQsIChpdGVtKSA9PiBpdGVtLnRleHQgPSBlLnRleHQpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIm1hcmstaXRlbVwiOlxuICAgICAgICB5aWVsZCogcngudXBkYXRlLml0ZW0oZS5pZCwgKGl0ZW0pID0+IGl0ZW0uZG9uZSA9IGUuZG9uZSk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiYXJjaGl2ZS1pdGVtXCI6XG4gICAgICAgIHlpZWxkKiByeC51cGRhdGUuaXRlbShlLmlkLCAoaXRlbSkgPT4gaXRlbS5hcmNoaXZlZCA9IHRydWUpO1xuICAgICAgICBicmVhaztcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgY29uc3QgX3R5cGVjaGVjazogbmV2ZXIgPSBlO1xuICAgICAgICByZXR1cm4gX3R5cGVjaGVjaztcbiAgICB9XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQUVBO0FBQ0E7U0FVZ0IsVUFBVSxDQUFJLEdBQXNCLEVBQUUsR0FBVyxFQUFFLE1BQVMsRUFBQTtBQUMxRSxJQUFBLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBRTtBQUNkLFFBQUEsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDO0lBQ2pCO1NBQU87QUFDTCxRQUFBLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxNQUFNO0FBQ2pCLFFBQUEsT0FBTyxNQUFNO0lBQ2Y7QUFDRjtBQUVBLE1BQU0sTUFBTSxHQUFHLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxDQUFDO0FBRS9GO0FBQ0EsSUFBSSxDQUFFLFVBQWtCLENBQUMsWUFBWSxFQUFFO0FBQ3JDLElBQUEsSUFBSSxZQUFZLEdBQUcsWUFBQTtRQUNqQixJQUFJLEdBQUcsR0FBRyxFQUFFOztBQUdaLFFBQUEsTUFBTSxNQUFNLEdBQUcsSUFBSSxVQUFVLENBQUMsRUFBRSxDQUFDO0FBQ2pDLFFBQUEsTUFBTSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUM7O0FBRzlCLFFBQUEsTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDO0FBQ3JDLFFBQUEsTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDO0FBRXJDLFFBQUEsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSTtBQUNuQixZQUFBLEdB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Q0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDM0QsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxTQUFTLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDbkUsUUFBQSxRQUFRLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDMUUsUUFBQSxhQUFhLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDcEYsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDL0QsUUFBQSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDL0QsUUFBQSxHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDdkQsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxXQUFXLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDdkUsUUFBQSxLQUFLLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDM0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxVQUFVLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDOUUsUUFBQSxRQUFRLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDMUUsUUFBQSxTQUFTLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDNUUsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7UUFDbEUsQ0FBQyxNQUFNLENBQUMsUUFBUSxHQUFHLENBQUMsR0FBRyxJ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QzdELFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQy9ELFFBQUEsS0FBSyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzNELFFBQUEsTUFBTSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzdELFFBQUEsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3pELFFBQUEsU0FBUyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ25FLFFBQUEsUUFBUSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzFFLFFBQUEsYUFBYSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLGFBQWEsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3BGLFFBQUEsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3pELFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQy9ELFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQy9ELFFBQUEsR0FBRyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3ZELFFBQUEsTUFBTSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzdELFFBQUEsV0FBVyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3ZFLFFBQUEsS0FBSyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzNELFFBQUEsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQ3pELFFBQUEsVUFBVSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzlFLFFBQUEsUUFBUSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzFFLFFBQUEsU0FBUyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzVFLFFBQUEsTUFBTSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQzdELFFBQUEsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO1FBQ2xFLENBQUMsTUFBTSxDQUFDLFFBQVEsR0FBRyxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQzs7UUFHbEYsR0FBRyxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDakUsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDekUsVUFBVSxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDL0UsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDbkUsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDbkUsTUFBTSxFQUFFLENBQUMsR0FBRyxJQUFTLE1BQU0sSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFD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
