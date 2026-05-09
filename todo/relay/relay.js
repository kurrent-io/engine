'use strict';

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

exports.DecodeTodoEvents = DecodeTodoEvents;
exports.TodoFramework = TodoFramework;
exports.migrateTodos = migrateTodos;
exports.reduceTodos = reduceTodos;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVsYXkuanMiLCJzb3VyY2VzIjpbIi4uL21vZGVsL21vZGVsLmdlbi50cyIsIi4uL21vZGVsL3JlZHVjZXJzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIHV0aWxzIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuLy8ganNvbl90eXBlb2YgcmV0dXJucyB0aGUganNvbiB0eXBlIG9mIGEgdmFsdWUgdGhhdCBjYW1lIG91dCBvZiBwYXJzaW5nIGpzb25cbi8vIChzbyAndW5kZWZpbmVkJyBpcyBub3QgaGFuZGxlZCwgc2luY2UgaXQgaXNuJ3QgYWxsb3dlZCBpbiBqc29uKVxuZXhwb3J0IGZ1bmN0aW9uIGpzb25fdHlwZW9mKHZhbDogYW55KTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHR5cGVvZih2YWwpO1xuICBpZiAodCA9PT0gXCJvYmplY3RcIikge1xuICAgIGlmICh2YWwgPT09IG51bGwpIHJldHVybiBcIm51bGxcIjtcbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWwpKSByZXR1cm4gXCJhcnJheVwiO1xuICB9XG4gIHJldHVybiB0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0ZGVmYXVsdDxUPihvYmo6IFJlY29yZDxzdHJpbmcsIFQ+LCBrZXk6IHN0cmluZywgZGZhdWx0OiBUKTogVCB7XG4gIGlmIChrZXkgaW4gb2JqKSB7XG4gICAgcmV0dXJuIG9ialtrZXldO1xuICB9IGVsc2Uge1xuICAgIG9ialtrZXldID0gZGZhdWx0O1xuICAgIHJldHVybiBkZmF1bHQ7XG4gIH1cbn1cblxuY29uc3QgTklCQkxFID0gWycwJywgJzEnLCAnMicsICczJywgJzQnLCAnNScsICc2JywgJzcnLCAnOCcsICc5JywgJ2EnLCAnYicsICdjJywgJ2QnLCAnZScsICdmJ107XG5cbi8vIGdlbmVyYXRlVXVpZCBpcyBlaXRoZXIgaW5qZWN0ZWQgaW50byB0aGUgZW52aXJvbm1lbnQgb3Igd2UgZXhwZWN0IHRvIHVzZSBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKClcbmlmICghKGdsb2JhbFRoaXMgYXMgYW55KS5nZW5lcmF0ZVV1aWQpIHtcbiAgdmFyIGdlbmVyYXRlVXVpZCA9IGZ1bmN0aW9uKCk6IHN0cmluZyB7XG4gICAgbGV0IG91dCA9ICcnO1xuXG4gICAgLy8gR2V0IDEyOCBiaXRzIG9mIHJhbmRvbW5lc3MuXG4gICAgY29uc3QgdmFsdWVzID0gbmV3IFVpbnQ4QXJyYXkoMTYpO1xuICAgIGNyeXB0by5nZXRSYW5kb21WYWx1ZXModmFsdWVzKTtcblxuICAgIC8vIHJmYzQxMjIgY29tcGxpYW5jZTogdHlwZSA0IHV1aWRcbiAgICB2YWx1ZXNbNl0gPSAweDQwIHwgKHZhbHVlc1s2XSAmIDB4MGYpO1xuICAgIHZhbHVlc1s4XSA9IDB4ODAgfCAodmFsdWVzWzhdICYgMHgzZik7XG5cbiAgICB2YWx1ZXMuZm9yRWFjaCgoeCkgPT4ge1xuICAgICAgb3V0ICs9IE5JQkJMRVt4ID4+PiA0XSArIE5JQkJMRVt4ICYgMHgwZl07XG4gICAgfSk7XG5cbiAgICByZXR1cm4gW1xuICAgICAgb3V0LnN1YnN0cmluZygwLCA4KSxcbiAgICAgIG91dC5zdWJzdHJpbmcoOCwgMTIpLFxuICAgICAgb3V0LnN1YnN0cmluZygxMiwgMTYpLFxuICAgICAgb3V0LnN1YnN0cmluZygxNiwgMjApLFxuICAgICAgb3V0LnN1YnN0cmluZygyMCwgMzIpLFxuICAgIF0uam9pbignLScpO1xuICB9XG59XG5cbi8vIHByb3RvSlNPTlJlcGxhY2VyIGlzIGEgSlNPTi5zdHJpbmdpZnkoKSByZXBsYWNlcjsgaXQgaXMgbW9yZSBlZmZpY2llbnQgdGhhbiBFbmNvZGVQcm90byBiZWNhdXNlXG4vLyBKU09OLnN0cmluZ2lmeSgpIGRvZXNuJ3QgaGF2ZSB0byByZWNyZWF0ZSB0aGUgd2hvbGUgdHJlZSBvZiBhbiBvYmplY3QgbGlrZSBFbmNvZGVQcm90byBkb2VzLlxuLy8gQnV0IEVuY29kZVByb3RvIGlzIG1vcmUgbGlrZSBhbiBpbnZlcnNlIG9wZXJhdGlvbiBvZiB0aGUgRGVjb2RlKiBmYW1pbHkgb2YgZnVuY3Rpb25zLlxuZXhwb3J0IGZ1bmN0aW9uIHByb3RvSlNPTlJlcGxhY2VyKF9rOiBzdHJpbmcsIHY6IGFueSk6IGFueSB7XG4gIGlmICh2IGluc3RhbmNlb2YgTWFwKSByZXR1cm4gWy4uLnYuZW50cmllcygpXTtcbiAgaWYgKHYgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBbLi4udi5rZXlzKCldO1xuICAvLyBhbGwgb3RoZXIgdHlwZXMgbmF0dXJhbGx5IHN0cmluZ2lmeSBjb3JyZWN0bHksIGUuZy4gRGF0ZVxuICByZXR1cm4gdjtcbn1cblxuLy8gcHJvdG9TdHJpbmdpZnkgaXMgbGlrZSBKU09OLnN0cmluZ2lmeSgpLCBidXQgaXQgaGFuZGxlcyBNYXAgYW5kIFNldFxuZXhwb3J0IGZ1bmN0aW9uIHByb3RvU3RyaW5naWZ5KG9iajogYW55KTogYW55IHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG9iaiwgcHJvdG9KU09OUmVwbGFjZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRW5jb2RlUHJvdG8oYmFzZTogYW55KTogYW55IHtcbiAgc3dpdGNoICh0eXBlb2YgYmFzZSkge1xuICAgIGNhc2UgXCJib29sZWFuXCI6XG4gICAgY2FzZSBcImJpZ2ludFwiOlxuICAgIGNhc2UgXCJudW1iZXJcIjpcbiAgICBjYXNlIFwic3RyaW5nXCI6XG4gICAgY2FzZSBcInVuZGVmaW5lZFwiOlxuICAgICAgLy8gdGhlc2UgdHlwZXMgYXJlIGFscmVhZHkgaW1tdXRhYmxlXG4gICAgICByZXR1cm4gYmFzZTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBFbmNvZGVQcm90b2ApO1xuICB9XG5cbiAgLy8gY2hlY2sgaWYgb2JqZWN0IGhhcyB0b0pTT04oKVxuICBpZiAoYmFzZS50b0pTT04pIHJldHVybiBiYXNlLnRvSlNPTigpO1xuXG4gIGlmIChBcnJheS5pc0FycmF5KGJhc2UpKSByZXR1cm4gYmFzZS5tYXAoRW5jb2RlUHJvdG8pO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIE1hcCkgcmV0dXJuIFsuLi5iYXNlLmVudHJpZXMoKV0ubWFwKEVuY29kZVByb3RvKTtcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBbLi4uYmFzZS5rZXlzKCldOyAgLy8gb2JqZWN0IGtleXMgbm90IHN1cHBvcnRlZFxuICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGJhc2UpLm1hcCgoW2ssIHZdKSA9PiBbaywgRW5jb2RlUHJvdG8odildKSk7XG59XG5cbmNvbnN0IGNvcHlTeW0gPSBTeW1ib2woKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZXBDb3B5PFQ+KGJhc2U6IFQpOiBUIHtcbiAgc3dpdGNoICh0eXBlb2YgYmFzZSkge1xuICAgIGNhc2UgXCJib29sZWFuXCI6XG4gICAgY2FzZSBcImJpZ2ludFwiOlxuICAgIGNhc2UgXCJudW1iZXJcIjpcbiAgICBjYXNlIFwic3RyaW5nXCI6XG4gICAgY2FzZSBcInVuZGVmaW5lZFwiOlxuICAgICAgLy8gdGhlc2UgdHlwZXMgYXJlIGFscmVhZHkgaW1tdXRhYmxlXG4gICAgICByZXR1cm4gYmFzZTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBkZWVwQ29weWApO1xuICB9XG5cbiAgLy8gaGFuZGxlIHJlYWQtb25seSBhbmQgcHJveHkgb2JqZWN0cyBpbiBhbiBlZmZpY2llbnQgd2F5XG4gIGNvbnN0IGNvcGllciA9IChiYXNlIGFzIGFueSlbY29weVN5bV07XG4gIGlmIChjb3BpZXIpIHJldHVybiBjb3BpZXIoKTtcblxuICAvLyBvYmplY3QgaGFuZGxpbmdcbiAgaWYgKEFycmF5LmlzQXJyYXkoYmFzZSkpIHJldHVybiBbLi4uYmFzZV0ubWFwKGRlZXBDb3B5KSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIE1hcCkge1xuICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBiYXNlKSBvdXQuc2V0KGssIGRlZXBDb3B5KHYpKTtcbiAgICByZXR1cm4gb3V0IGFzIFQ7XG4gIH1cbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiBuZXcgU2V0KGJhc2UpIGFzIFQ7ICAvLyBvYmplY3Qga2V5cyBub3QgYWxsb3dlZCBhbnl3YXlcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gbmV3IERhdGUoYmFzZSkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhiYXNlKS5tYXAoKFtrLCB2XSkgPT4gW2ssIGRlZXBDb3B5KHYpXSkpIGFzIFQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkT25seTxUPihiYXNlOiBUKTogUmVhZG9ubHk8VD4ge1xuICBzd2l0Y2ggKHR5cGVvZiBiYXNlKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICAvLyB0aGVzZSB0eXBlcyBhcmUgYWxyZWFkeSBpbW11dGFibGVcbiAgICAgIHJldHVybiBiYXNlO1xuXG4gICAgY2FzZSBcIm9iamVjdFwiOlxuICAgICAgLy8gbnVsbCBoYW5kbGVkIGhlcmVcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSByZXR1cm4gYmFzZTtcbiAgICAgIC8vIGdlbmVyYWwgb2JqZWN0cyBoYW5kbGVkIGJlbG93XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJzeW1ib2xcIjpcbiAgICBjYXNlIFwiZnVuY3Rpb25cIjpcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBiYXNlIG9mIHR5cGUgXCIke3R5cGVvZiBiYXNlfVwiIG5vdCBoYW5kbGVkIGJ5IHJlYWRPbmx5YCk7XG4gIH1cblxuICAvLyBvYmplY3QgaGFuZGxpbmdcbiAgaWYgKEFycmF5LmlzQXJyYXkoYmFzZSkpIHJldHVybiByZWFkT25seUFycmF5KGJhc2UpIGFzIFQ7XG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSByZXR1cm4gcmVhZE9ubHlNYXAoYmFzZSkgYXMgVDtcbiAgaWYgKGJhc2UgaW5zdGFuY2VvZiBTZXQpIHJldHVybiByZWFkT25seVNldChiYXNlKSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIERhdGUpIHJldHVybiByZWFkT25seURhdGUoYmFzZSkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIHJlYWRPbmx5T2JqZWN0KGJhc2UgYXMgYW55KSBhcyBUO1xufVxuXG5mdW5jdGlvbiB0aHJvd1JlYWRPbmx5RXJyb3IoKTogYW55IHtcbiAgdGhyb3cgbmV3IEVycm9yKFwib2JqZWN0IGlzIHJlYWQtb25seSBhbmQgbWF5IG5vdCBiZSBtb2RpZmllZFwiKTtcbn1cblxuZnVuY3Rpb24gcmVhZE9ubHlPYmplY3Q8VD4oYmFzZTogUmVjb3JkPHN0cmluZywgVD4pOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBUPj4ge1xuICBjb25zdCBjYWNoZTogUmVjb3JkPHN0cmluZywgYW55PiA9IHt9O1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBzZXQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGJhc2UpO1xuXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVhZE9ubHkoYmFzZVtwcm9wXSk7XG4gICAgICAgIGNhY2hlW3Byb3BdID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgbGV0IHZhbHVlID0gYmFzZVtwcm9wXTtcblxuICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueVtdKSA9PiB2YWx1ZS5hcHBseShiYXNlLCBhcmdzKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgcm8gPSByZWFkT25seSh2YWx1ZSk7XG4gICAgICBjYWNoZVtwcm9wXSA9IHJvO1xuICAgICAgcmV0dXJuIHJvO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZWFkT25seUFycmF5PFQ+KGJhc2U6IFRbXSk6IFJlYWRvbmx5PFRbXT4ge1xuICBjb25zdCBjYWNoZSA9IEFycmF5KGJhc2UubGVuZ3RoKTtcbiAgbGV0IGZpbGxlZCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIGRpcnR5MShuOiBudW1iZXIpOiBUIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgbikpIHJldHVybiBjYWNoZVtuXTtcbiAgICBpZiAoIU9iamVjdC5oYXNPd24oYmFzZSwgbikpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgcm8gPSByZWFkT25seShiYXNlW25dKTtcbiAgICBjYWNoZVtuXSA9IHJvO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCl7XG4gICAgLy8gYWxsIGl0ZW1zIGF0IG9uY2VcbiAgICBpZiAoZmlsbGVkKSByZXR1cm4gY2FjaGU7XG4gICAgZmlsbGVkID0gdHJ1ZTtcbiAgICBmb3IgKGNvbnN0IG4gb2YgYmFzZS5rZXlzKCkpIGRpcnR5MShuKTtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBjb25zdCByb0FycmF5TWV0aG9kczogYW55ID0ge1xuICAgIC8vIHNwZWNpYWxcbiAgICBhdDogKGluZGV4OiBudW1iZXIpID0+IGRpcnR5MShpbmRleCA+IC0xID8gaW5kZXggOiBiYXNlLmxlbmd0aCArIGluZGV4KSxcblxuICAgIC8vIHRoaW5ncyB3aGljaCByZXF1aXJlIGRpcnR5QWxsKCksIHRoZW4gcnVuIGFnYWluc3QgdGhlIGZ1bGwgc2hhbGxvdyBjb3B5XG4gICAgY29uY2F0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmNvbmNhdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBlbnRyaWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmVudHJpZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZXZlcnk6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZXZlcnkuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmlsdGVyOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbHRlci5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbmQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmluZEluZGV4OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZpbmRJbmRleC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kTGFzdDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS5maW5kTGFzdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kTGFzdEluZGV4OiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmZpbmRMYXN0SW5kZXguYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmxhdDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mbGF0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZsYXRNYXA6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmxhdE1hcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmb3JFYWNoOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZvckVhY2guYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgbWFwOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLm1hcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICByZWR1Y2U6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UucmVkdWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHJlZHVjZVJpZ2h0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnJlZHVjZVJpZ2h0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHNsaWNlOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnNsaWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHNvbWU6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uuc29tZS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1JldmVyc2VkOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLnRvUmV2ZXJzZWQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9Tb3J0ZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9Tb3J0ZWQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9TcGxpY2VkOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLnRvU3BsaWNlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB2YWx1ZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudmFsdWVzLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHdpdGg6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkud2l0aC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBbU3ltYm9sLml0ZXJhdG9yXTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZVtTeW1ib2wuaXRlcmF0b3JdLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gc2FmZSBnZXR0ZXJzXG4gICAgaW5kZXhPZjogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS5pbmRleE9mKC4uLmFyZ3MpLFxuICAgIGpvaW46ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkuam9pbiguLi5hcmdzKSxcbiAgICBrZXlzOiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmtleXMoLi4uYXJncyksXG4gICAgbGFzdEluZGV4T2Y6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkubGFzdEluZGV4T2YoLi4uYXJncyksXG4gICAgdG9Mb2NhbGVTdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9Mb2NhbGVTdHJpbmcoLi4uYXJncyksXG4gICAgdG9TdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9TdHJpbmcoLi4uYXJncyksXG5cbiAgICAvLyBkaXNhbGxvd2VkXG4gICAgcHVzaDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHBvcDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNoaWZ0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgcmV2ZXJzZTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIGNvcHlXaXRoaW46IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBmaWxsOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc29ydDogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNwbGljZTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHVuc2hpZnQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgfTtcblxuICByZXR1cm4gbmV3IFByb3h5KGJhc2UsIHtcbiAgICBkZWZpbmVQcm9wZXJ0eTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIGRlbGV0ZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc2V0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGJhc2UpO1xuXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIHByb3ApKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmVhZE9ubHkoYmFzZVtwcm9wXSk7XG4gICAgICAgIGNhY2hlW3Byb3BdID0gdmFsdWU7XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWV0aG9kID0gcm9BcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICByZXR1cm4gYmFzZVtwcm9wXTtcbiAgICB9LFxuICB9KTtcbn1cblxuY29uc3Qgcm9EYXRlUHJvdG90eXBlID0ge1xuICBzZXREYXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldEZ1bGxZZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldEhvdXJzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldE1pbGxpc2Vjb25kczogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRNaW51dGVzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldE1vbnRoOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFNlY29uZHM6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgc2V0VGltZTogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRVVENEYXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ0Z1bGxZZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ0hvdXJzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ01pbGxpc2Vjb25kczogdGhyb3dSZWFkT25seUVycm9yLFxuICBzZXRVVENNaW51dGVzOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ01vbnRoOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIHNldFVUQ1NlY29uZHM6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgc2V0WWVhcjogdGhyb3dSZWFkT25seUVycm9yLFxufVxuT2JqZWN0LnNldFByb3RvdHlwZU9mKHJvRGF0ZVByb3RvdHlwZSwgRGF0ZS5wcm90b3R5cGUpO1xuXG5mdW5jdGlvbiByZWFkT25seURhdGUoYmFzZTogRGF0ZSk6IFJlYWRvbmx5PERhdGU+IHtcbiAgLy8gY29weSBpbnN0ZWFkIG9mIHByb3h5XG4gIGNvbnN0IG91dCA9IG5ldyBEYXRlKGJhc2UpO1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2Yob3V0LCByb0RhdGVQcm90b3R5cGUpO1xuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiByZWFkT25seU1hcDxLLCBWPihiYXNlOiBNYXA8SywgVj4pOiBSZWFkb25seTxNYXA8SywgUmVhZG9ubHk8Vj4+PiB7XG4gIGNvbnN0IGNhY2hlOiBNYXA8SywgUmVhZG9ubHk8Vj4+ID0gbmV3IE1hcCgpO1xuICBsZXQgZmlsbGVkID0gZmFsc2U7XG5cbiAgZnVuY3Rpb24gZGlydHkxKGs6IEspOiBWIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoZmlsbGVkIHx8IGNhY2hlLmhhcyhrKSkgcmV0dXJuIGNhY2hlLmdldChrKTtcbiAgICBpZiAoIWJhc2UuaGFzKGspKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIGNvbnN0IHJvID0gcmVhZE9ubHkoYmFzZS5nZXQoaykhKTtcbiAgICBjYWNoZS5zZXQoaywgcm8pO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCkge1xuICAgIGlmIChmaWxsZWQpIHJldHVybiBjYWNoZTtcbiAgICBmaWxsZWQgPSB0cnVlO1xuICAgIGZvciAoY29uc3QgayBvZiBiYXNlLmtleXMoKSkge1xuICAgICAgaWYgKGNhY2hlLmhhcyhrKSkgY29udGludWU7XG4gICAgICBjYWNoZS5zZXQoaywgcmVhZE9ubHkoYmFzZS5nZXQoaykhKSk7XG4gICAgfVxuICAgIHJldHVybiBjYWNoZTtcbiAgfVxuXG4gIGNvbnN0IHJvTWFwTWV0aG9kczogYW55ID0ge1xuICAgIC8vIHNwZWNpYWxcbiAgICBnZXQ6IChrZXk6IGFueSkgPT4gZGlydHkxKGtleSksXG5cbiAgICAvLyByZXF1aXJlcyBkaXJ0eUFsbFxuICAgIGVudHJpZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZW50cmllcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmb3JFYWNoOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZvckVhY2guYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdmFsdWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLnZhbHVlcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBbU3ltYm9sLml0ZXJhdG9yXTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZVtTeW1ib2wuaXRlcmF0b3JdLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gcGFzc3RocnVcbiAgICBoYXM6ICguLi5hcmdzOiBhbnlbXSkgPT4gKGJhc2UgYXMgYW55KS5oYXMoLi4uYXJncyksXG4gICAga2V5czogKC4uLmFyZ3M6IGFueVtdKSA9PiAoYmFzZSBhcyBhbnkpLmtleXMoLi4uYXJncyksXG5cbiAgICAvLyBtdXRhdG9yc1xuICAgIGNsZWFyOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZ2V0T3JJbnNlcnQ6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBnZXRPckluc2VydENvbXB1dGVkOiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgc2V0OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gIH07XG4gIE9iamVjdC5zZXRQcm90b3R5cGVPZihyb01hcE1ldGhvZHMsIG51bGwpO1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5OiB0aHJvd1JlYWRPbmx5RXJyb3IsXG4gICAgZGVsZXRlUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBzZXQ6IHRocm93UmVhZE9ubHlFcnJvcixcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gKCkgPT4gZGVlcENvcHkoYmFzZSk7XG4gICAgICBjb25zdCBtZXRob2QgPSByb01hcE1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICByZXR1cm4gKGJhc2UgYXMgYW55KVtwcm9wXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gbm8gY2FjaGUgbmVlZGVkLCBzaW5jZSB3ZSBkb24ndCBzdXBwb3J0IG9iamVjdCBrZXlzIGFuZCB0aGVyZSBhcmUgbm8gdmFsdWVzXG5mdW5jdGlvbiByZWFkT25seVNldDxLPihiYXNlOiBTZXQ8Sz4pOiBSZWFkb25seTxTZXQ8Sz4+IHtcbiAgcmV0dXJuIG5ldyBQcm94eShiYXNlLCB7XG4gICAgZGVmaW5lUHJvcGVydHk6IHRocm93UmVhZE9ubHlFcnJvcixcbiAgICBkZWxldGVQcm9wZXJ0eTogdGhyb3dSZWFkT25seUVycm9yLFxuICAgIHNldDogdGhyb3dSZWFkT25seUVycm9yLFxuXG4gICAgZ2V0KF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKHByb3AgPT09IGNvcHlTeW0pIHJldHVybiAoKSA9PiBkZWVwQ29weShiYXNlKTtcblxuICAgICAgLy8ganVzdCBkaXNhbGxvdyBtdXRhdGlvbnNcbiAgICAgIGlmIChwcm9wID09PSBcImFkZFwiIHx8IHByb3AgPT09IFwiZGVsZXRlXCIgfHwgcHJvcCA9PT0gXCJjbGVhclwiKSByZXR1cm4gdGhyb3dSZWFkT25seUVycm9yO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IChiYXNlIGFzIGFueSlbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoYmFzZSwgYXJncyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb3B5T25Xcml0ZTxUPihiYXNlOiBULCBwYXJlbnQ/OiAoKSA9PiB2b2lkKTogVCB7XG4gIHN3aXRjaCAodHlwZW9mIGJhc2UpIHtcbiAgICBjYXNlIFwiYm9vbGVhblwiOlxuICAgIGNhc2UgXCJiaWdpbnRcIjpcbiAgICBjYXNlIFwibnVtYmVyXCI6XG4gICAgY2FzZSBcInN0cmluZ1wiOlxuICAgIGNhc2UgXCJ1bmRlZmluZWRcIjpcbiAgICAgIC8vIHRoZXNlIHR5cGVzIGFyZSBhbHJlYWR5IGltbXV0YWJsZVxuICAgICAgcmV0dXJuIGJhc2U7XG5cbiAgICBjYXNlIFwib2JqZWN0XCI6XG4gICAgICAvLyBudWxsIGhhbmRsZWQgaGVyZVxuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHJldHVybiBiYXNlO1xuICAgICAgaWYgKGJhc2UgaW5zdGFuY2VvZiBEYXRlKSByZXR1cm4gbmV3IERhdGUoYmFzZSkgYXMgVDsgLy8gdHJpdmlhbCBjb3B5XG4gICAgICAvLyBnZW5lcmFsIG9iamVjdHMgaGFuZGxlZCBiZWxvd1xuICAgICAgYnJlYWs7XG5cbiAgICBjYXNlIFwic3ltYm9sXCI6XG4gICAgY2FzZSBcImZ1bmN0aW9uXCI6XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBvZiB0eXBlIFwiJHt0eXBlb2YgYmFzZX1cIiBub3QgaGFuZGxlZCBieSBjb3B5T25Xcml0ZWApO1xuICB9XG5cbiAgLy8gb2JqZWN0IGhhbmRsaW5nXG4gIGlmIChBcnJheS5pc0FycmF5KGJhc2UpKSByZXR1cm4gY29weU9uV3JpdGVBcnJheShiYXNlLCBwYXJlbnQpIGFzIFQ7XG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSByZXR1cm4gY29weU9uV3JpdGVNYXAoYmFzZSwgcGFyZW50KSBhcyBUO1xuICBpZiAoYmFzZSBpbnN0YW5jZW9mIFNldCkgcmV0dXJuIGNvcHlPbldyaXRlU2V0KGJhc2UsIHBhcmVudCkgYXMgVDtcbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgcmV0dXJuIGNvcHlPbldyaXRlT2JqZWN0KGJhc2UgYXMgYW55LCBwYXJlbnQpIGFzIFQ7XG59XG5cbmNvbnN0IHJlY292ZXJTeW0gPSBTeW1ib2woKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlY292ZXI8VD4oYmFzZTogVCk6IFQge1xuICBzd2l0Y2ggKHR5cGVvZiBiYXNlKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICAvLyBsZWFmIHR5cGUgZm91bmQ7IG5vdGhpbmcgd2FzIGNvd1xuICAgICAgcmV0dXJuIGJhc2U7XG5cbiAgICBjYXNlIFwib2JqZWN0XCI6XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkgcmV0dXJuIGJhc2U7XG4gICAgICBpZiAoYmFzZSBpbnN0YW5jZW9mIERhdGUpIHJldHVybiBiYXNlO1xuICAgICAgLy8gZ2VuZXJhbCBvYmplY3RzIGhhbmRsZWQgYmVsb3dcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcInN5bWJvbFwiOlxuICAgIGNhc2UgXCJmdW5jdGlvblwiOlxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGJhc2Ugb2YgdHlwZSBcIiR7dHlwZW9mIGJhc2V9XCIgbm90IGhhbmRsZWQgYnkgcmVjb3ZlcmApO1xuICB9XG5cbiAgLy8gY2hlY2sgaWYgb2JqZWN0IHdhcyByZXR1cm5lZCBieSBjb3B5T25Xcml0ZTsgcmVjb3ZlciBpdHMgaW5uZXIgdmFsdWVcbiAgY29uc3QgcmN2cjogKCkgPT4gVCA9IChiYXNlIGFzIGFueSlbcmVjb3ZlclN5bV07XG4gIGlmIChyY3ZyKSByZXR1cm4gcmN2cigpO1xuXG4gIC8vIG90aGVyd2lzZSB3YWxrIG5vcm1hbCBvYmplY3RzIGxvb2tpbmcgZm9yIGFueXRoaW5nIHRoYXQgY2FtZSBvdXQgb2YgYSBjb3B5T25Xcml0ZS5cblxuICBpZiAoQXJyYXkuaXNBcnJheShiYXNlKSkge1xuICAgIGZvciAoY29uc3QgW2ksIGl0ZW1dIG9mIGJhc2UuZW50cmllcygpKSB7XG4gICAgICBjb25zdCByID0gcmVjb3ZlcihpdGVtKTtcbiAgICAgIGlmIChyICE9PSBpdGVtKSB7XG4gICAgICAgIGJhc2VbaV0gPSByO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gYmFzZTtcbiAgfVxuXG4gIGlmIChiYXNlIGluc3RhbmNlb2YgTWFwKSB7XG4gICAgZm9yKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBiYXNlLmVudHJpZXMoKSkge1xuICAgICAgY29uc3QgciA9IHJlY292ZXIodmFsdWUpO1xuICAgICAgaWYgKHIgIT09IHZhbHVlKSB7XG4gICAgICAgIGJhc2Uuc2V0KGtleSwgcik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBiYXNlO1xuICB9XG5cbiAgLy8gU2V0IHdpdGggbm9uLXByaW1pdGl2ZSBrZXlzIGlzIG5vdCBzdXBwb3J0ZWQsIHNvIG5vdGhpbmcgdG8gYmUgY2hlY2tlZFxuICBpZiAoYmFzZSBpbnN0YW5jZW9mIFNldCkgcmV0dXJuIGJhc2U7XG5cbiAgY29uc3QgcHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoYmFzZSk7XG4gIGlmIChwcm90byAmJiBwcm90byAhPT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgYmFzZSBoYXMgYSBub25zdGFuZGFyZCBwcm90b3lwZWApO1xuICB9XG5cbiAgLy8gcGxhaW4gb2JqZWN0c1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhiYXNlKSkge1xuICAgIGNvbnN0IHIgPSByZWNvdmVyKHZhbHVlKTtcbiAgICBpZiAociAhPT0gdmFsdWUpIHtcbiAgICAgIChiYXNlIGFzIGFueSlba2V5XSA9IHI7XG4gICAgfVxuICB9XG4gIHJldHVybiBiYXNlIGFzIFQ7XG59XG5cbmNvbnN0IERFTEVURUQgPSBTeW1ib2woXCJERUxFVEVEXCIpO1xuXG5mdW5jdGlvbiBjb3B5T25Xcml0ZU9iamVjdDxUPihiYXNlOiBSZWNvcmQ8c3RyaW5nLCBUPiwgcGFyZW50PzogKCkgPT4gdm9pZCk6IFJlY29yZDxzdHJpbmcsIFQ+IHtcbiAgLy8gYnVpbGQgb3VyIGNhY2hlIGluY3JlbWVudGFsbHksIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGNvcHlPbldyaXRlIGNhbGxzIHRvIGEgbWluaW11bVxuICBjb25zdCBjYWNoZTogUmVjb3JkPHN0cmluZywgVCB8IHR5cGVvZiBERUxFVEVEPiA9IHt9O1xuICBsZXQgY2xlYW4gPSB0cnVlO1xuICBsZXQgZnVsbCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIG1hcmsoKSB7XG4gICAgaWYgKGNsZWFuKSB7XG4gICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgLy8gZGlydHkgb3VyIHBhcmVudCB0b29cbiAgICAgIGlmIChwYXJlbnQpIHBhcmVudCgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGNvcHkoKSB7XG4gICAgaWYgKGNsZWFuKSByZXR1cm4gZGVlcENvcHkoYmFzZSk7XG4gICAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCBUPiA9IHt9O1xuICAgIGlmICghZnVsbCkge1xuICAgICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKGJhc2UpKSB7XG4gICAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleV0gPSBkZWVwQ29weSh2YWwpO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICBpZiAodmFsICE9PSBERUxFVEVEKSBvdXRba2V5XSA9IGRlZXBDb3B5KHZhbCBhcyBUKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJjdnIoKSB7XG4gICAgLy8gd2FzIGFueSBtb2RpZmljYXRpb24gbWFkZT9cbiAgICBpZiAoY2xlYW4pIHJldHVybiBiYXNlO1xuICAgIGlmIChmdWxsKSB7XG4gICAgICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIFQ+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICAgIGlmICh2YWwgIT09IERFTEVURUQpIG91dFtrZXldID0gcmVjb3Zlcih2YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgLy8gc3RhcnQgd2l0aCBhIHNoYWxsb3cgY29weSBvZiBiYXNlXG4gICAgY29uc3Qgb3V0ID0geyAuLi5iYXNlIH07XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKGNhY2hlKSkge1xuICAgICAgaWYgKHZhbCA9PT0gREVMRVRFRCkge1xuICAgICAgICBkZWxldGUgb3V0W2tleV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRba2V5XSA9IHJlY292ZXIodmFsKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoXywgcHJvcDogYW55KSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBjYWNoZVtwcm9wXSA9IERFTEVURUQ7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuXG4gICAgZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKGNhY2hlW3Byb3BdID09PSBERUxFVEVEKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApID8/XG4gICAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoYmFzZSwgcHJvcCk7XG4gICAgfSxcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gY29weTtcbiAgICAgIGlmIChwcm9wID09PSByZWNvdmVyU3ltKSByZXR1cm4gcmN2cjtcblxuICAgICAgLy8gbG9va3VwIHZhbHVlIGluIGNhY2hlIGZpcnN0XG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBjYWNoZVtwcm9wXTtcbiAgICAgICAgcmV0dXJuIHZhbHVlICE9PSBERUxFVEVEID8gdmFsdWUgOiB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICAvLyB0aGVuIGdldCBjYWNoZWFibGUgdmFsdWUgZnJvbSBiYXNlXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihiYXNlLCBwcm9wKSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvcHlPbldyaXRlKGJhc2VbcHJvcF0sIG1hcmspO1xuICAgICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gYmFzZVtwcm9wXTtcbiAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgICAgIHJldHVybiAoLi4uYXJnczogYW55KSA9PiB2YWx1ZS5hcHBseShjYWNoZSwgYXJncyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSxcblxuICAgIGhhcyhfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChPYmplY3QuaGFzT3duKGNhY2hlLCBwcm9wKSkgcmV0dXJuIGNhY2hlW3Byb3BdICE9PSBERUxFVEVEO1xuICAgICAgcmV0dXJuIHByb3AgaW4gYmFzZTtcbiAgICB9LFxuXG4gICAgb3duS2V5cygpIHtcbiAgICAgIGNvbnN0IG91dCA9IFtdO1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoYmFzZSkpIHtcbiAgICAgICAgaWYgKGNhY2hlW2tleV0gPT09IERFTEVURUQpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2FjaGUpKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIGtleSkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoY2FjaGVba2V5XSAhPT0gREVMRVRFRCkgb3V0LnB1c2goa2V5KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBvdXQ7XG4gICAgfSxcblxuICAgIHNldChfLCBwcm9wOiBhbnksIHZhbHVlOiBUKSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNvcHlPbldyaXRlQXJyYXk8VD4oYmFzZTogVFtdLCBwYXJlbnQ/OiAoKSA9PiB2b2lkKTogVFtdIHtcbiAgLy8gYnVpbGQgb3VyIGNhY2hlIGluY3JlbWVudGFsbHksIHRvIHJlZHVjZSB0aGUgbnVtYmVyIG9mIGNvcHlPbldyaXRlIGNhbGxzIHRvIGEgbWluaW11bVxuICBjb25zdCBjYWNoZSA9IEFycmF5PFQgfCB0eXBlb2YgREVMRVRFRD4oYmFzZS5sZW5ndGgpO1xuICBsZXQgY2xlYW4gPSB0cnVlO1xuICBsZXQgZnVsbCA9IGZhbHNlO1xuXG4gIGZ1bmN0aW9uIG1hcmsoKSB7XG4gICAgaWYgKGNsZWFuKSB7XG4gICAgICBjbGVhbiA9IGZhbHNlO1xuICAgICAgaWYgKHBhcmVudCkgcGFyZW50KCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZGlydHkxKG46IG51bWJlcil7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZVtuXTtcbiAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgbikpe1xuICAgICAgY29uc3Qgb3V0ID0gY2FjaGVbbl07XG4gICAgICByZXR1cm4gb3V0ICE9PSBERUxFVEVEID8gb3V0IDogdW5kZWZpbmVkO1xuICAgIH1cbiAgICBpZiAoIU9iamVjdC5oYXNPd24oYmFzZSwgbikpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgcm8gPSBjb3B5T25Xcml0ZShiYXNlW25dKTtcbiAgICBjYWNoZVtuXSA9IHJvO1xuICAgIHJldHVybiBybztcbiAgfVxuXG4gIGZ1bmN0aW9uIGRpcnR5QWxsKCl7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZTtcbiAgICBmdWxsID0gdHJ1ZTtcbiAgICAvLyB1c2UgT2JqZWN0LmtleXMoKSBpbnN0ZWFkIG9mIC5rZXlzKCkgdG8gcHJlc2VydmUgaG9sZXNcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhiYXNlKSkge1xuICAgICAgaWYgKCFPYmplY3QuaGFzT3duKGNhY2hlLCBrZXkpKSB7XG4gICAgICAgIGNhY2hlW2tleSBhcyBhbnldID0gY29weU9uV3JpdGUoYmFzZVtrZXkgYXMgYW55XSwgbWFyayk7XG4gICAgICB9XG4gICAgfVxuICAgIC8vIHRvIG1ha2UgdGhpbmdzIGxpa2UgaXRlcmF0aW9uIGVhc3ksIHdlIHJlbW92ZSBERUxFVEVEIGFmdGVyIHdlIGl0ZXJhdGVcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgIGlmICh2YWx1ZSA9PT0gREVMRVRFRCkgZGVsZXRlIGNhY2hlW2tleSBhcyBhbnldO1xuICAgIH1cbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBjb25zdCBjb3dBcnJheU1ldGhvZHM6IGFueSA9IHtcbiAgICAvLyBzcGVjaWFsXG4gICAgYXQ6IChpbmRleDogbnVtYmVyKSA9PiBkaXJ0eTEoaW5kZXggPiAtMSA/IGluZGV4IDogYmFzZS5sZW5ndGggKyBpbmRleCksXG4gICAgcHVzaDogKC4uLmFyZ3M6IGFueVtdKSA9PiAobWFyaygpLCBjYWNoZS5wdXNoKC4uLmFyZ3MpKSxcblxuXG4gICAgLy8gdGhpbmdzIHdoaWNoIHJlcXVpcmUgZGlydHlBbGwoKSwgdGhlbiBydW4gYWdhaW5zdCB0aGUgZnVsbCBzaGFsbG93IGNvcHlcbiAgICBjb25jYXQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuY29uY2F0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGVudHJpZXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZW50cmllcy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBldmVyeTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5ldmVyeS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaWx0ZXI6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmlsdGVyLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmluZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmaW5kSW5kZXg6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZmluZEluZGV4LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmRMYXN0OiAoLi4uYXJnczogYW55KSA9PiAoYmFzZSBhcyBhbnkpLmZpbmRMYXN0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZpbmRMYXN0SW5kZXg6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkuZmluZExhc3RJbmRleC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBmbGF0OiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmZsYXQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZmxhdE1hcDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mbGF0TWFwLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIGZvckVhY2g6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UuZm9yRWFjaC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBtYXA6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UubWFwLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHJlZHVjZTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5yZWR1Y2UuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgcmVkdWNlUmlnaHQ6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UucmVkdWNlUmlnaHQuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgc2xpY2U6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uuc2xpY2UuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgc29tZTogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5zb21lLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHRvUmV2ZXJzZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9SZXZlcnNlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1NvcnRlZDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS50b1NvcnRlZC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICB0b1NwbGljZWQ6ICguLi5hcmdzOiBhbnkpID0+IChiYXNlIGFzIGFueSkudG9TcGxpY2VkLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHZhbHVlczogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS52YWx1ZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgd2l0aDogKC4uLmFyZ3M6IGFueSkgPT4gKGJhc2UgYXMgYW55KS53aXRoLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIFtTeW1ib2wuaXRlcmF0b3JdOiAoLi4uYXJnczogYW55KSA9PiBiYXNlW1N5bWJvbC5pdGVyYXRvcl0uYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG5cbiAgICAvLyBtdXRhdG9ycyB0aGF0IHJlcXVpcmUgYSBkaXJ0eUFsbCgpIGR1ZSB0byBwb3NzaWJsZSBpbmRleCBjaGFuZ2VzXG4gICAgcG9wOiAoLi4uYXJnczogYW55KSA9PiAobWFyaygpLCBiYXNlLnBvcC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgcmV2ZXJzZTogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5yZXZlcnNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBjb3B5V2l0aGluOiAoLi4uYXJnczogYW55KSA9PiAobWFyaygpLCBiYXNlLmNvcHlXaXRoaW4uYXBwbHkoZGlydHlBbGwoKSwgYXJncykpLFxuICAgIGZpbGw6ICguLi5hcmdzOiBhbnkpID0+IChtYXJrKCksIGJhc2UuZmlsbC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgc29ydDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5zb3J0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBzcGxpY2U6ICguLi5hcmdzOiBhbnkpID0+IChtYXJrKCksIGJhc2Uuc3BsaWNlLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcbiAgICBzaGlmdDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS5zaGlmdC5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSksXG4gICAgdW5zaGlmdDogKC4uLmFyZ3M6IGFueSkgPT4gKG1hcmsoKSwgYmFzZS51bnNoaWZ0LmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpKSxcblxuICAgIC8vIGdldHRlcnMgd2hpY2ggZG9uJ3QgSEFWRSB0byBjb3dpZnkgdGhlIHdob2xlIGFycmF5LCBidXQgd291bGQgbmVlZCBzb21ldGhpbmcgYWJvdXQgYXMgZXhwZW5zaXZlXG4gICAgdG9Mb2NhbGVTdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudG9Mb2NhbGVTdHJpbmcuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgdG9TdHJpbmc6ICguLi5hcmdzOiBhbnkpID0+IGJhc2UudG9TdHJpbmcuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgam9pbjogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5qb2luLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuXG4gICAgLy8gZ2V0dGVycyB3aGljaCB3b3JrIGFnYWluc3QgY2FjaGUgYXMtaXNcbiAgICBrZXlzOiAoKSA9PiBjYWNoZS5rZXlzKCksXG5cbiAgICAvLyBnZXR0ZXJzIHdoaWNoIGNhbiBvcGVyYXRlIG9uIGEgZnJhbmtlbnN0ZWluIGFycmF5IHdoZXJlIGJhc2UgaXMgcHJvdG90eXBlIG9mIGNhY2hlXG4gICAgaW5jbHVkZXM6ICguLi5hcmdzOiBhbnkpID0+IHtcbiAgICAgIGNvbnN0IG9sZCA9IE9iamVjdC5nZXRQcm90b3R5cGVPZihjYWNoZSk7XG4gICAgICB0cnkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIGJhc2UpO1xuICAgICAgICByZXR1cm4gKGNhY2hlIGFzIGFueSkuaW5jbHVkZXMoLi4uYXJncyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIG9sZCk7XG4gICAgICB9XG4gICAgfSxcbiAgICBpbmRleE9mOiAoLi4uYXJnczogYW55KSA9PiB7XG4gICAgICBjb25zdCBvbGQgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoY2FjaGUpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGNhY2hlLCBiYXNlKTtcbiAgICAgICAgcmV0dXJuIChjYWNoZSBhcyBhbnkpLmluZGV4T2YoLi4uYXJncyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY2FjaGUsIG9sZCk7XG4gICAgICB9XG4gICAgfSxcbiAgICBsYXN0SW5kZXhPZjogKC4uLmFyZ3M6IGFueSkgPT4ge1xuICAgICAgY29uc3Qgb2xkID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKGNhY2hlKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjYWNoZSwgYmFzZSk7XG4gICAgICAgIHJldHVybiAoY2FjaGUgYXMgYW55KS5sYXN0SW5kZXhPZiguLi5hcmdzKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjYWNoZSwgb2xkKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY293QXJyYXlNZXRob2RzLCBudWxsKTtcblxuICBmdW5jdGlvbiBjb3B5KCkge1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGRlZXBDb3B5KGJhc2UpO1xuICAgIGlmIChmdWxsKSByZXR1cm4gZGVlcENvcHkoY2FjaGUpO1xuICAgIGNvbnN0IG91dCA9IEFycmF5KGNhY2hlLmxlbmd0aCk7XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoYmFzZSkpIHtcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleSBhcyBhbnldID0gZGVlcENvcHkodmFsdWUpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgIGlmICh2YWx1ZSAhPT0gREVMRVRFRCkgb3V0W2tleSBhcyBhbnldID0gZGVlcENvcHkodmFsdWUpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0O1xuICB9XG5cbiAgZnVuY3Rpb24gcmN2cigpIHtcbiAgICAvLyB3YXMgYW55IG1vZGlmaWNhdGlvbiBtYWRlP1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGJhc2U7XG4gICAgaWYgKGZ1bGwpIHtcbiAgICAgIGNvbnN0IG91dCA9IEFycmF5KGNhY2hlLmxlbmd0aClcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsXSBvZiBPYmplY3QuZW50cmllcyhjYWNoZSkpIHtcbiAgICAgICAgb3V0W2tleSBhcyBhbnldID0gcmVjb3Zlcih2YWwpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG91dDtcbiAgICB9XG4gICAgY29uc3Qgb3V0ID0gQXJyYXkoY2FjaGUubGVuZ3RoKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoYmFzZSkpIHtcbiAgICAgIGlmICghT2JqZWN0Lmhhc093bihjYWNoZSwga2V5KSkgb3V0W2tleSBhcyBhbnldID0gdmFsO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoY2FjaGUpKSB7XG4gICAgICBpZiAodmFsICE9PSBERUxFVEVEKSBvdXRba2V5IGFzIGFueV0gPSByZWNvdmVyKHZhbCk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICByZXR1cm4gbmV3IFByb3h5KGJhc2UsIHtcbiAgICBkZWZpbmVQcm9wZXJ0eSgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIm5vdCBzdXBwb3J0ZWQgYnkgY29weU9uV3JpdGVcIik7XG4gICAgfSxcblxuICAgIGRlbGV0ZVByb3BlcnR5KF8sIHByb3A6IGFueSkge1xuICAgICAgaWYgKGZ1bGwpIHtcbiAgICAgICAgaWYgKE9iamVjdC5oYXNPd24oYmFzZSwgcHJvcCkpIG1hcmsoKTtcbiAgICAgICAgZGVsZXRlIGNhY2hlW3Byb3BdO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIG1hcmsoKTtcbiAgICAgIGNhY2hlW3Byb3BdID0gREVMRVRFRDtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApO1xuICAgICAgaWYgKGNhY2hlW3Byb3BdID09PSBERUxFVEVEKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoY2FjaGUsIHByb3ApID8/XG4gICAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoYmFzZSwgcHJvcCk7XG4gICAgfSxcblxuICAgIGdldChfLCBwcm9wOiBhbnkpIHtcbiAgICAgIGlmIChwcm9wID09PSBjb3B5U3ltKSByZXR1cm4gY29weTtcbiAgICAgIGlmIChwcm9wID09PSByZWNvdmVyU3ltKSByZXR1cm4gcmN2cjtcblxuICAgICAgLy8gc3BlY2lhbCBsb2dpYyBpZiB3ZSBoYXZlIG5vIG1vcmUgREVMRVRFRHMgaW4gY2FjaGVcbiAgICAgIGlmIChmdWxsKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGNhY2hlLCBwcm9wKSkge1xuICAgICAgICAgIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtZXRob2QgPSBjb3dBcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICAgIGlmIChtZXRob2QpIHJldHVybiBtZXRob2Q7XG4gICAgICAgIHJldHVybiBjYWNoZVtwcm9wXTtcbiAgICAgIH1cblxuICAgICAgLy8gbG9va3VwIHZhbHVlIGluIGNhY2hlIGZpcnN0XG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihjYWNoZSwgcHJvcCkpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBjYWNoZVtwcm9wXTtcbiAgICAgICAgcmV0dXJuIHZhbHVlICE9PSBERUxFVEVEID8gdmFsdWUgOiB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICAvLyB0aGVuIGdldCBjYWNoZWFibGUgdmFsdWUgZnJvbSBiYXNlXG4gICAgICBpZiAoT2JqZWN0Lmhhc093bihiYXNlLCBwcm9wKSkge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvcHlPbldyaXRlKGJhc2VbcHJvcF0sIG1hcmspO1xuICAgICAgICBjYWNoZVtwcm9wXSA9IHZhbHVlO1xuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgICB9XG5cbiAgICAgIC8vIGdldCBtZXRob2RzXG4gICAgICBjb25zdCBtZXRob2QgPSBjb3dBcnJheU1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IGJhc2VbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoY2FjaGUsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIE9iamVjdC5oYXNPd24oY2FjaGUsIHByb3ApO1xuICAgICAgaWYgKE9iamVjdC5oYXNPd24oY2FjaGUsIHByb3ApKSByZXR1cm4gY2FjaGVbcHJvcF0gIT09IERFTEVURUQ7XG4gICAgICByZXR1cm4gcHJvcCBpbiBiYXNlO1xuICAgIH0sXG5cbiAgICBvd25LZXlzKCkge1xuICAgICAgaWYgKGZ1bGwpIHJldHVybiBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyhjYWNoZSk7XG4gICAgICBjb25zdCBvdXQgPSBbXCJsZW5ndGhcIl07XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhiYXNlKSkge1xuICAgICAgICBpZiAoY2FjaGVba2V5IGFzIGFueV0gPT09IERFTEVURUQpIGNvbnRpbnVlO1xuICAgICAgICBvdXQucHVzaChrZXkpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoY2FjaGUpKSB7XG4gICAgICAgIGlmIChPYmplY3QuaGFzT3duKGJhc2UsIGtleSkpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoY2FjaGVba2V5IGFzIGFueV0gIT09IERFTEVURUQpIG91dC5wdXNoKGtleSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH0sXG5cbiAgICBzZXQoXywgcHJvcDogYW55LCB2YWx1ZTogVCkge1xuICAgICAgbWFyaygpO1xuICAgICAgY2FjaGVbcHJvcF0gPSB2YWx1ZTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjb3B5T25Xcml0ZU1hcDxLLCBWPihiYXNlOiBNYXA8SywgVj4sIHBhcmVudD86ICgpID0+IHZvaWQpOiBNYXA8SywgVj4ge1xuICAvLyBidWlsZCBvdXIgY2FjaGUgaW5jcmVtZW50YWxseSwgdG8gcmVkdWNlIHRoZSBudW1iZXIgb2YgY29weU9uV3JpdGUgY2FsbHMgdG8gYSBtaW5pbXVtXG4gIGNvbnN0IGNhY2hlOiBNYXA8SywgViB8IHR5cGVvZiBERUxFVEVEPiA9IG5ldyBNYXAoKTtcbiAgbGV0IGNsZWFuID0gdHJ1ZTtcbiAgbGV0IGZ1bGwgPSBmYWxzZTtcbiAgbGV0IG5kZWxldGlvbnMgPSAwO1xuICBsZXQgbm92ZXJsYXAgPSAwO1xuXG4gIGZ1bmN0aW9uIHNpemUoKSB7XG4gICAgaWYgKGZ1bGwpIHJldHVybiBjYWNoZS5zaXplO1xuICAgIHJldHVybiBiYXNlLnNpemUgKyBjYWNoZS5zaXplIC0gbmRlbGV0aW9ucyAtIG5vdmVybGFwO1xuICB9XG5cbiAgZnVuY3Rpb24gbWFyaygpIHtcbiAgICBpZiAoY2xlYW4pIHtcbiAgICAgIGNsZWFuID0gZmFsc2U7XG4gICAgICBpZiAocGFyZW50KSBwYXJlbnQoKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBkaXJ0eTEoazogSykge1xuICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGUuZ2V0KGspO1xuICAgIGlmIChjYWNoZS5oYXMoaykpIHtcbiAgICAgIGNvbnN0IG91dCA9IGNhY2hlLmdldChrKTtcbiAgICAgIHJldHVybiBvdXQgIT09IERFTEVURUQgPyBvdXQgOiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGlmICghYmFzZS5oYXMoaykpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgY293ID0gY29weU9uV3JpdGUoYmFzZS5nZXQoaykhLCBtYXJrKTtcbiAgICBjYWNoZS5zZXQoaywgY293KTtcbiAgICBub3ZlcmxhcCsrO1xuICAgIHJldHVybiBjb3c7XG4gIH1cblxuICBmdW5jdGlvbiBkaXJ0eUFsbCgpe1xuICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGU7XG4gICAgZnVsbCA9IHRydWU7XG4gICAgY29uc3QgZGVsZXRlZCA9IG5ldyBTZXQ8Sz4oKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBjYWNoZSkge1xuICAgICAgaWYgKHYgPT09IERFTEVURUQpIGRlbGV0ZWQuYWRkKGspO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBiYXNlKSB7XG4gICAgICBpZiAoIWNhY2hlLmhhcyhrKSkge1xuICAgICAgICBjYWNoZS5zZXQoaywgY29weU9uV3JpdGUodiwgbWFyaykpO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGsgb2YgZGVsZXRlZCkge1xuICAgICAgY2FjaGUuZGVsZXRlKGspO1xuICAgIH1cbiAgICBuZGVsZXRpb25zID0gMDtcbiAgICByZXR1cm4gY2FjaGU7XG4gIH1cblxuICBmdW5jdGlvbiBjb3B5KCkge1xuICAgIGlmIChjbGVhbikgcmV0dXJuIGRlZXBDb3B5KGJhc2UpO1xuICAgIGlmIChmdWxsKSByZXR1cm4gZGVlcENvcHkoY2FjaGUpO1xuICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBiYXNlLmVudHJpZXMoKSkge1xuICAgICAgaWYgKCFjYWNoZS5oYXMoa2V5KSkgb3V0LnNldChrZXksIGRlZXBDb3B5KHZhbHVlKSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGNhY2hlLmVudHJpZXMoKSkge1xuICAgICAgaWYgKHZhbHVlICE9PSBERUxFVEVEKSBvdXQuc2V0KGtleSwgZGVlcENvcHkodmFsdWUpKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJjdnIoKSB7XG4gICAgLy8gd2FzIGFueSBtb2RpZmljYXRpb24gbWFkZT9cbiAgICBpZiAoY2xlYW4pIHJldHVybiBiYXNlO1xuICAgIC8vIGRpZCB3ZSBhbHJlYWR5IGNvcHkgYWxsIGtleXMgYW5kIGVsaW1pbmF0ZSBkZWxldGlvbnM/XG4gICAgaWYgKGZ1bGwpIHtcbiAgICAgIGNvbnN0IG91dCA9IG5ldyBNYXAoKTtcbiAgICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIGNhY2hlKSB7XG4gICAgICAgIG91dC5zZXQoaywgcmVjb3Zlcih2KSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gb3V0O1xuICAgIH1cbiAgICAvLyBzdGFydCB3aXRoIGEgc2hhbGxvdyBjb3B5XG4gICAgY29uc3Qgb3V0ID0gbmV3IE1hcChiYXNlKTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBjYWNoZSkge1xuICAgICAgaWYgKHYgPT09IERFTEVURUQpIHtcbiAgICAgICAgb3V0LmRlbGV0ZShrKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG91dC5zZXQoaywgcmVjb3Zlcih2KSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICBsZXQgcHJveHk6IE1hcDxLLCBWPjtcblxuICAvLyBjcmVhdGUgYSBvbmUtb2ZmIG1ldGhvZHMgb2JqZWN0LCBzaW5jZSB3ZSBoYXZlIGEgbG90IG9mIHN0dWZmIHRvIGJpbmQgaW50byBpdFxuICBjb25zdCBjb3dNYXBNZXRob2RzOiBhbnkgPSB7XG4gICAgLy8gc3BlY2lhbFxuICAgIGdldDogKGtleTogSykgPT4gZGlydHkxKGtleSksXG4gICAgaGFzOiAoa2V5OiBLKSA9PiB7XG4gICAgICBpZiAoZnVsbCkgcmV0dXJuIGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKGNhY2hlLmhhcyhrZXkpKSB7XG4gICAgICAgIHJldHVybiBjYWNoZS5nZXQoa2V5KSAhPT0gREVMRVRFRDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBiYXNlLmhhcyhrZXkpO1xuICAgIH0sXG4gICAgY2xlYXIoKSB7XG4gICAgICBtYXJrKCk7XG4gICAgICBmdWxsID0gdHJ1ZTtcbiAgICAgIHJldHVybiBjYWNoZS5jbGVhcigpO1xuICAgIH0sXG5cbiAgICAvLyByZXF1aXJlcyBkaXJ0eUFsbFxuICAgIGtleXM6ICguLi5hcmdzOiBhbnkpID0+IGJhc2Uua2V5cy5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcbiAgICBlbnRyaWVzOiAoLi4uYXJnczogYW55KSA9PiBiYXNlLmVudHJpZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgZm9yRWFjaDogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS5mb3JFYWNoLmFwcGx5KGRpcnR5QWxsKCksIGFyZ3MpLFxuICAgIHZhbHVlczogKC4uLmFyZ3M6IGFueSkgPT4gYmFzZS52YWx1ZXMuYXBwbHkoZGlydHlBbGwoKSwgYXJncyksXG4gICAgW1N5bWJvbC5pdGVyYXRvcl06ICguLi5hcmdzOiBhbnkpID0+IGJhc2VbU3ltYm9sLml0ZXJhdG9yXS5hcHBseShkaXJ0eUFsbCgpLCBhcmdzKSxcblxuICAgIC8vIG11dGF0b3JzXG4gICAgZGVsZXRlOiAoa2V5OiBLKSA9PntcbiAgICAgIG1hcmsoKTtcbiAgICAgIGlmIChmdWxsKSByZXR1cm4gY2FjaGUuZGVsZXRlKGtleSk7XG4gICAgICBjb25zdCBvbGQgPSBjYWNoZS5nZXQoa2V5KTtcbiAgICAgIGlmIChvbGQgPT09IERFTEVURUQpIHJldHVybiBmYWxzZTsgLy8gbm9vcDsgYWxyZWFkeSBtYXJrZWQgYXMgZGVsZXRlZFxuICAgICAgY29uc3QgaW5jYWNoZSA9IG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKCFiYXNlLmhhcyhrZXkpKSB7XG4gICAgICAgIC8vIGtleSBub3QgaW4gYmFzZTogaXMgaXQgbmV3bHkgYWRkZWQgdG8gY2FjaGUsIG9yIHRvdGFsbHkgbWlzc2luZz9cbiAgICAgICAgaWYgKCFpbmNhY2hlKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGNhY2hlLmRlbGV0ZShrZXkpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIC8vIGtleSBpcyBpbiBiYXNlOyBhZGQgYSBuZXcgZGVsZXRpb24gbWFya2VyXG4gICAgICBjYWNoZS5zZXQoa2V5LCBERUxFVEVEKTtcbiAgICAgIG5kZWxldGlvbnMrKztcbiAgICAgIGlmICghaW5jYWNoZSkge1xuICAgICAgICBub3ZlcmxhcCsrO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICBnZXRPckluc2VydDogKGtleTogSywgZGVmYXVsdFZhbHVlOiBWKSA9PiB7XG4gICAgICBsZXQgb2xkID0gY2FjaGUuZ2V0KGtleSk7XG4gICAgICBpZiAob2xkID09PSBERUxFVEVEKSB7XG4gICAgICAgIC8vIHVuZGVsZXRlIGEgZGVsZXRlZCBrZXlcbiAgICAgICAgY2FjaGUuc2V0KGtleSwgZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgbmRlbGV0aW9ucy0tO1xuICAgICAgICByZXR1cm4gZGVmYXVsdFZhbHVlO1xuICAgICAgfVxuICAgICAgaWYgKG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpKSByZXR1cm4gb2xkO1xuICAgICAgLy8gbm90IGluIGNhY2hlOyBjaGVjayBiYXNlXG4gICAgICBvbGQgPSBiYXNlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCAhPT0gdW5kZWZpbmVkIHx8IGJhc2UuaGFzKGtleSkpIHJldHVybiBvbGQ7XG4gICAgICAvLyBub3QgaW4gYmFzZSBlaXRoZXI7IGRvIGFuIGluc2VydFxuICAgICAgbWFyaygpO1xuICAgICAgY2FjaGUuc2V0KGtleSwgZGVmYXVsdFZhbHVlKTtcbiAgICAgIHJldHVybiBkZWZhdWx0VmFsdWU7XG4gICAgfSxcbiAgICBnZXRPckluc2VydENvbXB1dGVkOiAoa2V5OiBLLCBjYWxsYmFjazogKGtleTogSykgPT4gVikgPT4ge1xuICAgICAgbGV0IG9sZCA9IGNhY2hlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCA9PT0gREVMRVRFRCkge1xuICAgICAgICAvLyB1bmRlbGV0ZSBhIGRlbGV0ZWQga2V5XG4gICAgICAgIGNvbnN0IHZhbHVlID0gY2FsbGJhY2soa2V5KTtcbiAgICAgICAgY2FjaGUuc2V0KGtleSwgdmFsdWUpO1xuICAgICAgICBuZGVsZXRpb25zLS07XG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChvbGQgIT09IHVuZGVmaW5lZCB8fCBjYWNoZS5oYXMoa2V5KSkgcmV0dXJuIG9sZDtcbiAgICAgIC8vIG5vdCBpbiBjYWNoZTsgY2hlY2sgYmFzZVxuICAgICAgb2xkID0gYmFzZS5nZXQoa2V5KTtcbiAgICAgIGlmIChvbGQgIT09IHVuZGVmaW5lZCB8fCBiYXNlLmhhcyhrZXkpKSByZXR1cm4gb2xkO1xuICAgICAgLy8gbm90IGluIGJhc2UgZWl0aGVyOyBkbyBhbiBpbnNlcnRcbiAgICAgIG1hcmsoKTtcbiAgICAgIGNvbnN0IHZhbHVlID0gY2FsbGJhY2soa2V5KTtcbiAgICAgIGNhY2hlLnNldChrZXksIHZhbHVlKTtcbiAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9LFxuICAgIHNldDogKGtleTogSywgdmFsdWU6IFYpID0+IHtcbiAgICAgIG1hcmsoKTtcbiAgICAgIGNvbnN0IG9sZCA9IGNhY2hlLmdldChrZXkpO1xuICAgICAgaWYgKG9sZCA9PT0gREVMRVRFRCkgbmRlbGV0aW9ucy0tO1xuICAgICAgY29uc3QgaW5jYWNoZSA9IG9sZCAhPT0gdW5kZWZpbmVkIHx8IGNhY2hlLmhhcyhrZXkpO1xuICAgICAgaWYgKCFpbmNhY2hlICYmIGJhc2UuaGFzKGtleSkpIG5vdmVybGFwKys7XG4gICAgICBjYWNoZS5zZXQoa2V5LCB2YWx1ZSk7XG4gICAgICAvLyBkb24ndCByZXR1cm4gdGhlIGNhY2hlIG9yIHRoZSBiYXNlOyByZXR1cm4gdGhlIGNvcHktb24td3JpdGUgcHJveHlcbiAgICAgIHJldHVybiBwcm94eTtcbiAgICB9LFxuICB9O1xuICBPYmplY3Quc2V0UHJvdG90eXBlT2YoY293TWFwTWV0aG9kcywgbnVsbCk7XG5cbiAgcHJveHkgPSBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBzZXQoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlTWFwXCIpO1xuICAgIH0sXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuIGNvcHk7XG4gICAgICBpZiAocHJvcCA9PT0gcmVjb3ZlclN5bSkgcmV0dXJuIHJjdnI7XG5cbiAgICAgIGlmIChwcm9wID09PSBcInNpemVcIikgcmV0dXJuIHNpemUoKTtcblxuICAgICAgLy8gZ2V0IG1ldGhvZHNcbiAgICAgIGNvbnN0IG1ldGhvZCA9IGNvd01hcE1ldGhvZHNbcHJvcF07XG4gICAgICBpZiAobWV0aG9kKSByZXR1cm4gbWV0aG9kO1xuXG4gICAgICBjb25zdCB2YWx1ZSA9IChiYXNlIGFzIGFueSlbcHJvcF07XG4gICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICByZXR1cm4gKC4uLmFyZ3M6IGFueSkgPT4gdmFsdWUuYXBwbHkoY2FjaGUsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICAvLyB3ZSBkb24ndCBzdXBwb3J0IGN1c3RvbSBvd24gcHJvcGVydGllcyBvciBwcm90b3R5cGVzLCBzbyB0aGlzIGlzIHN1ZmZpY2llbnRcbiAgICAgIHJldHVybiBwcm9wIGluIGNhY2hlO1xuICAgIH0sXG5cbiAgICBvd25LZXlzKCkge1xuICAgICAgLy8gd2UgZG9uJ3Qgc3VwcG9ydCBjdXN0b20gb3duIHByb3BlcnRpZXNcbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcblxuICByZXR1cm4gcHJveHk7XG59XG5cbmZ1bmN0aW9uIGNvcHlPbldyaXRlU2V0PEs+KGJhc2U6IFNldDxLPiwgcGFyZW50PzogKCkgPT4gdm9pZCkge1xuICAvLyBzaW5jZSB3ZSBoYXZlIG5vIGNoaWxkIGNvdyBvYmplY3RzLCBhcyBzb29uIGFzIHdlIGdldCBhbiB1cGRhdGUgd2UgZG8gYSBmdWxsIGNvcHkgYW5kIHVzZSB0aGF0XG4gIGxldCBjYWNoZTogU2V0PEs+IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG4gIHJldHVybiBuZXcgUHJveHkoYmFzZSwge1xuICAgIGRlZmluZVByb3BlcnR5KCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwibm90IHN1cHBvcnRlZCBieSBjb3B5T25Xcml0ZVwiKTtcbiAgICB9LFxuXG4gICAgZGVsZXRlUHJvcGVydHkoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBnZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBzZXQoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJub3Qgc3VwcG9ydGVkIGJ5IGNvcHlPbldyaXRlU2V0XCIpO1xuICAgIH0sXG5cbiAgICBnZXQoXywgcHJvcDogYW55KSB7XG4gICAgICBpZiAocHJvcCA9PT0gY29weVN5bSkgcmV0dXJuICgpID0+IGRlZXBDb3B5KGNhY2hlID8/IGJhc2UpO1xuICAgICAgaWYgKHByb3AgPT09IHJlY292ZXJTeW0pIHJldHVybiAoKSA9PiBjYWNoZSA/PyBiYXNlO1xuXG4gICAgICBpZiAocHJvcCA9PT0gXCJhZGRcIiB8fCBwcm9wID09PSBcImRlbGV0ZVwiIHx8IHByb3AgPT09IFwiY2xlYXJcIikge1xuICAgICAgICBpZiAoY2FjaGUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIC8vIGJyZWFrIHRoZSBnbGFzc1xuICAgICAgICAgIGNhY2hlID0gbmV3IFNldChiYXNlKTtcbiAgICAgICAgICBpZihwYXJlbnQpIHBhcmVudCgpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZhbHVlID0gKChjYWNoZSA/PyBiYXNlKSBhcyBhbnkpW3Byb3BdO1xuICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRnVuY3Rpb24pIHtcbiAgICAgICAgcmV0dXJuICguLi5hcmdzOiBhbnkpID0+IHZhbHVlLmFwcGx5KGNhY2hlID8/IGJhc2UsIGFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0sXG5cbiAgICBoYXMoXywgcHJvcDogYW55KSB7XG4gICAgICAvLyB3ZSBkb24ndCBzdXBwb3J0IGN1c3RvbSBvd24gcHJvcGVydGllcyBvciBwcm90b3R5cGVzLCBzbyB0aGlzIGlzIHN1ZmZpY2llbnRcbiAgICAgIHJldHVybiBwcm9wIGluIChiYXNlIGFzIGFueSk7XG4gICAgfSxcblxuICAgIG93bktleXMoXykge1xuICAgICAgLy8gd2UgZG9uJ3Qgc3VwcG9ydCBjdXN0b20gb3duIHByb3BlcnRpZXNcbiAgICAgIHJldHVybiBbXTtcbiAgICB9LFxuICB9KTtcbn1cblxuLy8gZnV0dXJlcyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4vKiBBIEZ1dHVyZSBpcyBhIGZ1bmN0aW9uIHRoYXQgeWllbGRzIG5vdGhpbmcsIGlzIHdva2VuIHVwIHdpdGggbm90aGluZywgYW5kIGV2ZW50dWFsbHkgcmV0dXJucyBUICovXG5leHBvcnQgdHlwZSBGdXR1cmU8VD4gPSBHZW5lcmF0b3I8dm9pZCwgVCwgdm9pZD47XG5cbi8qIEEgRnV0dXJlQ29udGV4dCBjb3JyZXNwb25kcyB0byB0aGUgZmlyc3QgZ2VuZXJhdG9yIGluIG91ciBjYWxsc3RhY2suICBUaG91Z2ggaXQgbWF5IGJlIGRlbGVnYXRpbmdcbiAgIHlpZWxkcyB0byBzb21lIGNoaWxkIGdlbmVyYXRvciB0aHJvdWdoIHlpZWxkKiBzdGF0ZW1lbnRzLCB3aGVuIGEgY29uZGl0aW9uIGlzIG1ldCB0byB3YWtlIHVwIHRoZVxuICAgY2hpbGQsIHRoZSAubmV4dCgpIGhhcyB0byBiZSBzZW50IHRvIHRoZSByb290IGdlbmVyYXRvciwgbm90IHRoZSBjaGlsZCAob3IgZ3JhbmRjaGlsZCkuXG5cbiAgIEZ1dHVyZUNvbnRleHQgbWFrZXMgdGhhdCB0cml2aWFsLiAqL1xuZXhwb3J0IGNsYXNzIEZ1dHVyZUNvbnRleHQge1xuICAjY29ybzogR2VuZXJhdG9yO1xuICAjYXdha2U6IGJvb2xlYW4gPSBmYWxzZTtcblxuICBjb25zdHJ1Y3Rvcihjb3JvOiBHZW5lcmF0b3IpIHtcbiAgICB0aGlzLiNjb3JvID0gY29ybztcbiAgfVxuXG4gIHdha2V1cCgpIHtcbiAgICAvLyBkaXNhbGxvdyBjYWxscyB0byB0aGUgYmFzZSB3YWtldXAgZnJvbSBpbnNpZGUgdGhlIGJhc2Ugd2FrZXVwXG4gICAgaWYgKHRoaXMuI2F3YWtlKSByZXR1cm47XG4gICAgdGhpcy4jYXdha2UgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICB0aGlzLiNjb3JvLm5leHQoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy4jYXdha2UgPSBmYWxzZTtcbiAgICB9XG4gIH1cblxuICB0aHJvdyhlOiBFcnJvcikge1xuICAgIC8vIGlmIHdlJ3JlIGFjdHVhbGx5IGluc2lkZSB0aGUgY29ybywgdGhyb3cgdGhlIGVycm9yIG5vd1xuICAgIGlmICh0aGlzLiNhd2FrZSkgdGhyb3coZSk7XG4gICAgdGhpcy4jYXdha2UgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICB0aGlzLiNjb3JvLnRocm93KGUpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLiNhd2FrZSA9IGZhbHNlO1xuICAgIH1cbiAgfVxufVxuXG4vLyBzdG9yYWdlIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbi8vIGFuIGluZGV4ZWRkYi1jb21wYXRpYmxlLCB0cmFuc2FjdGlvbmFsIGtleS12YWx1ZSBzdG9yZSBidWlsdCBhcm91bmQgZ2VuZXJhdG9ycy5cbi8vXG4vLyBBIG5vdGUgYWJvdXQgdHlwaW5nOiB0aGUgU3RvcmFnZSBpbnRlcmZhY2UgbXVzdCByZWNlaXZlIGEgdmFsdWUgd2l0aCAuc2V0KCkgYW5kIHJldHVybiB0aGUgc2FtZVxuLy8gdHlwZSB2YWx1ZSB3aXRoIC5nZXQoKS4gIEl0IG11c3Qgbm90IG1hdHRlciB3aGljaCBpbXBsZW1lbnRhdGlvbiBvZiBTdG9yYWdlIGlzIGluIHVzZS4gIEhvd2V2ZXIsXG4vLyBtb3N0IG9mIHRoZSBhY2Nlc3MgdG8gc3RvcmFnZSBpcyB1bnR5cGVkLiAgU28gc3RvcmFnZSBjYW5ub3QgZ2V0KCkgYW5kIHNldCgpIHRoZSByZWFsIHByb3RvXG4vLyB2YWx1ZXMuICBJbnN0ZWFkLCBhIFN0b3JhZ2UgaW1wbGVtZW50YXRpb24gd2hpY2ggc3RvcmVzIGFueXdoZXJlIG90aGVyIHRoYW4gaW4tbWVtb3J5IG11c3QgZG9cbi8vIHRoZSB0eXBlLXRvLXN0b3JhZ2UgY29udmVyc2lvbiBpbnRlcm5hbGx5LiAgVGhlbiBhbnkgZ2VuZXJhdGVkIHR5cGVkIGdldHRlcnMgYnVpbHQgYXJvdW5kIHRoZVxuLy8gU3RvcmFnZSBpbnRlcmZhY2Ugc2hhbGwgYmUgbWVyZWx5IHR5cGVjYXN0aW5nIHdyYXBwZXJzLlxuXG4vLyBTdG9yYWdlIGlzIHRoZSBpbnRlcmZhY2UgZm9yIGNyZWF0aW5nIHJlYWQgYW5kIHdyaXRlIHRyYW5zYXNjdGlvbnMuICBBbiBpbXBsZW1lbnRhdGlvbiBvZiBTdG9yYWdlXG4vLyBpcyBjYWxsYmFjay1iYXNlZCBhbmQgc2hvdWxkIHN1cHBvcnQgbXVsdGlwbGUgcGFyYWxsZWwgZ2V0cyBhbmQgc2V0cyBhdCB0aGUgQVBJIGxldmVsLCBldmVuIGlmXG4vLyB0aGV5IG11c3QgYmUgc2VyaWFsaXplZCBpbnRlcm5hbGx5LiAgVGhlIHJ1blR4biBmdW5jdGlvbiBpcyB1c2VkIHRvIGNvbnZlcnQgdGhlIGNhbGxiYWNrXG4vLyBpbnRlcmZhY2Ugb2YgV1R4biBhbmQgUlR4biB0byB0aGUgU3RvcmFnZUdlbmVyYXRvciBwcm90b2NvbC5cbmV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZSB7XG4gIHdpdGhXVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+O1xuICB3aXRoUlR4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFJUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPjtcbn1cblxuZXhwb3J0IHR5cGUgU3RvcmFnZVZhbHVlID0ge3ZhbHVlOiB1bmtub3dufSB8IHtlcnI6IEVycm9yfTtcbmV4cG9ydCB0eXBlIFN0b3JhZ2VEb25lID0ge3ZhbHVlOiB0cnVlfSB8IHtlcnI6IEVycm9yfTtcblxuZXhwb3J0IGludGVyZmFjZSBXVHhuIHtcbiAgZ2V0KGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKTogdm9pZDtcbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZDtcbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkO1xufTtcblxuZXhwb3J0IGludGVyZmFjZSBSVHhuIHtcbiAgZ2V0KGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKTogdm9pZDtcbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZDtcbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkO1xufTtcblxuZXhwb3J0IHR5cGUgV1N0b3JhZ2VRdWVzdGlvbiA9IHtcbiAgLy8ga2V5cyB0byBsb29rIHVwXG4gIGdldD86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxuICAvLyBrZXktdmFsdWVzIHRvIHNldFxuICBzZXQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgLy8ga2V5LXZhbHVlcyB0byBkZWxldGVcbiAgZGVsPzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG59O1xuXG5leHBvcnQgdHlwZSBSU3RvcmFnZVF1ZXN0aW9uID0ge1xuICAvLyBrZXlzIHRvIGxvb2sgdXBcbiAgZ2V0PzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG59O1xuXG5leHBvcnQgdHlwZSBTdG9yYWdlQW5zd2VyID0ge1xuICAvLyBrZXktdmFsdWUgbG9va3VwIHJlc3VsdHNcbiAgZ2V0OiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXlzIGRvbmUgc2V0dGluZ1xuICBzZXQ6IFJlY29yZDxzdHJpbmcsIFN0b3JhZ2VEb25lPixcbiAgLy8ga2V5cyBkb25lIGRlbGV0aW5nXG4gIGRlbDogUmVjb3JkPHN0cmluZywgU3RvcmFnZURvbmU+LFxufTtcblxuZXhwb3J0IHR5cGUgV1N0b3JhZ2VHZW5lcmF0b3I8VD4gPSBHZW5lcmF0b3I8V1N0b3JhZ2VRdWVzdGlvbiwgVCwgU3RvcmFnZUFuc3dlcj47XG5leHBvcnQgdHlwZSBSU3RvcmFnZUdlbmVyYXRvcjxUPiA9IEdlbmVyYXRvcjxSU3RvcmFnZVF1ZXN0aW9uLCBULCBTdG9yYWdlQW5zd2VyPjtcblxuLy8gZnVuY3Rpb24gdG8gaW50ZXJhY3Qgd2l0aCB0aGUgU3RvcmFnZUdlbmVyYXRvclxuZXhwb3J0IGZ1bmN0aW9uICp0eG5HZXQoa2V5OiBzdHJpbmcpOiBSU3RvcmFnZUdlbmVyYXRvcjx1bmtub3duPntcbiAgY29uc3QgYW5zID0gKHlpZWxkIHtcImdldFwiOiB7W2tleV06IHRydWV9fSkuZ2V0W2tleV07XG4gIGlmIChcImVyclwiIGluIGFucykge1xuICAgIHRocm93IGFucy5lcnI7XG4gIH1cbiAgcmV0dXJuIGFucy52YWx1ZTtcbn1cblxuLy8gYSBmdW5jdGlvbiB0byBpbnRlcmFjdCB3aXRoIHRoZSBTdG9yYWdlR2VuZXJhdG9yXG5leHBvcnQgZnVuY3Rpb24gKnR4blNldChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24pOiBXU3RvcmFnZUdlbmVyYXRvcjx2b2lkPiB7XG4gIGNvbnN0IGFucyA9ICh5aWVsZCB7XCJzZXRcIjoge1trZXldOiB2YWx1ZX19KS5zZXRba2V5XTtcbiAgaWYgKFwiZXJyXCIgaW4gYW5zKSB7XG4gICAgdGhyb3cgYW5zLmVycjtcbiAgfVxufVxuXG4vLyBhIGZ1bmN0aW9uIHRvIGludGVyYWN0IHdpdGggdGhlIFN0b3JhZ2VHZW5lcmF0b3JcbmV4cG9ydCBmdW5jdGlvbiAqdHhuRGVsKGtleTogc3RyaW5nKTogV1N0b3JhZ2VHZW5lcmF0b3I8dm9pZD4ge1xuICBjb25zdCBhbnMgPSAoeWllbGQge1wiZGVsXCI6IHtba2V5XTogdHJ1ZX19KS5kZWxba2V5XTtcbiAgaWYgKFwiZXJyXCIgaW4gYW5zKSB7XG4gICAgdGhyb3cgYW5zLmVycjtcbiAgfVxufVxuXG4vLyBhIGZ1bmN0aW9uIHRvIGhpZGUgc29tZSBvZiB0aGUgYm9pbGVycGxhdGUgb2Ygb3BlbmluZyBhIFdUeG5cbmV4cG9ydCBmdW5jdGlvbiAqd2l0aFdUeG48VD4oXG4gIGZ4OiBGdXR1cmVDb250ZXh0LCBzOiBTdG9yYWdlLCBmbjogKCkgPT4gV1N0b3JhZ2VHZW5lcmF0b3I8VD4sXG4pOiBGdXR1cmU8VD4ge1xuICByZXR1cm4geWllbGQqIHMud2l0aFdUeG4oZngsIGZ1bmN0aW9uKih0eG4pe1xuICAgIHJldHVybiB5aWVsZCogcnVuVHhuKGZ4LCB0eG4sIGZuKCkpO1xuICB9KTtcbn1cblxuLy8gYSBmdW5jdGlvbiB0byBoaWRlIHNvbWUgb2YgdGhlIGJvaWxlcnBsYXRlIG9mIG9wZW5pbmcgYSBSVHhuXG5leHBvcnQgZnVuY3Rpb24gKndpdGhSVHhuPFQ+KFxuICBmeDogRnV0dXJlQ29udGV4dCwgczogU3RvcmFnZSwgZm46ICgpID0+IFJTdG9yYWdlR2VuZXJhdG9yPFQ+LFxuKTogRnV0dXJlPFQ+IHtcbiAgcmV0dXJuIHlpZWxkKiBzLndpdGhSVHhuKGZ4LCBmdW5jdGlvbioodHhuKXtcbiAgICByZXR1cm4geWllbGQqIHJ1blR4bihmeCwgdHhuLCBmbigpKTtcbiAgfSk7XG59XG5cbi8vIHJ1biBhIFN0b3JhZ2VHZW5lcmF0b3IgdG8gY29tcGxldGlvbiwgY29udmVydGluZyBwb3RlbnRpYWxseSBtYW55IHBhcmFsbGVsIGNhbGxiYWNrcyBpbnRvIGFcbi8vIGdlbmVyYXRvciBpbnRlcmZhY2UuXG5mdW5jdGlvbiAqcnVuVHhuPFQ+KFxuICBmeDogRnV0dXJlQ29udGV4dCwgdHhuOiBXVHhuLCBnOiBXU3RvcmFnZUdlbmVyYXRvcjxUPixcbik6IEZ1dHVyZTxUPiB7XG4gIC8vIGlnbm9yZSBsYXRlIGNhbGxiYWNrc1xuICBsZXQgdmFsaWQgPSB0cnVlO1xuICB0cnkge1xuICAgIGxldCBhbnM6IFN0b3JhZ2VBbnN3ZXIgPSB7Z2V0OiB7fSwgc2V0OiB7fSwgZGVsOiB7fX07XG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBnLm5leHQoYW5zKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgIGFucyA9IHtnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICAgIHJlYWR5ID0gZmFsc2U7XG5cbiAgICAgIC8vIHN0YXJ0IGdldHNcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLmdldCA/PyB7fSkpIHtcbiAgICAgICAgdHhuLmdldChrZXksIChyZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAoIXZhbGlkKSByZXR1cm47ICAvLyBpZ25vcmUgbGF0ZSBjYWxsYmFja1xuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHJlc3VsdDtcbiAgICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICAgICAgZngud2FrZXVwKCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBzdGFydCBzZXRzXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUuc2V0ID8/IHt9KSkge1xuICAgICAgICB0eG4uc2V0KGtleSwgdmFsLCAocmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKCF2YWxpZCkgcmV0dXJuOyAgLy8gaWdub3JlIGxhdGUgY2FsbGJhY2tcbiAgICAgICAgICBhbnMuc2V0W2tleV0gPSByZXN1bHQ7XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICAgIGZ4Lndha2V1cCgpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gc3RhcnQgZGVsZXRlc1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuZGVsID8/IHt9KSkge1xuICAgICAgICB0eG4uZGVsKGtleSwgKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGlmICghdmFsaWQpIHJldHVybjsgIC8vIGlnbm9yZSBsYXRlIGNhbGxiYWNrXG4gICAgICAgICAgYW5zLmRlbFtrZXldID0gcmVzdWx0O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICBmeC53YWtldXAoKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIHdhaXQgZm9yIGEgcmVzdWx0XG4gICAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgdmFsaWQgPSBmYWxzZTtcbiAgfVxufVxuXG50eXBlIFN0b3JhZ2VDb2RlcnMgPSB7XG4gIGVuY29kZXI6IChrZXk6IHN0cmluZywgdmFsOiB1bmtub3duKSA9PiB1bmtub3duLFxuICBkZWNvZGVyOiAoa2V5OiBzdHJpbmcsIHZhbDogdW5rbm93bikgPT4gdW5rbm93bixcbn07XG5cbmV4cG9ydCBjbGFzcyBJbmRleGVkREJTdG9yYWdlIHtcbiAgI2RiOiBJREJEYXRhYmFzZTtcbiAgI3N0b3JlOiBzdHJpbmc7XG4gICNjb2RlcnM6IFN0b3JhZ2VDb2RlcnM7XG5cbiAgY29uc3RydWN0b3IoZGI6IElEQkRhdGFiYXNlLCBzdG9yZTogc3RyaW5nLCBjb2RlcnM6IFN0b3JhZ2VDb2RlcnMpIHtcbiAgICB0aGlzLiNkYiA9IGRiO1xuICAgIHRoaXMuI3N0b3JlID0gc3RvcmU7XG4gICAgdGhpcy4jY29kZXJzID0gY29kZXJzXG4gIH1cblxuICAqI3dpdGhUeG48VD4oXG4gICAgZng6IEZ1dHVyZUNvbnRleHQsIG1vZGU6IElEQlRyYW5zYWN0aW9uTW9kZSwgZm46ICh0eG46IFdUeG4pID0+IEZ1dHVyZTxUPixcbiAgKTogRnV0dXJlPFQ+IHtcbiAgICAvLyBjcmVhdGUgdGhlIHRyYW5zYWN0aW9uXG4gICAgbGV0IHJlYWR5ID0gZmFsc2U7XG4gICAgY29uc3QgdHhuID0gdGhpcy4jZGIudHJhbnNhY3Rpb24oW3RoaXMuI3N0b3JlXSwgbW9kZSk7XG4gICAgdHhuLm9uZXJyb3IgPSAoLypldmVudCovKSA9PiB7XG4gICAgICAvLyBub2JvZHkgdG8gc2VuZCB0aGUgZXJyb3IgdG8sIHNvIGp1c3QgY3Jhc2ggdGhlIGNvcm91dGluZVxuICAgICAgZngudGhyb3cobmV3IEVycm9yKFwidHhuIGZhaWxlZFwiKSk7XG4gICAgfTtcbiAgICB0eG4ub25hYm9ydCA9ICgvKmV2ZW50Ki8pID0+IHtcbiAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgIGZ4Lndha2V1cCgpO1xuICAgIH07XG4gICAgdHhuLm9uY29tcGxldGUgPSAoLypldmVudCovKSA9PiB7XG4gICAgICByZWFkeSA9IHRydWU7XG4gICAgICBmeC53YWtldXAoKTtcbiAgICB9O1xuICAgIGNvbnN0IHN0b3JlID0gdHhuLm9iamVjdFN0b3JlKHRoaXMuI3N0b3JlKTtcbiAgICBjb25zdCBpbmRleGVkREJUeG4gPSBuZXcgSW5kZXhlZERCVHhuKHN0b3JlLCB0aGlzLiNjb2RlcnMpO1xuXG4gICAgLy8gcnVuIHRoZSB1c2VyIGZ1bmN0aW9uXG4gICAgbGV0IHJlc3VsdDogVDtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0geWllbGQqIGZuKGluZGV4ZWREQlR4bik7XG4gICAgfSBjYXRjaCAoZTogdW5rbm93bikge1xuICAgICAgdHhuLmFib3J0KCk7XG4gICAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICAgIHR4bi5jb21taXQoKTtcbiAgICB3aGlsZSAoIXJlYWR5KSB5aWVsZDtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgKndpdGhXVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZngsIFwicmVhZHdyaXRlXCIsIGZuKTtcbiAgfVxuXG4gICp3aXRoUlR4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFJUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPiB7XG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiN3aXRoVHhuKGZ4LCBcInJlYWRvbmx5XCIsIGZuKTtcbiAgfVxufVxuXG5jbGFzcyBJbmRleGVkREJUeG4ge1xuICAjc3RvcmU6IElEQk9iamVjdFN0b3JlO1xuICAjY29kZXJzOiBTdG9yYWdlQ29kZXJzO1xuXG4gIGNvbnN0cnVjdG9yKHN0b3JlOiBJREJPYmplY3RTdG9yZSwgY29kZXJzOiBTdG9yYWdlQ29kZXJzKSB7XG4gICAgdGhpcy4jc3RvcmUgPSBzdG9yZTtcbiAgICB0aGlzLiNjb2RlcnMgPSBjb2RlcnM7XG4gIH1cblxuICBnZXQoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBjb25zdCByZXEgPSB0aGlzLiNzdG9yZS5nZXQoa2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0aGlzLiNjb2RlcnMuZGVjb2RlcihrZXksIHJlcS5yZXN1bHQpfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIGxvb2sgdXAgXCIke2tleX1cImApfSk7XG4gICAgfTtcbiAgfVxuXG4gIHNldChrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGNvbnN0IHJlcSA9IHRoaXMuI3N0b3JlLnB1dCh0aGlzLiNjb2RlcnMuZW5jb2RlcihrZXksIHZhbHVlKSwga2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIHNldCBcIiR7a2V5fVwiYCl9KTtcbiAgICB9O1xuICB9XG5cbiAgZGVsKGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBjb25zdCByZXEgPSB0aGlzLiNzdG9yZS5kZWxldGUoa2V5KTtcbiAgICByZXEub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gICAgfTtcbiAgICByZXEub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNiKHtlcnI6IG5ldyBFcnJvcihgZmFpbGVkIHRvIGRlbGV0ZSBcIiR7a2V5fVwiYCl9KTtcbiAgICB9O1xuICB9XG59XG5cbi8vIEluTWVtb3J5U3RvcmFnZSBkb2VzIG5vdCByZXF1aXJlIGFueSBTdG9yYWdlQ29kZXJzIGJlY2F1c2UgaXQgbmV2ZXIgZW5jb2RlcyBvciBkZWNvZGVzLlxuZXhwb3J0IGNsYXNzIEluTWVtU3RvcmFnZSB7XG4gICNkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA7XG5cbiAgY29uc3RydWN0b3IoZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgdGhpcy4jZGF0YSA9IGRhdGEgIT09IHVuZGVmaW5lZCA/IGRhdGEgOiB7fTtcbiAgfVxuXG4gICojd2l0aFR4bjxUPihmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICBjb25zdCB1cGRhdGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgIGNvbnN0IHR4biA9IG5ldyBJbk1lbVR4bih0aGlzLiNkYXRhLCB1cGRhdGVzKTtcbiAgICAvLyBhYm9ydCBjYXNlIGlzIHRoYXQgd2UgZG9uJ3QgY2F0Y2ggdGhlIGV4Y2VwdGlvbiBoZXJlOlxuICAgIGNvbnN0IHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgIC8vIGNvbW1pdCBjYXNlXG4gICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKHVwZGF0ZXMpKSB7XG4gICAgICBpZiAodmFsID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZGVsZXRlIHRoaXMuI2RhdGFba2V5XTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuI2RhdGFba2V5XSA9IHZhbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gICp3aXRoV1R4bjxUPihfZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBXVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmbik7XG4gIH1cblxuICAqd2l0aFJUeG48VD4oX2Z4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogUlR4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZm4pO1xuICB9XG59XG5cbmNsYXNzIEluTWVtVHhuIHtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAjdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgY29uc3RydWN0b3IoZGF0YTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHVwZGF0ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgdGhpcy4jZGF0YSA9IGRhdGE7XG4gICAgdGhpcy4jdXBkYXRlcyA9IHVwZGF0ZXM7XG4gIH1cblxuICBnZXQoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICBpZiAoa2V5IGluIHRoaXMuI3VwZGF0ZXMpIHtcbiAgICAgIGNiKHt2YWx1ZTogdGhpcy4jdXBkYXRlc1trZXldfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNiKHt2YWx1ZTogdGhpcy4jZGF0YVtrZXldfSk7XG4gICAgfVxuICB9XG5cbiAgc2V0KGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy4jdXBkYXRlc1trZXldID0gdmFsdWU7XG4gICAgY2Ioe3ZhbHVlOiB0cnVlfSk7XG4gIH1cblxuICBkZWwoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMuI3VwZGF0ZXNba2V5XSA9IHVuZGVmaW5lZDtcbiAgICBjYih7dmFsdWU6IHRydWV9KTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgT3ZlcmxheVN0b3JhZ2Uge1xuICAjYmFzZTogU3RvcmFnZTtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgY29uc3RydWN0b3IoYmFzZTogU3RvcmFnZSkge1xuICAgIHRoaXMuI2Jhc2UgPSBiYXNlO1xuICB9XG5cbiAga2V5cygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRoaXMuI2RhdGEpO1xuICB9XG5cbiAgKiN3aXRoVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICAvLyByZWdhcmRsZXNzIG9mIHJlYWQvd3JpdGUgc3RhdHVzIG9uIHRoZSBvdmVybGF5IHR4biwgd2Ugb25seSBldmVyIG9wZW4gYSByZWFkIHR4biBvbiAjYmFzZVxuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jYmFzZS53aXRoUlR4bihmeCwgZnVuY3Rpb24qKGJhc2VUeG4pe1xuICAgICAgY29uc3QgdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgICAgIGNvbnN0IHR4biA9IG5ldyBPdmVybGF5VHhuKGJhc2VUeG4sIHNlbGYuI2RhdGEsIHVwZGF0ZXMpO1xuICAgICAgLy8gYWJvcnQgY2FzZSBpcyB0aGF0IHdlIGRvbid0IGNhdGNoIHRoZSBleGNlcHRpb24gaGVyZTpcbiAgICAgIGNvbnN0IHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgICAgLy8gY29tbWl0IGNhc2VcbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsXSBvZiBPYmplY3QuZW50cmllcyh1cGRhdGVzKSkge1xuICAgICAgICAvLyBub3RlOiB3ZSBtdXN0IGtlZXAgdW5kZWZpbmVkIHZhbHVlcyByYXRoZXIgdGhhbiBwcm9wYWdhdGUgZGVsZXRpb25zIHRvIGJhc2VcbiAgICAgICAgc2VsZi4jZGF0YVtrZXldID0gdmFsO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9KTtcbiAgfVxuXG4gICp3aXRoV1R4bjxUPihmeDogRnV0dXJlQ29udGV4dCwgZm46ICh0eG46IFdUeG4pID0+IEZ1dHVyZTxUPik6IEZ1dHVyZTxUPiB7XG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiN3aXRoVHhuKGZ4LCBmbik7XG4gIH1cblxuICAqd2l0aFJUeG48VD4oZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBSVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmeCwgZm4pO1xuICB9XG59XG5cbmNsYXNzIE92ZXJsYXlUeG4ge1xuICAjYmFzZTogUlR4bjtcbiAgI2RhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAjdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj5cblxuICBjb25zdHJ1Y3RvcihiYXNlOiBSVHhuLCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgdXBkYXRlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgICB0aGlzLiNiYXNlID0gYmFzZTtcbiAgICB0aGlzLiNkYXRhID0gZGF0YTtcbiAgICB0aGlzLiN1cGRhdGVzID0gdXBkYXRlcztcbiAgfVxuXG4gIGdldChrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VWYWx1ZSkgPT4gdm9pZCk6IHZvaWQge1xuICAgIGlmIChrZXkgaW4gdGhpcy4jdXBkYXRlcykge1xuICAgICAgY2Ioe3ZhbHVlOiB0aGlzLiN1cGRhdGVzW2tleV19KTtcbiAgICB9IGVsc2UgaWYgKGtleSBpbiB0aGlzLiNkYXRhKSB7XG4gICAgICBjYih7dmFsdWU6IHRoaXMuI2RhdGFba2V5XX0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLiNiYXNlLmdldChrZXksIGNiKTtcbiAgICB9XG4gIH1cblxuICBzZXQoa2V5OiBzdHJpbmcsIHZhbHVlOiB1bmtub3duLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpOiB2b2lkIHtcbiAgICB0aGlzLiN1cGRhdGVzW2tleV0gPSB2YWx1ZTtcbiAgICBjYih7dmFsdWU6IHRydWV9KTtcbiAgfVxuXG4gIGRlbChrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKTogdm9pZCB7XG4gICAgdGhpcy4jdXBkYXRlc1trZXldID0gdW5kZWZpbmVkO1xuICAgIGNiKHt2YWx1ZTogdHJ1ZX0pO1xuICB9XG59XG5cbi8vXG5cbi8qIEV4dGVybmFsQ2FsbGJhY2tTdG9yYWdlIGltcGxlbWVudHMgc3RvcmFnZSBlbnRpcmVseSB2aWEgY2FsbGJhY2sgZnVuY3Rpb25zLiAqL1xuZXhwb3J0IGNsYXNzIEV4dGVybmFsQ2FsbGJhY2tTdG9yYWdlIHtcbiAgI3R4bjogKHdyaXRhYmxlOiBib29sZWFuLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKSA9PiB1bmtub3duO1xuICAjY29tbWl0OiAodHhuOiB1bmtub3duLCBjYjogKHJlc3VsdDogU3RvcmFnZURvbmUpID0+IHZvaWQpID0+IHZvaWQ7XG4gICNhYm9ydDogKHR4bjogdW5rbm93biwgY2I6ICgpID0+IHZvaWQpID0+IHZvaWQ7XG4gICNnZXQ6ICh0eG46IHVua25vd24sIGtleTogc3RyaW5nLCBjYjogKHJlc3VsdDogU3RvcmFnZVZhbHVlKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAjc2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZDtcbiAgI2RlbDogKHR4bjogdW5rbm93biwga2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICAvLyB0eG4gcmV0dXJucyBhbiBvcGFxdWUgdmFsdWUgdGhhdCBnZXRzIHBhc3NlZCB0byB0aGUgb3RoZXIgY2FsbGJhY2tzXG4gICAgdHhuOiAod3JpdGFibGU6IGJvb2xlYW4sIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpID0+IHVua25vd24sXG4gICAgLy8gY29tbWl0IGNvbW1pdHMgYSB0cmFuc2FjdGlvbiwgb3IgcmV0dXJucyBhbiBlcnJvci5cbiAgICBjb21taXQ6ICh0eG46IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBhYm9ydCBhYm9ydHMgdGhlIHRyYW5zYWN0aW9uLiAgSXQgaXMgbm90IGFsbG93ZWQgdG8gcmV0dXJuIGFuIGVycm9yLlxuICAgIGFib3J0OiAodHhuOiB1bmtub3duLCBjYjogKCkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBnZXQgZ2V0cyBhIHZhbHVlXG4gICAgZ2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VWYWx1ZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBzZXQgc2V0cyBhIHZhbHVlXG4gICAgc2V0OiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgdmFsdWU6IHVua25vd24sIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4gdm9pZCxcbiAgICAvLyBkZWwgZGVsZXRlcyBhIHZhbHVlXG4gICAgZGVsOiAodHhuOiB1bmtub3duLCBrZXk6IHN0cmluZywgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKSA9PiB2b2lkLFxuICApIHtcbiAgICB0aGlzLiN0eG4gPSB0eG47XG4gICAgdGhpcy4jY29tbWl0ID0gY29tbWl0O1xuICAgIHRoaXMuI2Fib3J0ID0gYWJvcnQ7XG4gICAgdGhpcy4jZ2V0ID0gZ2V0O1xuICAgIHRoaXMuI3NldCA9IHNldDtcbiAgICB0aGlzLiNkZWwgPSBkZWw7XG4gIH1cblxuICAqI3dpdGhUeG48VD4oXG4gICAgZng6IEZ1dHVyZUNvbnRleHQsIHdyaXRhYmxlOiBib29sZWFuLCBmbjogKHR4bjogV1R4bikgPT4gRnV0dXJlPFQ+LFxuICApOiBGdXR1cmU8VD4ge1xuICAgIC8vIGNyZWF0ZSB0aGUgdHJhbnNhY3Rpb25cbiAgICBsZXQgdHhuVmFsOiB1bmtub3duO1xuICAgIGxldCB0eG5SZWFkeSA9IGZhbHNlO1xuICAgIHRoaXMuI3R4bih3cml0YWJsZSwgKHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKFwiZXJyXCIgaW4gcmVzdWx0KSB7XG4gICAgICAgIGZ4LnRocm93KHJlc3VsdC5lcnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHhuVmFsID0gcmVzdWx0LnZhbHVlO1xuICAgICAgICB0eG5SZWFkeSA9IHRydWU7XG4gICAgICAgIGZ4Lndha2V1cCgpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHdoaWxlICghdHhuUmVhZHkpIHlpZWxkO1xuXG4gICAgY29uc3QgdHhuOiBXVHhuID0ge1xuICAgICAgZ2V0OiAoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlVmFsdWUpID0+IHZvaWQpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuI2dldCh0eG5WYWwsIGtleSwgY2IpO1xuICAgICAgfSxcbiAgICAgIHNldDogKGtleTogc3RyaW5nLCB2YWx1ZTogdW5rbm93biwgY2I6IChyZXN1bHQ6IFN0b3JhZ2VEb25lKSA9PiB2b2lkKSA9PiB7XG4gICAgICAgIHJldHVybiB0aGlzLiNzZXQodHhuVmFsLCBrZXksIHZhbHVlLCBjYik7XG4gICAgICB9LFxuICAgICAgZGVsOiAoa2V5OiBzdHJpbmcsIGNiOiAocmVzdWx0OiBTdG9yYWdlRG9uZSkgPT4gdm9pZCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy4jZGVsKHR4blZhbCwga2V5LCBjYik7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGxldCByZXN1bHQ6IFQ7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdCA9IHlpZWxkKiBmbih0eG4pO1xuICAgIH0gY2F0Y2ggKGU6IHVua25vd24pIHtcbiAgICAgIC8vIGFib3J0IGFuZCByZS10aHJvdyBlcnJvclxuICAgICAgbGV0IGFib3J0UmVhZHkgPSBmYWxzZTtcbiAgICAgIHRoaXMuI2Fib3J0KHR4blZhbCwgKCkgPT4ge1xuICAgICAgICBhYm9ydFJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgZngud2FrZXVwKCk7XG4gICAgICB9KVxuICAgICAgd2hpbGUoIWFib3J0UmVhZHkpIHlpZWxkO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG5cbiAgICAvLyB0cnkgdG8gY29tbWl0XG4gICAgbGV0IGNvbW1pdFJlYWR5ID0gZmFsc2U7XG4gICAgdGhpcy4jY29tbWl0KHR4blZhbCwgKHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKFwiZXJyXCIgaW4gcmVzdWx0KSB7XG4gICAgICAgIGZ4LnRocm93KHJlc3VsdC5lcnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29tbWl0UmVhZHkgPSB0cnVlO1xuICAgICAgICBmeC53YWtldXAoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB3aGlsZSAoIWNvbW1pdFJlYWR5KSB5aWVsZDtcblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAqd2l0aFdUeG48VD4oZng6IEZ1dHVyZUNvbnRleHQsIGZuOiAodHhuOiBXVHhuKSA9PiBGdXR1cmU8VD4pOiBGdXR1cmU8VD4ge1xuICAgIHJldHVybiB5aWVsZCogdGhpcy4jd2l0aFR4bihmeCwgdHJ1ZSwgZm4pO1xuICB9XG5cbiAgKndpdGhSVHhuPFQ+KGZ4OiBGdXR1cmVDb250ZXh0LCBmbjogKHR4bjogUlR4bikgPT4gRnV0dXJlPFQ+KTogRnV0dXJlPFQ+IHtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI3dpdGhUeG4oZngsIGZhbHNlLCBmbik7XG4gIH1cbn1cblxuLy8gcmVkdWNlcnMgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuZXhwb3J0IHR5cGUgUmVkdWNlclF1ZXN0aW9uID0ge1xuICAvLyBrZXlzIHRvIGxvb2sgdXBcbiAgb2xkPzogUmVjb3JkPHN0cmluZywgdHJ1ZT4sXG4gIC8vIGtleXMgdG8gbG9vayB1cFxuICBnZXQ/OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgLy8ga2V5LXZhbHVlcyB0byBzZXRcbiAgc2V0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIC8vIGtleS12YWx1ZXMgdG8gZGVsZXRlXG4gIGRlbD86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxufTtcblxuZXhwb3J0IHR5cGUgUmVkdWNlckFuc3dlciA9IHtcbiAgb2xkOiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXktdmFsdWUgbG9va3VwIHJlc3VsdHNcbiAgZ2V0OiBSZWNvcmQ8c3RyaW5nLCBTdG9yYWdlVmFsdWU+LFxuICAvLyBrZXlzIGRvbmUgc2V0dGluZ1xuICBzZXQ6IFJlY29yZDxzdHJpbmcsIFN0b3JhZ2VEb25lPixcbiAgLy8ga2V5cyBkb25lIGRlbGV0aW5nXG4gIGRlbDogUmVjb3JkPHN0cmluZywgU3RvcmFnZURvbmU+LFxufTtcblxuZXhwb3J0IHR5cGUgUmVkdWNlcjxUPiA9IEdlbmVyYXRvcjxSZWR1Y2VyUXVlc3Rpb24sIFQsIFJlZHVjZXJBbnN3ZXI+O1xuLy8gUmVkdWNlckNvbnRleHQgbG9va3MgbGlrZTpcbi8vIHlpZWxkKiByeC5zZXQucHJvamVjdChrZXksIHZhbCk6IHNldCBuZXcgdmFsdWUgKHlvdSBvbmx5IGdldCB0byBzZXQgaXQgb25jZSBwZXIgdHhuKVxuLy8geWllbGQqIHJ4LmdldC5wcm9qZWN0KGtleSk6IGdldCB0aGUgY3VycmVudCB2YWx1ZSBmb3Iga2V5LCBwb3NzaWJseSBzZXR0aW5nIGl0IGZyb20gb2xkXG4vLyB5aWVsZCogcngub2xkLnByb2plY3Qoa2V5KTogZXhwbGljaXRseSBnZXQgdGhlIG9sZCB2YWx1ZSBmb3Iga2V5XG5cbi8vIHdyYXAgYSBSZWR1Y2VyIHNvIGl0IGFjdHMgbGlrZSBhIFdTdG9yYWdlR2VuZXJhdG9yLCByZXR1cm5pbmcgYSBzZXQgb2YgdXBkYXRlZCBrZXlzXG5leHBvcnQgZnVuY3Rpb24gKnJ1blJlZHVjZXIoZzogUmVkdWNlcjxhbnlbXSB8IHZvaWQ+LCBzaW11bGF0ZT86IGJvb2xlYW4pOiBXU3RvcmFnZUdlbmVyYXRvcjxbc3RyaW5nW10sIGFueVtdXT4ge1xuICAvLyBvdXIgY2FjaGUgb2YgZ2V0J3Mgd2UndmUgYWxyZWFkeSBjb21wbGV0ZWRcbiAgY29uc3Qgb2xkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gIC8vIG91ciBwbGFubmVkIHNldHMgYW5kIGRlbHMgdGhhdCB3ZSBzdWJtaXQgYXQgdGhlIGVuZFxuICBjb25zdCBjdXI6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuICBmdW5jdGlvbiAqZmluaXNoKHJldFZhbDogYW55W10pOiBXU3RvcmFnZUdlbmVyYXRvcjxbc3RyaW5nW10sIGFueVtdXT4ge1xuICAgIGNvbnN0IHVwZGF0ZXMgPSBbXTtcbiAgICBjb25zdCBxdWVzdGlvbjogV1N0b3JhZ2VRdWVzdGlvbiA9IHtnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhjdXIpKSB7XG4gICAgICBpZiAodiA9PT0gREVMRVRFRCkge1xuICAgICAgICBxdWVzdGlvbi5kZWwhW2tdID0gdHJ1ZTtcbiAgICAgICAgdXBkYXRlcy5wdXNoKGspO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gZGUtY29weU9uV3JpdGUtaWZ5IHRoZSB2YWx1ZVxuICAgICAgICBjb25zdCByID0gcmVjb3Zlcih2KTtcbiAgICAgICAgLy8gZ2V0IHRoZSBvbGQgdmFsdWVcbiAgICAgICAgY29uc3QgbyA9IG9sZFtrXTtcbiAgICAgICAgLy8gZGV0ZWN0IG5vb3BcbiAgICAgICAgaWYgKHIgPT09IG8pIGNvbnRpbnVlO1xuICAgICAgICAvLyBvdGhlcndpc2Ugd3JpdGUgdGhlIHZhbHVlIHRvIHN0b3JhZ2VcbiAgICAgICAgdXBkYXRlcy5wdXNoKGspO1xuICAgICAgICBxdWVzdGlvbi5zZXQhW2tdID0gcjtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gaXMgdGhlcmUgYW55IHN0b3JhZ2UgdXBkYXRlcyB0byBtYWtlP1xuICAgIGlmICh1cGRhdGVzLmxlbmd0aCA9PT0gMCB8fCBzaW11bGF0ZSkgcmV0dXJuIFt1cGRhdGVzLCByZXRWYWxdO1xuICAgIGxldCBudXBkYXRlZCA9IDA7XG4gICAgd2hpbGUgKG51cGRhdGVkIDwgdXBkYXRlcy5sZW5ndGgpIHtcbiAgICAgIC8vIGFjdHVhbGx5IHlpZWxkIHRoZSB3cml0ZSByZXF1ZXN0IHRvIHN0b3JhZ2VcbiAgICAgIGNvbnN0IGFucyA9IHlpZWxkIHF1ZXN0aW9uO1xuICAgICAgLy8gY2hlY2sgZXZlcnkgcmVzdWx0XG4gICAgICBmb3IgKGNvbnN0IFtrLCB2XSBvZiBPYmplY3QuZW50cmllcyhhbnMuc2V0ID8/IHt9KSkge1xuICAgICAgICBpZiAoXCJlcnJcIiBpbiB2KSB0aHJvdyBuZXcgRXJyb3IoYHNldHRpbmcgXCIke2t9XCIgYWZ0ZXIgcmVkdWNlcjogJHt2LmVycn1gKVxuICAgICAgICBudXBkYXRlZCsrO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMoYW5zLmRlbCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKFwiZXJyXCIgaW4gdikgdGhyb3cgbmV3IEVycm9yKGBkZWxldGluZyBcIiR7a31cIiBhZnRlciByZWR1Y2VyOiAke3YuZXJyfWApXG4gICAgICAgIG51cGRhdGVkKys7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbdXBkYXRlcywgcmV0VmFsXTtcbiAgfVxuXG4gIGxldCBhbnM6IFJlZHVjZXJBbnN3ZXIgPSB7b2xkOiB7fSwgZ2V0OiB7fSwgc2V0OiB7fSwgZGVsOiB7fX07XG4gIC8vIGluZmxpZ2h0IGlzIGZvciBnZXRzIHdlIGhhdmUgc3VibWl0dGVkIGJ1dCBoYXZlbid0IHJlY2VpdmVkXG4gIC8vICh5b3UgY2FuIGhhdmUgbWFueSBvbGRzIG9yIGdldHMgaW4gZmxpZ2h0IHNpbXVsdGFuZW91c2x5LCBidXQgb25seSBvbmUgc2V0LCBhbmQgaXQgY2Fubm90IGJlXG4gIC8vICBzaW11bHRhbmVvdXMgd2l0aCBhbnkgZ2V0cylcbiAgbGV0IGluZmxpZ2h0OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAvLyBwZW5kaW5nIGlzIGZvciBhbnN3ZXJzIHdlJ3JlIHRyeWluZyB0byBkZWxpdmVyXG4gIC8vIHtrZXk6IHBlbmRpbmdfb3BzfVxuICBsZXQgcGVuZGluZzogUmVjb3JkPHN0cmluZywge29sZD86IHRydWUsIGdldD86IHRydWV9PiA9IHt9O1xuICBsZXQgc3RvcmFnZVF1ZXN0aW9uOiBXU3RvcmFnZVF1ZXN0aW9uID0ge2dldDoge30sIHNldDoge30sIGRlbDoge319O1xuXG4gIC8vIHJ1biB0aGUgcmVkdWNlciB0byBjb21wbGV0aW9uXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgbGV0IHJlYWR5ID0gdHJ1ZTtcbiAgICB3aGlsZSAocmVhZHkpIHtcbiAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBnLm5leHQoYW5zKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm4geWllbGQqIGZpbmlzaCh2YWx1ZSA/PyBbXSk7XG5cbiAgICAgIGFucyA9IHtvbGQ6IHt9LCBnZXQ6IHt9LCBzZXQ6IHt9LCBkZWw6IHt9fTtcbiAgICAgIHJlYWR5ID0gZmFsc2U7XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLm9sZCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKGtleSBpbiBvbGQpIHtcbiAgICAgICAgICAvLyB3ZSBhbHJlYWR5IGtub3cgdGhpcyBvbmVcbiAgICAgICAgICAvLyBub3RlIHRoYXQgY29weU9uV3JpdGUoKSBpcyBhcHBsaWVkIGluc2lkZSB0aGUgUmVkdWNlckNvbnRleHQ7IG5vdCBoZXJlXG4gICAgICAgICAgYW5zLm9sZFtrZXldID0ge3ZhbHVlOiBvbGRba2V5XX07XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKCFpbmZsaWdodFtrZXldKSB7XG4gICAgICAgICAgaW5mbGlnaHRba2V5XSA9IHRydWU7XG4gICAgICAgICAgc3RvcmFnZVF1ZXN0aW9uLmdldCFba2V5XSA9IHRydWU7XG4gICAgICAgICAgc2V0ZGVmYXVsdChwZW5kaW5nLCBrZXksIHt9KS5vbGQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlLmdldCA/PyB7fSkpIHtcbiAgICAgICAgaWYgKGtleSBpbiBjdXIpIHtcbiAgICAgICAgICAvLyB2YWx1ZSB3YXMgYWxyZWFkeSBzZXRcbiAgICAgICAgICAvLyBUT0RPOiBsZXQgY29weU9uV3JpdGUoKSBmb3JrIGFuIGV4aXN0aW5nIGNvcHlPbldyaXRlIG9iamVjdCwgc28gd2UgZG9uJ3QgaGF2ZSB0b1xuICAgICAgICAgIC8vICAgICAgIG1hdGVyaWFsaXplIHRoZSB1cGRhdGVkIG9iamVjdCB1bnRpbCB3ZSBjYWxsIGZpbmlzaCgpXG4gICAgICAgICAgY29uc3QgY2FjaGVkID0gY3VyW2tleV07XG4gICAgICAgICAgYW5zLmdldFtrZXldID0ge3ZhbHVlOiByZWNvdmVyKGNhY2hlZCAhPT0gREVMRVRFRCA/IGNhY2hlZCA6IHVuZGVmaW5lZCl9O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmIChrZXkgaW4gb2xkKSB7XG4gICAgICAgICAgLy8gd2UgbG9va2VkIHRoaXMgdXAgYmVmb3JlXG4gICAgICAgICAgLy8gbm90ZSB0aGF0IGNvcHlPbldyaXRlKCkgaXMgYXBwbGllZCBpbnNpZGUgdGhlIFJlZHVjZXJDb250ZXh0OyBub3QgaGVyZVxuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHt2YWx1ZTogb2xkW2tleV19O1xuICAgICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIGlmICghaW5mbGlnaHRba2V5XSkge1xuICAgICAgICAgIGluZmxpZ2h0W2tleV0gPSB0cnVlO1xuICAgICAgICAgIHN0b3JhZ2VRdWVzdGlvbi5nZXQhW2tleV0gPSB0cnVlO1xuICAgICAgICAgIHNldGRlZmF1bHQocGVuZGluZywga2V5LCB7fSkuZ2V0ID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUuc2V0ID8/IHt9KSkge1xuICAgICAgICAvLyBqdXN0IHN0b3JlIHRoaXMgaW4gbWVtb3J5IGZvciBub3dcbiAgICAgICAgY3VyW2tleV0gPSB2YWw7XG4gICAgICAgIGFucy5zZXRba2V5XSA9IHt2YWx1ZTogdHJ1ZX07XG4gICAgICAgIHJlYWR5ID0gdHJ1ZTtcbiAgICAgIH1cblxuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuZGVsID8/IHt9KSkge1xuICAgICAgICAvLyBqdXN0IHN0b3JlIHRoaXMgaW4gbWVtb3J5IGZvciBub3dcbiAgICAgICAgY3VyW2tleV0gPSBERUxFVEVEO1xuICAgICAgICBhbnMuZGVsW2tleV0gPSB7dmFsdWU6IHRydWV9O1xuICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gaW50ZXJhY3Qgd2l0aCBzdG9yYWdlIHVudGlsIHdlIGhhdmUgYW4gYW5zd2VyIHRvIHJldHVybiB0byB0aGUgcmVkdWNlcnNcbiAgICB3aGlsZSAoIXJlYWR5KSB7XG4gICAgICBjb25zdCBzdG9yYWdlQW5zd2VyID0geWllbGQgc3RvcmFnZVF1ZXN0aW9uO1xuICAgICAgc3RvcmFnZVF1ZXN0aW9uID0ge2dldDoge30sIHNldDoge30sIGRlbDoge319O1xuXG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbF0gb2YgT2JqZWN0LmVudHJpZXMoc3RvcmFnZUFuc3dlci5nZXQpKSB7XG4gICAgICAgIC8vIGNhY2hlIHN1Y2Nlc3NmdWwgcmVzdWx0c1xuICAgICAgICBpZiAoXCJ2YWx1ZVwiIGluIHZhbCkgb2xkW2tleV0gPSB2YWwudmFsdWU7XG4gICAgICAgIC8vIGRvbmUgd2l0aCB0aGlzIHF1ZXJ5XG4gICAgICAgIGRlbGV0ZSBpbmZsaWdodFtrZXldO1xuICAgICAgICBjb25zdCBwbmQgPSBwZW5kaW5nW2tleV07XG4gICAgICAgIC8vIHdoeSBkaWQgd2UgbmVlZCB0aGlzIGFnYWluP1xuICAgICAgICBpZiAocG5kLm9sZCkge1xuICAgICAgICAgIC8vIG5vdGUgdGhhdCBjb3B5T25Xcml0ZSgpIGlzIGFwcGxpZWQgaW5zaWRlIHRoZSBSZWR1Y2VyQ29udGV4dDsgbm90IGhlcmVcbiAgICAgICAgICBhbnMub2xkW2tleV0gPSB2YWw7XG4gICAgICAgICAgcmVhZHkgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChwbmQuZ2V0KSB7XG4gICAgICAgICAgLy8gbm90ZSB0aGF0IGNvcHlPbldyaXRlKCkgaXMgYXBwbGllZCBpbnNpZGUgdGhlIFJlZHVjZXJDb250ZXh0OyBub3QgaGVyZVxuICAgICAgICAgIGFucy5nZXRba2V5XSA9IHZhbDtcbiAgICAgICAgICByZWFkeSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHBlbmRpbmdba2V5XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuLy8gcXVlcmllcyAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4vKiBFeGFtcGxlIHF1ZXJ5IGZvciBsb2FkaW5nIGFsbCBjb21tZW50cyBpbiBhIHRvcGljOlxuXG4gICAgICBsZXQgbXlUb3BpYyA9IC4uLjtcbiAgICAgIGNvbnN0IHEgPSBmcmFtZXdvcmsubmV3UXVlcnkoZnVuY3Rpb24qKHF4OiBRWCkgPT4ge1xuICAgICAgICBjb25zdCB1dWlkcyA9IHlpZWxkKiBxeC5nZXQudG9waWNDb21tZW50cyhteVRvcGljKTtcbiAgICAgICAgY29uc3QgY29tbWVudHMgPSB7fTtcbiAgICAgICAgY29uc3QgdG9wbGV2ZWxzID0gW107XG4gICAgICAgIGZvciAoY29uc3QgdXVpZCBvZiB1dWlkcykge1xuICAgICAgICAgIGNvbW1lbnRzW3V1aWRdID0geWllbGQqIHF4LmdldC5jb21tZW50cyh1dWlkKTtcbiAgICAgICAgICBpZiAoIWNvbW1lbnQucGFyZW50KSB0b3BsZXZlbHMucHVzaCh1dWlkKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge2NvbW1lbnRzLCB0b3BsZXZlbHN9O1xuICAgICAgfSlcbiovXG5cbi8vIHVzZXItZmFjaW5nIHF1ZXJ5IGFwaVxuZXhwb3J0IGludGVyZmFjZSBRdWVyeTxUPiB7XG4gIC8vIGxhdGVzdCBob2xkcyB0aGUgbW9zdCByZWNlbnQgdmFsdWUgcGFzc2VkIHRvIHN1YnNjcmliZSBjYWxsYmFjay4gIEl0IGlzIHVwZGF0ZWQgaW1tZWRpYXRlbHlcbiAgLy8gYWZ0ZXIgc3Vic2NyaWJlIGNhbGxiYWNrcyBhcmUgbWFkZSwgb24gYSBwZXItUXVlcnkgYmFzaXMuXG4gIGxhdGVzdDogVCB8IHVuZGVmaW5lZDtcbiAgLy8gYXdhaXRSZXN1bHQgaGFzIG5vIGVmZmVjdCB3aGVuIGV4ZWN1dGVkIG91dHNpZGUgb2YgYSBxdWVyeSBmdW5jdGlvblxuICBhd2FpdFJlc3VsdCgpOiBRdWVyeUdlbmVyYXRvcjxUPlxuICAvLyBzdWJzY3JpYmUgcmV0dXJucyBhbiB1bnN1YnNjcmliZSBmdW5jdGlvblxuICBzdWJzY3JpYmUoY2FsbGJhY2s6ICh2YWw6IFQpID0+IHZvaWQpOiAoKSA9PiB2b2lkO1xuICAvLyBzdGFydCB3aWxsIHN0YXJ0IHRoZSBxdWVyeSwgaWYgaXQgd2Fzbid0IGNyZWF0ZWQgd2l0aCBzdGFydD10cnVlLiAgVGhpcyBpcyBtb3N0bHkgZm9yIHdyYXBwZXJzXG4gIC8vIHdyaXR0ZW4gaW4gb3RoZXIgbGFuZ3VhZ2VzLCB3aGVyZSB0aGUgZXZlbnQtbG9vcCB3aWxsIGJlIG1hbmFnZWQgYXV0b21hdGljYWxseSwgYW5kIHRoZSBjYWxsZXJcbiAgLy8gbmVlZHMgYSB3YXkgdG8gY3JlYXRlIHRoZSBxdWVyeSBhbmQgc3Vic2NyaWJlIHRvIGl0IGJlZm9yZSBsZXR0aW5nIGl0IHJ1biB0aGUgZmlyc3QgdGltZS5cbiAgc3RhcnQoKTogdm9pZDtcbiAgLy8gY2xvc2Ugd2lsbCBzdG9wIHRoZSBxdWVyeSBmcm9tIHJ1bm5pbmcgYWdhaW4uXG4gIC8vIERlcGVuZGVudCBxdWVyaWVzIHdoaWNoIGFyZSBub3QgYWxzbyBjbG9zZWQgd2lsbCBzdGFydCBjcmFzaGluZy5cbiAgY2xvc2UoKTogdm9pZDtcbn1cblxuZXhwb3J0IHR5cGUgUXVlcnlRdWVzdGlvbiA9IHtcbiAgLy8gd2hpY2gga2V5cyB0byBsb29rIHVwIGluIHN0b3JhZ2VcbiAgc3RvcmU/OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgLy8gd2hpY2ggcXVlcnkgaWRzIHRvIGF3YWl0IHRoZWlyIHJlc3VsdFxuICBxdWVyeT86IFJlY29yZDxzdHJpbmcsIHRydWU+LFxufTtcblxuZXhwb3J0IHR5cGUgUXVlcnlBbnN3ZXIgPSB7XG4gIC8vIHRoZSB2YWx1ZSBmb3IgZWFjaCBzdG9yYWdlIGxvb2t1cFxuICBzdG9yZTogUmVjb3JkPHN0cmluZywgU3RvcmFnZVZhbHVlPixcbiAgLy8gdGhlIFtyZXN1bHQsIGRpcnR5XSBmb3IgZWFjaCBhc2tlZCBxdWVyeVxuICBxdWVyeTogUmVjb3JkPHN0cmluZywgW3Vua25vd24sIGJvb2xlYW5dPixcbn07XG5cbmV4cG9ydCB0eXBlIFF1ZXJ5R2VuZXJhdG9yPFQ+ID0gR2VuZXJhdG9yPFF1ZXJ5UXVlc3Rpb24sIFQsIFF1ZXJ5QW5zd2VyPjtcblxuZXhwb3J0IHR5cGUgUXVlcnlGdW5jdGlvbjxRWCwgVD4gPSAocXg6IFFYLCBwcmV2OiBUIHwgdW5kZWZpbmVkLCBwcmV2SXNWYWxpZDogYm9vbGVhbikgPT4gUXVlcnlHZW5lcmF0b3I8VD47XG5cbi8vIGdyYXBoLWZhY2luZyBhcGksIHdoaWNoIGhpZGVzIHR5cGluZyBpbmZvIGZyb20gdGhlIGdyYXBoXG5pbnRlcmZhY2UgUXVlcnlXcmFwcGVyPFFYPiB7XG4gIC8vIHRoZSBpZCBvZiB0aGlzIHF1ZXJ5XG4gIGlkOiBzdHJpbmc7XG4gIGNsb3NlZDogYm9vbGVhbjsgLy8gVE9ETzogc29tZWhvdyB1c2UgdGhpcyB0byBmYWlsIGRlcGVuZGVudCBxdWVyaWVzIGFmdGVyIGEgcXVlcnkgaXMgY2xvc2VkXG4gIC8vIHJldHVybnMgYFtyZXN1bHQsIGRpcnR5XWAgaW5kaWNhdGluZyBpZiB0aGUgcmVzdWx0IGFuZCBpZiBpdCBjaGFuZ2VkXG4gIHJ1bihxeDogUVgsIGNvbW1pdEtleXM6IFJlY29yZDxzdHJpbmcsIHRydWU+KTogUXVlcnlHZW5lcmF0b3I8W3Vua25vd24sIGJvb2xlYW5dPjtcbiAgLy8gY2FsbCBzdWJzY3JpYmVycyB3aXRoIHRoZSBsYXRlc3QgcmVzdWx0XG4gIG5vdGlmeSgpOiB2b2lkO1xufVxuXG5jbGFzcyBfUXVlcnk8UVgsIFQ+IHtcbiAgaWQ6IHN0cmluZztcbiAgbGF0ZXN0OiBUIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuICBjbG9zZWQ6IGJvb2xlYW4gPSBmYWxzZTtcblxuICAjc3ViczogKCh2YWw6IFQpID0+IHZvaWQpW10gPSBbXTtcblxuICAvLyB7a2V5OiB0cnVlfVxuICAja2V5RGVwczogUmVjb3JkPHN0cmluZywgdHJ1ZT4gPSB7fTtcbiAgLy8ge3F1ZXJ5X2lkOiB0cnVlfVxuICAjcXVlcnlEZXBzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAjcnVuczogbnVtYmVyID0gMDtcbiAgI3Jlc3VsdDogVCB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcbiAgI2ZuOiAocXg6IFFYLCBwcmV2OiBUIHwgdW5kZWZpbmVkLCBwcmV2SXNWYWxpZDogYm9vbGVhbikgPT4gUXVlcnlHZW5lcmF0b3I8VD47XG4gICNvblN0YXJ0OiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQ7XG5cbiAgY29uc3RydWN0b3IoaWQ6IHN0cmluZywgZm46IFF1ZXJ5RnVuY3Rpb248UVgsIFQ+LCBvblN0YXJ0OiAoKSA9PiB2b2lkKSB7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuI2ZuID0gZm47XG4gICAgdGhpcy4jb25TdGFydCA9IG9uU3RhcnQ7XG4gIH1cblxuICAvLyBwYXJ0IG9mIHB1YmxpYyBhcGlcbiAgKmF3YWl0UmVzdWx0KCk6IFF1ZXJ5R2VuZXJhdG9yPFQ+IHtcbiAgICBpZiAodGhpcy4jb25TdGFydCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY2Fubm90IGF3YWl0IHJlc3VsdCBvZiB1bnN0YXJ0ZWQgUXVlcnlcIik7XG4gICAgfVxuICAgIC8vIGRvbid0IHRyeSB0byBjb29yZGluYXRlIG91ciBvd24gI3Jlc3VsdCB2YXVsZSB3aXRoIHRoZSBncmFwaCBiZWluZyBleGVjdXRlZDsganVzdCB1c2UgdGhpcyBhc1xuICAgIC8vIGFuIGlkaW9tYXRpYyB3YXkgdG8gYXNrIHRoZSBncmFwaCBydW4gZm9yIHRoZSByZXN1bHQgZnJvbSBvdXIgLmlkLlxuICAgIGNvbnN0IGFucyA9IHlpZWxkIHtxdWVyeToge1t0aGlzLmlkXTogdHJ1ZX19O1xuICAgIGNvbnN0IFtyZXN1bHRdID0gYW5zLnF1ZXJ5W3RoaXMuaWRdO1xuICAgIHJldHVybiByZXN1bHQgYXMgVDtcbiAgfVxuXG4gIC8vIHBhcnQgb2YgcHVibGljIGFwaVxuICBzdWJzY3JpYmUoY2FsbGJhY2s6ICh2YWw6IFQpID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgICB0aGlzLiNzdWJzLnB1c2goY2FsbGJhY2spO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICB0aGlzLiNzdWJzID0gdGhpcy4jc3Vicy5maWx0ZXIoKHgpID0+IHggIT09IGNhbGxiYWNrKTtcbiAgICB9O1xuICB9XG5cbiAgc3RhcnQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuY2xvc2VkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjYWxsIHRvIFF1ZXJ5LnN0YXJ0KCkgb24gY2xvc2VkIHF1ZXJ5XCIpO1xuICAgIH1cbiAgICBpZiAodGhpcy4jb25TdGFydCkge1xuICAgICAgdGhpcy4jb25TdGFydCgpO1xuICAgICAgdGhpcy4jb25TdGFydCA9IHVuZGVmaW5lZFxuICAgIH1cbiAgfVxuXG4gIC8vIHBhcnQgb2YgcHVibGljIGFwaVxuICBjbG9zZSgpOiB2b2lkIHtcbiAgICB0aGlzLmNsb3NlZCA9IHRydWU7XG4gIH1cblxuICAqI3Nob3VsZFNraXAoY29tbWl0S2V5czogUmVjb3JkPHN0cmluZywgdHJ1ZT4pOiBRdWVyeUdlbmVyYXRvcjxib29sZWFuPiB7XG4gICAgaWYgKHRoaXMuI3J1bnMgPT09IDEpIHtcbiAgICAgIC8vIHRoaXMgaXMgb3VyIGZpcnN0IHRpbWU7IGFsd2F5cyBydW5cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBjaGVjayBpZiBhIGtleSBkZXBlbmRlbmN5IHdhcyB1cGRhdGVkXG4gICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModGhpcy4ja2V5RGVwcykpIHtcbiAgICAgIGlmIChrZXkgaW4gY29tbWl0S2V5cykgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIGNoZWNrIGlmIGFueSBxdWVyeSBkZXBlbmRlbmN5IGNoYW5nZWQgaXRzIHJlc3VsdFxuICAgIGZvciAoY29uc3QgcWlkIG9mIE9iamVjdC5rZXlzKHRoaXMuI3F1ZXJ5RGVwcykpIHtcbiAgICAgIGNvbnN0IGFucyA9IHlpZWxkIHtcInF1ZXJ5XCI6IHtbcWlkXTogdHJ1ZX19O1xuICAgICAgY29uc3QgWywgZGlydHldID0gYW5zW1wicXVlcnlcIl1bcWlkXTtcbiAgICAgIGlmIChkaXJ0eSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gcGFydCBvZiBncmFwaCBhcGlcbiAgKnJ1bihxeDogUVgsIGNvbW1pdEtleXM6IFJlY29yZDxzdHJpbmcsIHRydWU+KTogUXVlcnlHZW5lcmF0b3I8W3Vua25vd24sIGJvb2xlYW5dPiB7XG4gICAgLy8gc2hpZnQgY3VycmVudCB2YWx1ZXMgdG8gb2xkIHZhbHVlc1xuICAgIGNvbnN0IG9sZFJlc3VsdCA9IHRoaXMuI3Jlc3VsdDtcbiAgICB0aGlzLiNydW5zKys7XG5cbiAgICBpZiAoeWllbGQqIHRoaXMuI3Nob3VsZFNraXAoY29tbWl0S2V5cykpIHtcbiAgICAgIHJldHVybiBbdGhpcy4jcmVzdWx0LCBmYWxzZV1cbiAgICB9XG5cbiAgICAvLyByZWJ1aWxkIGRlcHNcbiAgICB0aGlzLiNrZXlEZXBzID0ge307XG4gICAgdGhpcy4jcXVlcnlEZXBzID0ge307XG5cbiAgICBjb25zdCBnID0gdGhpcy4jZm4ocXgsIG9sZFJlc3VsdCwgdGhpcy4jcnVucyA+IDEpO1xuICAgIGxldCBhbnM6IFF1ZXJ5QW5zd2VyID0ge3F1ZXJ5OiB7fSwgc3RvcmU6IHt9fTtcbiAgICAvLyBydW4gcXVlcnkgZnVuY3Rpb24gdG8gY29tcGxldGlvblxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAvLyBwYXNzIHRoZSBjdXJyZW50IGFuc3dlciB0byB0aGUgY29yb3V0aW5lXG4gICAgICBjb25zdCB7dmFsdWUsIGRvbmV9ID0gZy5uZXh0KGFucyk7XG4gICAgICBpZiAoZG9uZSkge1xuICAgICAgICB0aGlzLiNyZXN1bHQgPSB2YWx1ZTtcbiAgICAgICAgY29uc3QgZGlydHkgPSAodGhpcy4jcnVucyA9PT0gMSkgfHwgKHRoaXMuI3Jlc3VsdCAhPT0gb2xkUmVzdWx0KTtcbiAgICAgICAgcmV0dXJuIFt0aGlzLiNyZXN1bHQsIGRpcnR5XTtcbiAgICAgIH1cbiAgICAgIC8vIGNhcHR1cmUgZGVwZW5kZW5jaWVzIGJlZm9yZSB5aWVsZGluZyB1cCB0byB0aGUgZ3JhcGggZm9yIGFuc3dlcnNcbiAgICAgIC8vIHtzdG9yZToge3N0b3JhZ2Vfa2V5OiB0cnVlfSwgcXVlcnk6IHtxdWVyeV9pZDogdHJ1ZX19XG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyh2YWx1ZS5zdG9yZSA/PyB7fSkpIHtcbiAgICAgICAgdGhpcy4ja2V5RGVwc1trZXldID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgcWlkIG9mIE9iamVjdC5rZXlzKHZhbHVlLnF1ZXJ5ID8/IHt9KSkge1xuICAgICAgICB0aGlzLiNxdWVyeURlcHNbcWlkXSA9IHRydWU7XG4gICAgICB9XG4gICAgICAvLyBsZXQgdGhlIGdyYXBoIHByb3ZpZGUgYW5zd2Vyc1xuICAgICAgYW5zID0geWllbGQgdmFsdWU7XG4gICAgfVxuICB9XG5cbiAgLy8gcGFydCBvZiBncmFwaCBhcGlcbiAgbm90aWZ5KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmNsb3NlZCkgcmV0dXJuO1xuICAgIGZvciAoY29uc3Qgc3ViIG9mIHRoaXMuI3N1YnMpIHtcbiAgICAgIHN1Yih0aGlzLiNyZXN1bHQhKTtcbiAgICB9XG4gICAgdGhpcy5sYXRlc3QgPSB0aGlzLiNyZXN1bHQ7XG4gIH1cbn1cblxuLyogR3JhcGhSdW4gcmVwcmVzZW50cyBvbmUgcnVuIG9mIHRoZSBRdWVyeUdyYXBoLiAgSGF2aW5nIGl0IGFzIGEgc2VwYXJhdGUgb2JqZWN0IHJhdGhlciB0aGFuIGFcbiAgIHNpbmdsZSBnZW5lcmF0b3IgZnVuY3Rpb24gKGFzIGl0IG9uY2Ugd2FzIHdyaXR0ZW4pIGFsbG93cyBhIGdyYXBoIHRvIGJlIGV4dGVuZGVkIGlmIG5ldyBxdWVyaWVzXG4gICBhcnJpdmUgKi9cbmNsYXNzIEdyYXBoUnVuPFFYPiB7XG4gICNxeDogUVg7XG4gIC8vIHtrZXk6IHRydWV9XG4gICNjb21taXRLZXlzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPjtcblxuICAvLyB0aGUgW3Jlc3VsdCwgZGlydHldIG9mIHF1ZXJpZXMgd2hpY2ggaGF2ZSByYW5cbiAgLy8ge3F1ZXJ5X2lkOiBbdmFsdWUsIGRpcnR5XX1cbiAgI3JhbjogUmVjb3JkPHN0cmluZywgW3Vua25vd24sIGJvb2xlYW5dPiA9IHt9O1xuXG4gIGNvbnN0cnVjdG9yKHF4OiBRWCwgY29tbWl0S2V5czogUmVjb3JkPHN0cmluZywgdHJ1ZT4pIHtcbiAgICB0aGlzLiNxeCA9IHF4O1xuICAgIHRoaXMuI2NvbW1pdEtleXMgPSBjb21taXRLZXlzO1xuICB9XG5cbiAgLy8gUnVuIHRoZSBxdWVyeSBncmFwaCB0byBjb21wbGV0aW9uLlxuICAvL1xuICAvLyBydW4oKSBtYXkgYmUgY2FsbGVkIG9uY2UgYWZ0ZXIgY29uc3RydWN0aW9uIGFnYWluc3QgYWxsIGV4aXN0aW5nIHF1ZXJpZXMsIHRoZW4gbWF5IGJlIGNhbGxlZFxuICAvLyBhZGRpdGlvbmFsIHRpbWVzIGFzIG5ldyBxdWVyaWVzIGFyZSBhZGRlZCB0byB0aGUgUXVlcnlHcmFwaC5cbiAgLy8geWllbGRzOiBsaXN0IG9mIGtleXMsIHJldHVybnMgY2FsbGJhY2sgZm9yIHVzZXJzLCByZWNlaXZlczogbWFwIG9mIGtleXMgdG8gdmFsdWVzXG4gICpydW4ocXVlcmllczogUXVlcnlXcmFwcGVyPFFYPltdKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8vIGZyZWV6ZSBjdXJyZW50IHF1ZXJ5IGxpc3QsIGluIGNhc2Ugb3VyIGNhbGxlciBldmVyIGdpdmVzIHVzIHNvbWV0aGluZyB0aGV5IGludGVuZCB0byBtdXRhdGVcbiAgICBxdWVyaWVzID0gWy4uLnF1ZXJpZXNdO1xuXG4gICAgLy8gZXZlcnkgcXVlcnkgd2hpY2ggaXMgY3VycmVudGx5IHJ1bm5pbmdcbiAgICAvLyB7cXVlcnlfaWQ6IGdlbmVyYXRvcn1cbiAgICBjb25zdCBhY3RpdmU6IFJlY29yZDxzdHJpbmcsIFF1ZXJ5R2VuZXJhdG9yPFt1bmtub3duLCBib29sZWFuXT4+ID0ge307XG4gICAgLy8gYSByZWNvcmQgb2Yge3F1ZXJ5X2lkOiBhbnN3ZXJ9IHRvIGZlZWQgdG8gY29yb3V0aW5lc1xuICAgIGxldCBydW5uYWJsZTogUmVjb3JkPHN0cmluZywgUXVlcnlBbnN3ZXI+ID0ge307XG4gICAgLy8gd2hpY2ggcXVlcmllcyBhcmUgdW5ibG9ja2VkIGJ5IGEgZ2l2ZW4gYW5zd2VyXG4gICAgLy8ge2Fuc3dlcl9rZXk6IHF1ZXJ5X2lkW119XG4gICAgY29uc3Qgd2FudEFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZ1tdPiA9IHt9O1xuICAgIC8vIHdoaWNoIHF1ZXJpZXMgYXJlIHVuYmxvY2tlZCBieSBhIGdpdmVuIHF1ZXJ5IHJlc3VsdFxuICAgIC8vIHtxdWVyeV9pZDogcXVlcnlfaWRbXX1cbiAgICBjb25zdCB3YW50UmVzdWx0czogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG5cbiAgICAvLyBzdGFydCBldmVyeSBxdWVyeSBpbiBwYXJhbGxlbFxuICAgIGZvciAoY29uc3QgcSBvZiBxdWVyaWVzKSB7XG4gICAgICBjb25zdCBnID0gcS5ydW4odGhpcy4jcXgsIHRoaXMuI2NvbW1pdEtleXMpO1xuICAgICAgYWN0aXZlW3EuaWRdID0gZztcbiAgICAgIC8vIHByb3ZpZGUgYSBwaG9ueSBmaXJzdCBhbnN3ZXIgdG8gc3RhcnQgdGhlIGdlbmVyYXRvciBvZmZcbiAgICAgIHJ1bm5hYmxlW3EuaWRdID0ge3N0b3JlOiB7fSwgcXVlcnk6IHt9fTtcbiAgICB9XG5cbiAgICAvLyBydW4gdGhlIGdyYXBoIHRvIGNvbXBsZXRpb25cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgLy8gcnVuIHJ1bm5hYmxlcyB1bnRpbCB3ZSBydW4gb3V0OyBlYWNoIHJ1bm5hYmxlIG1heSB1bmxvY2sgb3RoZXIgcnVubmFibGVzXG4gICAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgICBjb25zdCBhbnN3ZXJzID0gT2JqZWN0LmVudHJpZXMocnVubmFibGUpO1xuICAgICAgICBpZiAoYW5zd2Vycy5sZW5ndGggPT09IDApIGJyZWFrO1xuICAgICAgICBydW5uYWJsZSA9IHt9O1xuICAgICAgICBmb3IgKGNvbnN0IFtxaWQsIGFuc10gb2YgYW5zd2Vycykge1xuICAgICAgICAgIGNvbnN0IHt2YWx1ZSwgZG9uZX0gPSBhY3RpdmVbcWlkXS5uZXh0KGFucyk7XG4gICAgICAgICAgaWYgKGRvbmUpIHtcbiAgICAgICAgICAgIC8vIHF1ZXJ5IGZpbmlzaGVkXG4gICAgICAgICAgICBkZWxldGUgYWN0aXZlW3FpZF07XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSB2YWx1ZTtcbiAgICAgICAgICAgIHRoaXMuI3JhbltxaWRdID0gcmVzdWx0O1xuICAgICAgICAgICAgLy8gdW5ibG9jayBhbnlib2R5IHdhaXRpbmcgZm9yIHRoaXMgcmVzdWx0XG4gICAgICAgICAgICBjb25zdCB3YWl0aW5nID0gd2FudFJlc3VsdHNbcWlkXTtcbiAgICAgICAgICAgIGlmICh3YWl0aW5nICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgZGVsZXRlIHdhbnRSZXN1bHRzW3FpZF07XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgaWQgb2Ygd2FpdGluZykge1xuICAgICAgICAgICAgICAgIHNldGRlZmF1bHQocnVubmFibGUsIGlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5xdWVyeVtxaWRdID0gcmVzdWx0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gcXVlcnkgaXMgYmxvY2tlZDsgaGFuZGxlIGl0cyBzdG9yZSBhbmQgcXVlcnkgcXVlc3Rpb25zXG4gICAgICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXModmFsdWUuc3RvcmUgPz8ge30pKSB7XG4gICAgICAgICAgICBzZXRkZWZhdWx0KHdhbnRBbnN3ZXJzLCBrZXksIFtdKS5wdXNoKHFpZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGZvciAoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModmFsdWUucXVlcnkgPz8ge30pKSB7XG4gICAgICAgICAgICAvLyBoYXMgdGhpcyBxdWVyeSByYW4geWV0P1xuICAgICAgICAgICAgaWYgKGlkIGluIHRoaXMuI3Jhbikge1xuICAgICAgICAgICAgICAvLyB3ZSBhbHJlYWR5IGhhdmUgdGhpcyByZXN1bHRcbiAgICAgICAgICAgICAgc2V0ZGVmYXVsdChydW5uYWJsZSwgcWlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5xdWVyeVtpZF0gPSB0aGlzLiNyYW5baWRdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gd2FrZSB0aGlzIHF1ZXJ5IHVwIHdoZW4gdGhlIG90aGVyIHF1ZXJ5IGZpbmlzaGVzXG4gICAgICAgICAgICAgIHNldGRlZmF1bHQod2FudFJlc3VsdHMsIGlkLCBbXSkucHVzaChxaWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBhcmUgd2UgYWxsIGRvbmU/XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYWN0aXZlKS5sZW5ndGggPT09IDApIGJyZWFrO1xuXG4gICAgICAvLyBzZW5kIGFsbCBwZW5kaW5nIHF1ZXN0aW9ucyB0byBzdG9yYWdlXG4gICAgICBjb25zdCBnZXRzOiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMod2FudEFuc3dlcnMpKSB7XG4gICAgICAgIGdldHNba2V5XSA9IHRydWU7XG4gICAgICB9XG4gICAgICBjb25zdCBhbnN3ZXJzID0gKHlpZWxkIHtnZXQ6IGdldHN9KS5nZXQ7XG5cbiAgICAgIC8vIHByb2Nlc3MgYW5zd2Vyc1xuICAgICAgY29uc3QgYW5zd2VyRW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGFuc3dlcnMpO1xuICAgICAgaWYgKGFuc3dlckVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImVtcHR5IGFuc3dlclwiKTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGFuc3dlckVudHJpZXMpe1xuICAgICAgICBmb3IgKGNvbnN0IHFpZCBvZiB3YW50QW5zd2Vyc1trZXldKSB7XG4gICAgICAgICAgc2V0ZGVmYXVsdChydW5uYWJsZSwgcWlkLCB7cXVlcnk6IHt9LCBzdG9yZToge319KS5zdG9yZVtrZXldID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgZGVsZXRlIHdhbnRBbnN3ZXJzW2tleV07XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gcmV0dXJuIGEgY2FsbGJhY2sgdG8gbm90aWZ5IHF1ZXJ5IHN1YnNjcmliZXJzXG4gICAgcmV0dXJuICgpID0+IHtcbiAgICAgIGZvciAoY29uc3QgcSBvZiBxdWVyaWVzKSB7XG4gICAgICAgIGNvbnN0IFssZGlydHldID0gdGhpcy4jcmFuW3EuaWRdO1xuICAgICAgICBpZiAoZGlydHkpIHEubm90aWZ5KCk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxufVxuXG4vKiBRdWVyeUdyYXBoIGlzIHJlc3BvbnNpYmxlIGZvciB0cmFja2luZyBxdWVyaWVzIGdlbmVyYXRlZCBieSB0aGUgVUkgYW5kIHJlcnVubmluZyB0aGVtIHdoZW4gbmV3XG4gICBkYXRhIGlzIHByZXNlbnQuICBJdCB0cmFja3MgZGVwZW5kZW5jaWVzIG9mIGEgcXVlcnkgZnVuY3Rpb24gYnkgaW5qZWN0aW5nIGEgcXVlcnkgY29udGV4dCwgd2hpY2hcbiAgIHByb3ZpZGVzIHRoZSBhY3R1YWwga2V5LXZhbHVlIGxvb2t1cCBjYXBhYmlsaXR5IHRvIHRoZSBmdW5jdGlvbi4gIEl0IGlzIGluZm9ybWVkIG9mIGNoYW5nZXMgdG9cbiAgIHN0b3JhZ2UgYnkgdGhlIE1pZGVuZCwgc3VjaCBhcyBzb21lIGtleXMgYmVpbmcgdXBkYXRlZCBieSB0aGUgVUksIGtleXMgb2YgYW4gb2xkIG92ZXJsYXkgYmVpbmdcbiAgIGRpc2NhcmRlZCwgb3IgbmV3IGZvcmVjYXN0IGRhdGEgZnJvbSB0aGUgVUkgaXRzZWxmLiAqL1xuZXhwb3J0IGNsYXNzIFF1ZXJ5R3JhcGg8UVg+IHtcbiAgI3F4OiBRWDtcbiAgI2RpcnR5OiBSZWNvcmQ8c3RyaW5nLCB0cnVlPiA9IHt9O1xuICAjcXVlcmllczogUmVjb3JkPHN0cmluZywgUXVlcnlXcmFwcGVyPFFYPj4gPSB7fTtcbiAgI25ld1F1ZXJpZXM6IFF1ZXJ5V3JhcHBlcjxRWD5bXSA9IFtdO1xuICAjaWQ6IG51bWJlciA9IDE7XG5cbiAgI3J1bjogR3JhcGhSdW48UVg+O1xuXG4gIGNvbnN0cnVjdG9yKHF4OiBRWCkge1xuICAgIHRoaXMuI3F4ID0gcXg7XG4gICAgLy8gc3RhcnQgd2l0aCBhbiBlbXB0eSBncmFwaHJ1blxuICAgIHRoaXMuI3J1biA9IG5ldyBHcmFwaFJ1bih0aGlzLiNxeCwge30pO1xuICB9XG5cbiAgbmV3UXVlcnk8VD4oZm46IFF1ZXJ5RnVuY3Rpb248UVgsIFQ+LCBtYW51YWxTdGFydDogYm9vbGVhbiwgb25TdGFydDogKCkgPT4gdm9pZCk6IFF1ZXJ5PFQ+IHtcbiAgICBjb25zdCBpZCA9IGAke3RoaXMuI2lkKyt9YDtcbiAgICBjb25zdCBxID0gbmV3IF9RdWVyeShpZCwgZm4sICgpID0+IHtcbiAgICAgIG9uU3RhcnQoKTtcbiAgICAgIHRoaXMuI3F1ZXJpZXNbaWRdID0gcTtcbiAgICAgIHRoaXMuI25ld1F1ZXJpZXMucHVzaChxKTtcbiAgICB9KTtcbiAgICBpZiAoIW1hbnVhbFN0YXJ0KSBxLnN0YXJ0KCk7XG4gICAgcmV0dXJuIHE7XG4gIH1cblxuICBkaXJ0eShrZXlzOiBzdHJpbmdbXSk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcbiAgICAgIHRoaXMuI2RpcnR5W2tleV0gPSB0cnVlO1xuICAgIH1cbiAgfVxuXG4gICpydW4oKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8vIHN0YXJ0IGEgbmV3IGdyYXBoIHJ1blxuICAgIGNvbnN0IGNvbW1pdEtleXMgPSB0aGlzLiNkaXJ0eTtcbiAgICB0aGlzLiNkaXJ0eSA9IHt9O1xuICAgIHRoaXMuI3J1biA9IG5ldyBHcmFwaFJ1bih0aGlzLiNxeCwgY29tbWl0S2V5cyk7XG5cbiAgICAvLyBydW4gYWdhaW5zdCBhbGwgcXVlcmllc1xuICAgIGNvbnN0IHF1ZXJpZXMgPSBPYmplY3QudmFsdWVzKHRoaXMuI3F1ZXJpZXMpO1xuICAgIHRoaXMuI25ld1F1ZXJpZXMgPSBbXTtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI2V4ZWN1dGUocXVlcmllcyk7XG4gIH1cblxuICAqZXh0ZW5kKCk6IFJTdG9yYWdlR2VuZXJhdG9yPCgpID0+IHZvaWQ+IHtcbiAgICAvLyBleHRlbmQgYW4gZXhpc3RpbmcgZ3JhcGggcnVuIHdpdGggb25seSBuZXcgcXVlcmllc1xuICAgIGNvbnN0IHF1ZXJpZXMgPSB0aGlzLiNuZXdRdWVyaWVzO1xuICAgIHRoaXMuI25ld1F1ZXJpZXMgPSBbXTtcbiAgICByZXR1cm4geWllbGQqIHRoaXMuI2V4ZWN1dGUocXVlcmllcyk7XG4gIH1cblxuICAqI2V4ZWN1dGUocXVlcmllczogUXVlcnlXcmFwcGVyPFFYPltdKTogUlN0b3JhZ2VHZW5lcmF0b3I8KCkgPT4gdm9pZD4ge1xuICAgIC8qIFRPRE86IHB1dCBhIGdyYXBoLXdpZGUgc3RvcmFnZSBjYWNoZSBoZXJlLiAgV2UgY2FuIGtlZXAgYSBuZXcgY2FjaGUgYW5kIGFuIG9sZCBjYWNoZS4gIFdoZW5cbiAgICAgICB0aGUgbmV3IGNhY2hlIGlzIGhpdCB3ZSByZXR1cm4gaXQgaW1tZWRpYXRlbHkuICBXaGVuIHRoZSBvbGQgY2FjaGUgaXMgaGl0LCB3ZSBwb3AgZnJvbSBvbGQsXG4gICAgICAgcGxhY2UgaW4gbmV3LCB0aGVuIHJldHVybi4gIFdoZW4gd2Ugc3RhcnQgYSBuZXcgZ3JhcGggcnVuIHdlIGRpc2NhcmQgdGhlIG9sZCBvbGQsIG1ha2UgdGhlXG4gICAgICAgb2xkIG5ldyBpbnRvIHRoZSBuZXcgb2xkLCBhbmQgY3JlYXRlIGEgbmV3LCBlbXB0eSBuZXcuICAgV2UnbGwgbmVlZCBzb21ldGhpbmcgbGlrZSB0aGVcbiAgICAgICB3aGlsZSBsb29wIGluIEdyYXBoUnVuIHRvIHJldHVybiBwYXJ0aWFsIGFuc3dlcnMgdW50aWwgd2UgYXJlIGZ1bGx5IGJsb2NrZWQuXG5cbiAgICAgICBBZGRpdGlvbmFsIGlkZWFzIG1pZ2h0IGJlOlxuICAgICAgICAgLSBncmFudCBpbmRpdmlkdWFsIGxvb2t1cHMgYSBjYWNoZSBjb250cm9sIGZsYWcgKHRydWUvZmFsc2UvdW5kZWZpbmVkKVxuICAgICAgICAgLSBhbGxvdyBjb25maWd1cmluZyB0aGUgZ3JhcGgtd2lkZSBxdWVyeSBkZWZhdWx0IGNhY2hlIGRpc3Bvc2l0aW9uICh0cnVlL2ZhbHNlKVxuICAgICAgICAgLSBtYXliZSBhIGZyZXF1ZW50IHVzZSBjYWNoZSBtb2RlLCB3aGVyZSB3ZSB0cmFjayBzdGF0cyBvZiBrZXkgbG9va3VwIHVzYWdlIGFuZCBjYWNoZVxuICAgICAgICAgICB0aGUgbW9zdCBmcmVxdWVudGx5IHVzZWQga2V5c1xuICAgICAgICAgLSBuYWgsIGp1c3QgbGV0IHRoZSBjYWNoZSBiZSBhIGNvbmZpZ3VyYWJsZSBleHRyYSBsYXllci4gIFRvbyBtYW55IHdheXMgdG8gZG8gaXQuXG4gICAgICAgICAtIHByb2JhYmx5IGZvcmNlIHlvdXJzZWxmIHRvIHNraXAgdGhpcyBmb3Igbm93LlxuICAgICovXG4gICAgcmV0dXJuIHlpZWxkKiB0aGlzLiNydW4ucnVuKHF1ZXJpZXMpO1xuICB9XG59XG5cbi8vIGZyYW1ld29ya3MgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuLy8gRXZlbnQgd3JhcHMgYSBwcm90byB0eXBlIFQgd2l0aCBhIGNsaWVudCBpZC4gIEFuIEV2ZW50IG1heSBoYXZlIG9yaWdpbmF0ZWQgZnJvbSBLdXJyZW50REIsIG9yXG4vLyBpdCBtYXkgaGF2ZSBiZWVuIGVtaXR0ZWQgYnkgYSBmb3JlY2FzdGVyLCBvciBpdCBtYXkgYmUgYSBjb21tYW5kIHdlIGFyZSBhYm91dCB0byBzZW5kLlxuZXhwb3J0IHR5cGUgRXZlbnQ8VD4gPSB7XG4gIGlkOiBzdHJpbmcsXG4gIGRhdGE6IFQsXG59O1xuXG4vLyBSZWFsRXZlbnQgZXh0ZW5kcyBFdmVudCB3aXRoIHN0cmVhbSBwb3NpdGlvbiBkYXRhIHRoYXQgb3JpZ2luYXRlcyBmcm9tIEt1cnJlbnREQi5cbmV4cG9ydCB0eXBlIFJlYWxFdmVudDxUPiA9IEV2ZW50PFQ+ICYge1xuICBwb3NpdGlvbjogbnVtYmVyLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZVJlYWxFdmVudDxUPih2YWw6IGFueSwgc3ViZGVjb2RlcjogKHZhbDogYW55KSA9PiBUKTogUmVhbEV2ZW50PFQ+IHtcbiAgcmV0dXJuIHsgLi4udmFsLCBkYXRhOiBzdWJkZWNvZGVyKHZhbC5kYXRhKSB9IGFzIFJlYWxFdmVudDxUPjtcbn1cblxuZnVuY3Rpb24gbWF0Y2hTZW50PEM+KHRwbDogYW55LCBjbWQ6IEMpOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiB0cGwgIT09IHR5cGVvZiBjbWQpIHJldHVybiBmYWxzZTtcbiAgc3dpdGNoICh0eXBlb2YgdHBsKSB7XG4gICAgY2FzZSBcImJvb2xlYW5cIjpcbiAgICBjYXNlIFwiYmlnaW50XCI6XG4gICAgY2FzZSBcIm51bWJlclwiOlxuICAgIGNhc2UgXCJzdHJpbmdcIjpcbiAgICBjYXNlIFwidW5kZWZpbmVkXCI6XG4gICAgICByZXR1cm4gdHBsID09PSBjbWQ7XG5cbiAgICBjYXNlIFwiZnVuY3Rpb25cIjpcbiAgICAgIHJldHVybiB0cGwoY21kKTtcblxuICAgIGNhc2UgXCJvYmplY3RcIjpcbiAgICAgIC8vIG51bGwgaGFuZGxlZCBoZXJlXG4gICAgICBpZiAodHBsID09PSBudWxsKSByZXR1cm4gY21kID09PSBudWxsO1xuICAgICAgLy8gZ2VuZXJhbCBvYmplY3RzIGhhbmRsZWQgYmVsb3dcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcInN5bWJvbFwiOlxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG1hcmsgb2YgdHlwZSBcIiR7dHlwZW9mIHRwbH1cIiBub3QgaGFuZGxlZCBieSBtYXRjaFNlbnRgKTtcbiAgfVxuXG4gIGlmIChBcnJheS5pc0FycmF5KHRwbCkpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY21kKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0cGwubGVuZ3RoICE9PSBjbWQubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRwbC5ldmVyeSgodiwgaSkgPT4gbWF0Y2hTZW50KHYsIGNtZFtpXSkpO1xuICB9XG5cbiAgaWYgKHRwbCBpbnN0YW5jZW9mIE1hcCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgbWFyayBvZiB0eXBlIE1hcCBub3QgaGFuZGxlZCBieSBtYXRjaFNlbnRgKTtcbiAgfVxuICBpZiAodHBsIGluc3RhbmNlb2YgU2V0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBtYXJrIG9mIHR5cGUgU2V0IG5vdCBoYW5kbGVkIGJ5IG1hdGNoU2VudGApO1xuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKHRwbCkuZXZlcnkoKFtrLCB2XSkgPT4gbWF0Y2hTZW50KHYsIChjbWQgYXMgUmVjb3JkPHN0cmluZywgYW55Pilba10pKTtcbn1cblxuLy8gXCJSXCJlZHVjZXJDb250ZVwieFwidFxuLy8gXCJRXCJ1ZXJ5Q29udGVcInhcInRcbi8vIFwiRVwidmVudHNcbi8vIFwiQ1wib21tYW5kc1xuZXhwb3J0IGNsYXNzIEZyYW1ld29yazxRWCwgUlgsIEUsIEM+IHtcbiAgI3J4OiBSWDtcbiAgI3N0b3JhZ2U6IFN0b3JhZ2U7XG4gICNkZWNvZGVFdmVudDogKHJhdzogYW55KSA9PiBFO1xuICAjbWlncmF0ZTogbnVsbCB8ICgocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+KTtcbiAgI3JlZHVjZXI6IChyeDogUlgsIGV2ZW50czogRVtdKSA9PiBSZWR1Y2VyPGFueVtdIHwgdm9pZD47XG4gICNmb3JlY2FzdGVyOiBudWxsIHwgKChjb21tYW5kczogQykgPT4gRVtdKTtcbiAgI2RlY29kZUNvbW1hbmQ6IG51bGwgfCAoKHJhdzogYW55KSA9PiBDKTtcbiAgI29uQ29tbWFuZHM6IG51bGwgfCAoKGNvbW1hbmRzOiBFdmVudDxhbnk+W10pID0+IHZvaWQpO1xuXG4gICNsaXZlOiBib29sZWFuID0gZmFsc2U7XG4gICNzZXRMaXZlOiBib29sZWFuID0gZmFsc2U7XG4gICNvdmVybGF5OiBPdmVybGF5U3RvcmFnZTtcbiAgI2dyYXBoOiBRdWVyeUdyYXBoPFFYPjtcbiAgI2Nvcm86IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPjtcbiAgI2Z4OiBGdXR1cmVDb250ZXh0O1xuXG4gICNzY2hlZHVsZWQ6IGJvb2xlYW4gPSBmYWxzZTtcblxuICAvLyAjcmVjb25uZWN0cyBpcyBhIGxpc3Qgb2YgcHJvbWlzZSByZXNvbHZlIGZ1bmN0aW9uc1xuICAjcmVjb25uZWN0czogKFxuICAgICh2YWx1ZToge2NoZWNrcG9pbnQ6IG51bWJlciB8IHVuZGVmaW5lZCwgY29tbWFuZHM6IEV2ZW50PGFueT5bXX0pID0+IHZvaWRcbiAgKVtdID0gW107XG4gICNyZWN2ZEV2ZW50czogUmVhbEV2ZW50PEU+W10gPSBbXTtcbiAgLy8gY29tbWFuZHMgdGhhdCBjYW1lIHRvIHVzIGZyb20gdGhlIGNsaWVudFxuICAjc2VuZENvbW1hbmRzOiBDW10gPSBbXTtcbiAgLy8gY29tbWFuZCBpZHMgdGhlIHVzZXIgZXhwbGljaXRseSBtYXJrcyBhcyBjb21wbGV0ZWRcbiAgI3JvdW5kVHJpcHBlZDogc3RyaW5nW10gPSBbXTtcbiAgLy8gb3JkZXJlZCBtYXAgb2YgY29tbWFuZCBpZHMgdG8gdGhlIGZvcmVjYXN0ZWQgZXZlbnRzIGZyb20gdGhhdCBjb21tYW5kXG4gICN1bnNlbnQ6IE1hcDxzdHJpbmcsIEVbXT4gPSBuZXcgTWFwKCk7XG4gIC8vIGp1c3QgYSBmbGFnIGlmIG5ldyBxdWVyaWVzIGV4aXN0IHRvIGJlIHJ1bjsgd2UgZG9uJ3Qgc3RvcmUgdGhlbSBoZXJlIGZvciB0eXBpbmcgcHVycG9zZXMuXG4gICNuZXdRdWVyaWVzOiBib29sZWFuID0gZmFsc2U7XG4gICNzaW11bGF0ZXM6ICgoKSA9PiBSZWR1Y2VyPHZvaWQ+KVtdID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcXg6IFFYLFxuICAgIHJ4OiBSWCxcbiAgICAvLyBpZiBzdG9yYWdlIGlzIG51bGwsIEluTWVtU3RvcmFnZSBpcyB1c2VkXG4gICAgc3RvcmFnZTogU3RvcmFnZSB8IG51bGwsXG4gICAgY2FsbGJhY2tzOiB7XG4gICAgICAvLyByZXF1aXJlZDogY29udmVydCBmcm9tIGpzb24gZm9ybWF0IHRvIGZ1bGwgdHlwZVxuICAgICAgZGVjb2RlRXZlbnQ6IChyYXc6IGFueSkgPT4gRSxcbiAgICAgIC8vIHJlcXVpcmVkIGlmIHVzaW5nIHNlbmRDb21tYW5kczogY29udmVydCBmcm9tIHN0b3JhZ2Uvd2lyZSBmb3JtYXRcbiAgICAgIGRlY29kZUNvbW1hbmQ6IChyYXc6IGFueSkgPT4gQyxcbiAgICAgIC8vIG9wdGlvbmFsOiBjb25maWd1cmUgc3RvcmFnZSBiZWZvcmUgYW55IGV2ZW50cyBhcnJpdmVcbiAgICAgIG1pZ3JhdGU/OiAocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+LFxuICAgICAgLy8gcmVxdWlyZWQ6IHJlZHVjZSBhIGJhdGNoIG9mIGV2ZW50cyBpbnRvIHRoZSByZWFkIG1vZGVsXG4gICAgICByZWR1Y2VyOiAocng6IFJYLCBldmVudHM6IEVbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgICAgLy8gb3B0aW9uYWw6IGZvcmVjYXN0IHRoZSBldmVudHMgYSBzZXJ2ZXIgd2lsbCBzZW5kIGZvciBhIGJhdGNoIG9mIGNvbW1hbmRzXG4gICAgICBmb3JlY2FzdGVyPzogKGNvbW1hbmRzOiBDKSA9PiBFW10sXG4gICAgICAvLyByZXF1aXJlZCBpZiB1c2luZyBzZW5kQ29tbWFuZHM6IHJlY2VpdmUgZXZlbnRzIHRvIHNlbmQgb24gdGhlIHdpcmVcbiAgICAgIG9uQ29tbWFuZHM/OiAoY29tbWFuZHM6IGFueVtdKT0+IHZvaWQsXG4gICAgfSxcbiAgKSB7XG4gICAgdGhpcy4jcnggPSByeDtcbiAgICB0aGlzLiNzdG9yYWdlID0gc3RvcmFnZSA/PyBuZXcgSW5NZW1TdG9yYWdlKCk7XG4gICAgdGhpcy4jZGVjb2RlRXZlbnQgPSBjYWxsYmFja3MuZGVjb2RlRXZlbnQ7XG4gICAgdGhpcy4jZGVjb2RlQ29tbWFuZCA9IGNhbGxiYWNrcy5kZWNvZGVDb21tYW5kID8/IG51bGw7XG4gICAgdGhpcy4jbWlncmF0ZSA9IGNhbGxiYWNrcy5taWdyYXRlID8/IG51bGw7XG4gICAgdGhpcy4jcmVkdWNlciA9IGNhbGxiYWNrcy5yZWR1Y2VyO1xuICAgIHRoaXMuI2ZvcmVjYXN0ZXIgPSBjYWxsYmFja3MuZm9yZWNhc3RlciA/PyBudWxsO1xuICAgIHRoaXMuI29uQ29tbWFuZHMgPSBjYWxsYmFja3Mub25Db21tYW5kcyA/PyBudWxsO1xuXG4gICAgdGhpcy4jb3ZlcmxheSA9IG5ldyBPdmVybGF5U3RvcmFnZSh0aGlzLiNzdG9yYWdlKTtcbiAgICB0aGlzLiNncmFwaCA9IG5ldyBRdWVyeUdyYXBoKHF4KTtcblxuICAgIHRoaXMuI2Nvcm8gPSB0aGlzLiNhZHZhbmNlcigpO1xuICAgIHRoaXMuI2Z4ID0gbmV3IEZ1dHVyZUNvbnRleHQodGhpcy4jY29ybyk7XG4gICAgLy8gbGV0IHRoZSBhZHZhbmNlciBiZWdpbiBpbml0aWFsaXppbmdcbiAgICB0aGlzLiNmeC53YWtldXAoKTtcbiAgfVxuXG4gIC8vLy8gcHVibGljIGFwaSAvLy8vXG5cbiAgLy8gcmVxdWVzdCBpbmZvIG5lZWRlZCB0byByZXN1bWUgYSBjb25uZWN0aW9uOiBsYXN0IGNvbW1pdHRlZCBjaGVja3BvaW50IGFuZCB1bnNlbnQgY29tbWFuZHNcbiAgcmVjb25uZWN0KFxuICAgIGNiOiAocmVzdWx0OiB7Y2hlY2twb2ludDogbnVtYmVyIHwgdW5kZWZpbmVkLCBjb21tYW5kczogRXZlbnQ8YW55PltdfSkgPT4gdm9pZCxcbiAgKTogdm9pZCB7XG4gICAgdGhpcy4jcmVjb25uZWN0cy5wdXNoKGNiKTtcbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgLy8gbmV3IGV2ZW50cyBmcm9tIHRoZSB3aXJlIGNvbWUgaGVyZVxuICByZWN2RXZlbnRzKHJhdzogUmVhbEV2ZW50PGFueT5bXSk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgciBvZiByYXcpIHtcbiAgICAgIGNvbnN0IGV2ZW50ID0gRGVjb2RlUmVhbEV2ZW50KHIsIHRoaXMuI2RlY29kZUV2ZW50KTtcbiAgICAgIHRoaXMuI3JlY3ZkRXZlbnRzLnB1c2goZXZlbnQpO1xuICAgIH1cbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgZmVsbEJlaGluZCgpOiB2b2lkIHtcbiAgICB0aGlzLiNzZXRMaXZlID0gZmFsc2U7XG4gICAgdGhpcy4jc2NoZWR1bGUoKTtcbiAgfVxuXG4gIGNhdWdodFVwKCk6IHZvaWQge1xuICAgIHRoaXMuI3NldExpdmUgPSB0cnVlO1xuICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gIH1cblxuICAvLyBhZnRlciBmb3JlY2FzdGluZyBhbmQgc2F2aW5nIHRvIHN0b3JhZ2UsIHRoZXNlIHdpbGwgYXBwZWFyIGluIGFuIG9uQ29tbWFuZHMoKSBjYWxsYmFja1xuICBzZW5kQ29tbWFuZHMoY29tbWFuZHM6IENbXSk6IHZvaWQge1xuICAgIGlmICghdGhpcy4jb25Db21tYW5kcyB8fCAhdGhpcy4jZGVjb2RlQ29tbWFuZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcImlmIHNlbmRDb21tYW5kcygpIGlzIHVzZWQsIHRoZSBmb2xsb3dpbmcgY2FsbGJhY2tzIG11c3QgYmUgZGVmaW5lZDogXCJcbiAgICAgICAgKyBcIm9uQ29tbWFuZHMgYW5kIGRlY29kZUNvbW1hbmRcIlxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy4jc2VuZENvbW1hbmRzLnB1c2guYXBwbHkodGhpcy4jc2VuZENvbW1hbmRzLCBjb21tYW5kcyk7XG4gICAgdGhpcy4jc2NoZWR1bGUoKTtcbiAgfVxuXG4gIC8vIG5vcm1hbGx5IGZvcmVjYXN0ZWQgZXZlbnRzIGFyZSBkaXNjYXJkZWQgd2hlbiB0aGUgZXZlbnQgaWQgdGhhdCB3YXMgc3VibWl0dGVkIGlzIG9ic2VydmVkIGluXG4gIC8vIHJlY3ZFdmVudHMoKS4gIEJ1dCBpZiB0aGUgY29tbWFuZCB3YXMgcmVqZWN0ZWQsIHRoZW4gaXQgbWF5IGJlIG5lY2Vzc2FyeSB0byBleHBsaWNpdGx5IGZsYWcgdGhlXG4gIC8vIGNvbW1hbmQgYXMgc2VudCwgc28gdGhlIGZvcmVjYXN0ZWQgZXZlbnRzIGZyb20gdGhhdCByZWplY3RlZCBjb21tYW5kIGNhbiBiZSBkaXNjYXJkZWQuXG4gIG1hcmtTZW50KC4uLmlkOiBzdHJpbmdbXSk6IHZvaWQge1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZC5wdXNoKC4uLmlkKTtcbiAgICB0aGlzLiNzY2hlZHVsZSgpO1xuICB9XG5cbiAgLy8gYWRkIGEgbmV3IFF1ZXJ5IHRvIHRoZSBncmFwaFxuICBuZXdRdWVyeTxUPihmbjogUXVlcnlGdW5jdGlvbjxRWCwgVD4sIG1hbnVhbFN0YXJ0PzogYm9vbGVhbik6IFF1ZXJ5PFQ+IHtcbiAgICByZXR1cm4gdGhpcy4jZ3JhcGgubmV3UXVlcnkoZm4sIG1hbnVhbFN0YXJ0ID8/IGZhbHNlLCAoKSA9PiB7XG4gICAgICB0aGlzLiNuZXdRdWVyaWVzID0gdHJ1ZTtcbiAgICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gICAgfSk7XG4gIH1cblxuICBzaW11bGF0ZTxUPihcbiAgICBmbjogKHJ4OiBSWCwgZGVjb2RlZEV2ZW50czogRVtdKSA9PiBSZWR1Y2VyPFQ+LFxuICAgIGNiOiAocmVzdWx0OiBUKSA9PiB2b2lkLFxuICAgIHVuZGVjb2RlZEV2ZW50cz86IEV2ZW50PGFueT5bXSxcbiAgKTogdm9pZCB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgdGhpcy4jc2ltdWxhdGVzLnB1c2goZnVuY3Rpb24qKCkge1xuICAgICAgLy8gdW53cmFwIGFuZCBkZWNvZGUgZXZlbnRzXG4gICAgICBjb25zdCBkZWNvZGVkID0gKHVuZGVjb2RlZEV2ZW50cyA/PyBbXSkubWFwKCh1KSA9PiBzZWxmLiNkZWNvZGVFdmVudCh1LmRhdGEpKTtcbiAgICAgIC8vIHJ1biBwcm92aWRlZCBmdW5jdGlvblxuICAgICAgY29uc3QgcmVzdWx0ID0geWllbGQqIGZuKHNlbGYuI3J4LCBkZWNvZGVkKTtcbiAgICAgIC8vIHNlbmQgcmVzdWx0XG4gICAgICBjYihyZXN1bHQpO1xuICAgIH0pO1xuICAgIHRoaXMuI3NjaGVkdWxlKCk7XG4gIH1cblxuICAvLy8vIGVuZCBvZiBwdWJsaWMgYXBpIC8vLy9cblxuICAjc2NoZWR1bGUoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuI3NjaGVkdWxlZCkgcmV0dXJuO1xuICAgIHRoaXMuI3NjaGVkdWxlZCA9IHRydWU7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLiNzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgIHRoaXMuI2Z4Lndha2V1cCgpO1xuICAgIH0pO1xuICB9XG5cbiAgKiNpbml0aWFsaXplKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBydW4gbWlncmF0aW9uIGxvZ2ljIG9uIHRoZSBkYXRhIHN0b3JlXG4gICAgaWYgKHNlbGYuI21pZ3JhdGUpIHtcbiAgICAgIHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCkge1xuICAgICAgICB5aWVsZCogcnVuUmVkdWNlcihzZWxmLiNtaWdyYXRlIShzZWxmLiNyeCkpO1xuICAgICAgICAvLyBpZ25vcmUgdXBkYXRlZCBrZXlzIGFuZCBkb24ndCB0cmlnZ2VyIGEgcnVuIG9mIHRoZSBncmFwaFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gbG9hZCB1bnNlbnQgY29tbWFuZHMgZnJvbSBzdG9yYWdlXG4gICAgY29uc3QgY29tbWFuZHM6IEV2ZW50PGFueT5bXSA9IFtdO1xuICAgIHlpZWxkKiB3aXRoUlR4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCkge1xuICAgICAgY29uc3QgaW5kZXggPSAoeWllbGQqIHR4bkdldChcIi5jb21tYW5kc1wiKSkgYXMgc3RyaW5nW10gPz8gW107XG4gICAgICBmb3IgKGNvbnN0IGlkIG9mIGluZGV4KSB7XG4gICAgICAgIGNvbnN0IGNvbW1hbmQgPSAoeWllbGQqIHR4bkdldChgLmNvbW1hbmQtJHtpZH1gKSkgYXMgRXZlbnQ8YW55PjtcbiAgICAgICAgY29tbWFuZHMucHVzaChjb21tYW5kKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBpZiAoY29tbWFuZHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBpZiAoIXRoaXMuI2ZvcmVjYXN0ZXIpIHtcbiAgICAgIC8vIHJlbG9hZCBqdXN0IHRoZSBsaXN0IG9mIHVuc2V0IGV2ZW50IGlkc1xuICAgICAgZm9yIChjb25zdCBjb21tYW5kIG9mIGNvbW1hbmRzKSB7XG4gICAgICAgIHRoaXMuI3Vuc2VudC5zZXQoY29tbWFuZC5pZCwgW10pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIHJlbG9hZCBmb3JlY2FzdGVkIHN0YXRlXG5cbiAgICBjb25zdCBmb3JlY2FzdHM6IEVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgLy8gbm90ZSB0aGF0IHNpbmNlIHN0b3JhZ2UgbWF5IGJlIGluLW1lbW9yeSwgd2UgbXVzdCB0YWtlIGNhcmUgdG8gcHJlc2VydmUgY29tbWFuZC5kYXRhXG4gICAgICBjb25zdCBjID0gY29weU9uV3JpdGUodGhpcy4jZGVjb2RlQ29tbWFuZCEoY29tbWFuZC5kYXRhKSk7XG4gICAgICBjb25zdCBmcyA9IHJlY292ZXIodGhpcy4jZm9yZWNhc3RlcihjKSk7XG4gICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIGZzKTtcbiAgICAgIGZvcmVjYXN0cy5wdXNoKC4uLmZzKTtcbiAgICB9XG4gICAgaWYgKGZvcmVjYXN0cy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIC8vIHBvcHVsYXRlIHRoZSBpbml0aWFsIG92ZXJsYXlcbiAgICB5aWVsZCogd2l0aFdUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpIHtcbiAgICAgIHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGZvcmVjYXN0cykpO1xuICAgICAgLy8gaWdub3JlIHVwZGF0ZWQga2V5cyBhbmQgZG9uJ3QgdHJpZ2dlciBhIHJ1biBvZiB0aGUgZ3JhcGhcbiAgICB9KTtcbiAgfVxuXG4gIC8vIG91ciBtYWluIGxvZ2ljIGlzIGltcGxlbWVudGVkIGFzIGEgY29yb3V0aW5lXG4gICojYWR2YW5jZXIoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICB5aWVsZCogdGhpcy4jaW5pdGlhbGl6ZSgpO1xuXG4gICAgLy8gd2hhdCBhcmUgdGhlIGRpZmZlcmVudCB0aGluZ3Mgd2UgY2FuIGhhdmUgdG8gZG8/XG4gICAgLy8gLSByZWNlaXZlIGV2ZW50cyxcbiAgICAvLyAgICAgLSB0aGVuIHNoYXBlIHRoZW0sXG4gICAgLy8gICAgIC0gdGhlbiBwYXNzIHNoYXBlZCBldmVudHMgaW50byByZWR1Y2VycyxcbiAgICAvLyAgICAgLSB0aGVuIGNvbW1pdCB0aGF0IHJlc3VsdCBhbG9uZyB3aXRoIHRoZSBjaGVja3BvaW50LFxuICAgIC8vICAgICAtIHRoZW4gdGFrZSB0aGUgY29tbWl0IGFuZCBwYXNzIGl0IHRvIHRoZSBxdWVyeSBncmFwaFxuICAgIC8vIC0gcmVjaWV2ZSBzZW50Q29tbWFuZHMgYW5kIHVwZGF0ZSBjb21tYW5kcyBpbiBzdG9yYWdlXG4gICAgLy8gLSByZWNlaXZlIHNlbmRDb21tYW5kc1xuICAgIC8vICAgICAtIHRoZW4gY29tbWl0IHRoZW0gdG8gc3RvcmFnZSxcbiAgICAvLyAgICAgICAgIC0gdGhlbiBzZW5kIHRob3NlIHRvIG9uQ29tbWFuZCBob29rXG4gICAgLy8gICAgIC0gdGhlbiBmb3JlY2FzdCBldmVudHMsXG4gICAgLy8gICAgIC0gdGhlbiBwYXNzIHRoZW0gdG8gcmVkdWNlcnMsXG4gICAgLy8gICAgIC0gdGhlbiBjb21taXQgdGhhdCByZXN1bHQgdG8gdGhlIG92ZXJsYXlcbiAgICAvLyAgICAgLSB0aGVuIHBhc3MgdGhhdCBjb21taXQgdG8gdGhlIHF1ZXJ5IGdyYXBoXG4gICAgLy8gLSByZWNpZXZlIGEgbmV3IHF1ZXJ5XG4gICAgLy8gICAgIC0gZXh0ZW5kIHRoZSBncmFwaFxuICAgIC8vIC0gcmVjaWV2ZSBhIHJlY29ubmVjdCByZXF1ZXN0XG4gICAgLy8gICAgIC0gdGhlbiByZXR1cm4gdGhlIGNoZWNrcG9pbnQgaW4gc3RvcmFnZVxuICAgIHdoaWxlKHRydWUpe1xuICAgICAgaWYgKHRoaXMuI2xpdmUgJiYgIXRoaXMuI3NldExpdmUpIHtcbiAgICAgICAgLy8gd2UgZmVsbCBiZWhpbmQ7IGZyZWV6ZSBncmFwaCBhbmQgb3ZlcmxheSwgYW5kIHdoZW4gY2F1Z2h0VXAoKSBpcyBjYWxsZWQsIHdlJ2xsIHByb2Nlc3NcbiAgICAgICAgLy8gYWxsIGNoYW5nZXMgZnJvbSBub3cgdW50aWwgdGhlbiB3aXRoIGEgc2luZ2xlIHJ1biBvZiB0aGUgZ3JhcGhcbiAgICAgICAgdGhpcy4jbGl2ZSA9IGZhbHNlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jcmVjdmRFdmVudHMubGVuZ3RoID4gMCkge1xuICAgICAgICB5aWVsZCogdGhpcy4jb25SZWN2RXZlbnRzKCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jcm91bmRUcmlwcGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uUm91bmRUcmlwcGVkKCk7XG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIGlmICghdGhpcy4jbGl2ZSAmJiB0aGlzLiNzZXRMaXZlKSB7XG4gICAgICAgIC8vIHdlIGNhdWdodCB1cCBhbmQgcHJvY2Vzc2VkIGFsbCByZWN2ZEV2ZW50cygpOyB0aW1lIHRvIHJlc3RhcnQgdGhlIHF1ZXJ5IGdyYXBoc1xuICAgICAgICB0aGlzLiNsaXZlID0gdHJ1ZTtcbiAgICAgICAgeWllbGQqIHRoaXMuI3JlYnVpbGRPdmVybGF5KCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jc2VuZENvbW1hbmRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uU2VuZENvbW1hbmRzKCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy4jbmV3UXVlcmllcyAmJiB0aGlzLiNsaXZlKSB7XG4gICAgICAgIHlpZWxkKiB0aGlzLiNvbk5ld1F1ZXJpZXMoKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLiNyZWNvbm5lY3RzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQqIHRoaXMuI29uUmVjb25uZWN0cygpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRoaXMuI3NpbXVsYXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHlpZWxkKiB0aGlzLiNvblNpbXVsYXRlcygpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gaWYgd2UgZ290IGhlcmUgd2UgcHJvYmFibHkgaGFkIGEgc3B1cmlvdXMgd2FrZXVwLCBvciBwZXJoYXBzIGEgbmV3UXVlcnkoKSB3aGlsZSBub3QgI2xpdmVcbiAgICAgIHlpZWxkXG4gICAgfVxuICB9XG5cbiAgKiNvblJlY3ZFdmVudHMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAvLyB0YWtlIGV2ZW50cyBhbmQgbGF0ZXN0IGNoZWNrcG9pbnRcbiAgICBjb25zdCBldmVudHMgPSB0aGlzLiNyZWN2ZEV2ZW50cztcbiAgICBjb25zdCBjaGVja3BvaW50ID0gZXZlbnRzLmF0KC0xKSEucG9zaXRpb247XG4gICAgdGhpcy4jcmVjdmRFdmVudHMgPSBbXTtcblxuICAgIC8vIG9wZW4gYSB3cml0ZSB0eG4gdG8gcmVhbCBzdG9yYWdlXG4gICAgY29uc3QgdXBkYXRlcyA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICAvLyB1cGRhdGUgb3VyIGNoZWNrcG9pbnQgd2hlbiB0aGlzIHR4biBmaW5pc2hlc1xuICAgICAgeWllbGQqIHR4blNldChcIi5jaGVja3BvaW50XCIsIGNoZWNrcG9pbnQpO1xuXG4gICAgICAvLyBydW4gdGhlIHJlZHVjZXIgd2l0aCBvdXIgbmV3IGV2ZW50c1xuICAgICAgY29uc3QgZXZlbnRzRGF0YSA9IGV2ZW50cy5tYXAoKGV2ZW50KSA9PiBldmVudC5kYXRhKTtcbiAgICAgIGNvbnN0IFt1cGRhdGVzLCBtYXJrZWRTZW50XSA9IHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGV2ZW50c0RhdGEpKTtcblxuICAgICAgLy8gZGlzY2FyZCB1bnNlbnQgY29tbWFuZHMgdGhhdCB3ZSBub3cga25vdyBhcmUgc2VudFxuICAgICAgaWYgKHNlbGYuI3Vuc2VudC5zaXplID4gMCkge1xuICAgICAgICAvLyBkaXNjYXJkIGNvbW1hbmRzIHdlIG9ic2VydmVkIHJvdW5kLXRyaXAgYnkgbWF0Y2hpbmcgZXZlbnQgaWRzXG4gICAgICAgIGZvciAoY29uc3QgZXZlbnQgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgaWYgKHNlbGYuI3Vuc2VudC5oYXMoZXZlbnQuaWQpKSB7XG4gICAgICAgICAgICBzZWxmLiNyb3VuZFRyaXBwZWQucHVzaChldmVudC5pZCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIGRpc2NhcmQgY29tbWFuZHMgdGhhdCBtYXRjaCB3aGF0IHRoZSByZWR1Y2VyIHNheXMgd2FzIHNlbnRcbiAgICAgICAgaWYgKG1hcmtlZFNlbnQubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHRvSWdub3JlID0gc2VsZi4jcm91bmRUcmlwcGVkLnJlZHVjZShcbiAgICAgICAgICAgIChhY2MsIGlkKSA9PiAoYWNjW2lkXSA9IHRydWUsIGFjYyksXG4gICAgICAgICAgICB7fSBhcyBSZWNvcmQ8c3RyaW5nLCB0cnVlPixcbiAgICAgICAgICApO1xuICAgICAgICAgIGZvciAoY29uc3QgaWQgb2Ygc2VsZi4jdW5zZW50LmtleXMoKSkge1xuICAgICAgICAgICAgaWYgKGlkIGluIHRvSWdub3JlKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IGV2ZW50ID0gKHlpZWxkKiB0eG5HZXQoYC5jb21tYW5kLSR7aWR9YCkpIGFzIEV2ZW50PGFueT47XG4gICAgICAgICAgICBjb25zdCBjbWQgPSBzZWxmLiNkZWNvZGVDb21tYW5kIShldmVudC5kYXRhKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgbSBvZiBtYXJrZWRTZW50KSB7XG4gICAgICAgICAgICAgIGlmICghbWF0Y2hTZW50KG0sIGNtZCkpIGNvbnRpbnVlO1xuICAgICAgICAgICAgICBzZWxmLiNyb3VuZFRyaXBwZWQucHVzaChldmVudC5pZCk7XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gZGlzY2FyZCBjb21tYW5kcyBiYXNlZCBvbiBjYWxscyB0byBGcmFtZXdvcmsubWFya1NlbnQoKVxuICAgICAgeWllbGQqIHNlbGYuI2Rpc2NhcmRSb3VuZFRyaXBwZWQoKTtcblxuICAgICAgcmV0dXJuIHVwZGF0ZXM7XG4gICAgfSlcbiAgICB0aGlzLiNncmFwaC5kaXJ0eSh1cGRhdGVzKTtcbiAgICB0aGlzLiNyb3VuZFRyaXBwZWQubWFwKChpZCkgPT4gdGhpcy4jdW5zZW50LmRlbGV0ZShpZCkpO1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZCA9IFtdO1xuXG4gICAgaWYgKHRoaXMuI2xpdmUpIHtcbiAgICAgIHlpZWxkKiB0aGlzLiNyZWJ1aWxkT3ZlcmxheSgpO1xuICAgIH1cbiAgfVxuXG4gICojcmVidWlsZE92ZXJsYXkoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcblxuICAgIC8vIGRpc2NhcmQgb2xkIG92ZXJsYXksIHN0YXJ0IGEgbmV3IG9uZVxuICAgIHRoaXMuI2dyYXBoLmRpcnR5KHRoaXMuI292ZXJsYXkua2V5cygpKTtcbiAgICB0aGlzLiNvdmVybGF5ID0gbmV3IE92ZXJsYXlTdG9yYWdlKHRoaXMuI3N0b3JhZ2UpO1xuXG4gICAgLy8gcmVidWlsZCBvdmVybGF5IHdpdGggY3VycmVudCBmb3JlY2FzdHNcbiAgICBjb25zdCBmb3JlY2FzdHMgPSBbLi4udGhpcy4jdW5zZW50LnZhbHVlcygpXS5mbGF0KCk7XG4gICAgaWYgKGZvcmVjYXN0cy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBbdXBkYXRlcywgX21hcmtlZFNlbnRdID0geWllbGQqIHdpdGhXVHhuKHRoaXMuI2Z4LCB0aGlzLiNvdmVybGF5LCBmdW5jdGlvbiooKXtcbiAgICAgICAgcmV0dXJuIHlpZWxkKiBydW5SZWR1Y2VyKHNlbGYuI3JlZHVjZXIoc2VsZi4jcngsIGZvcmVjYXN0cykpO1xuICAgICAgfSk7XG4gICAgICBzZWxmLiNncmFwaC5kaXJ0eSh1cGRhdGVzKTtcbiAgICB9XG5cbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgLy8gdGhpcyB3aWxsIHJ1biBhbGwgcXVlcmllcywgZXZlbiBuZXcgb25lc1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5ydW4oKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gICojb25TZW5kQ29tbWFuZHMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAvLyBnZW5lcmF0ZSBhIHV1aWQgbm93IGZvciBlYWNoIGV2ZW50XG4gICAgY29uc3QgY29tbWFuZHM6IEV2ZW50PEM+W10gPSB0aGlzLiNzZW5kQ29tbWFuZHMubWFwKChjKSA9PiAoeyBpZDogZ2VuZXJhdGVVdWlkKCksIGRhdGE6IGMgfSkpO1xuICAgIHRoaXMuI3NlbmRDb21tYW5kcyA9IFtdO1xuXG4gICAgLy8gZW5jb2RlIG9uY2UgZm9yIGJvdGggc3RvcmFnZSBhbmQgc2VuZGluZyBvdmVyIHRoZSB3aXJlXG4gICAgY29uc3QgZW5jb2RlZDogRXZlbnQ8YW55PltdID0gY29tbWFuZHMubWFwKChjKSA9PiAoeyBpZDogYy5pZCwgZGF0YTogRW5jb2RlUHJvdG8oYy5kYXRhKSB9KSk7XG5cbiAgICAvLyBvcGVuIGEgd3JpdGUgdHhuIHRvIHJlYWwgc3RvcmFnZVxuICAgIHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICBjb25zdCBhZGRlZCA9IFtdO1xuICAgICAgLy8gd3JpdGUgZWFjaCBjb21tYW5kIHRvIHN0b3JhZ2VcbiAgICAgIGZvciAoY29uc3QgZWMgb2YgZW5jb2RlZCkge1xuICAgICAgICB5aWVsZCogdHhuU2V0KGAuY29tbWFuZC0ke2VjLmlkfWAsIGVjKTtcbiAgICAgICAgYWRkZWQucHVzaChlYy5pZCk7XG4gICAgICB9XG4gICAgICAvLyB1cGRhdGUgdGhlIGluZGV4XG4gICAgICBjb25zdCBpbmRleCA9ICh5aWVsZCogdHhuR2V0KFwiLmNvbW1hbmRzXCIpKSBhcyBzdHJpbmdbXSA/PyBbXTtcbiAgICAgIHlpZWxkKiB0eG5TZXQoXCIuY29tbWFuZHNcIiwgWy4uLmluZGV4LCAuLi5hZGRlZF0pO1xuICAgIH0pO1xuXG4gICAgLy8gc2NoZWR1bGUgYSBjYWxsYmFjayBmb3IgdGhlIHVzZXIgdG8ga25vdyBpdCBpcyB0aW1lIHRvIHNlbmQgdGhlc2UgY29tbWFuZHNcbiAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuI29uQ29tbWFuZHMhKGNvbW1hbmRzKSk7XG5cbiAgICAvLyBzdG9yZSB0aG9zZSBjb21tYW5kcyBhcyB1bnNlbnRcblxuICAgIC8vIG5vdyBmb3JlY2FzdCBldmVudHMgYmFzZWQgb24gdGhvc2UgY29tbWFuZHNcbiAgICBpZiAoIXRoaXMuI2ZvcmVjYXN0ZXIpIHtcbiAgICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIFtdKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBmb3JlY2FzdHM6IEVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgY29tbWFuZCBvZiBjb21tYW5kcykge1xuICAgICAgY29uc3QgYyA9IGNvcHlPbldyaXRlKGNvbW1hbmQuZGF0YSk7XG4gICAgICBjb25zdCBmcyA9IHJlY292ZXIodGhpcy4jZm9yZWNhc3RlcihjKSk7XG4gICAgICB0aGlzLiN1bnNlbnQuc2V0KGNvbW1hbmQuaWQsIGZzKTtcbiAgICAgIGZvcmVjYXN0cy5wdXNoKC4uLmZzKTtcbiAgICB9XG5cbiAgICBpZiAoZm9yZWNhc3RzLmxlbmd0aCA9PT0gMCB8fCAhdGhpcy4jbGl2ZSkgcmV0dXJuO1xuXG4gICAgLy8gb3BlbiBhIHdyaXRlIHR4biBhZ2FpbnN0IHRoZSBleGlzdGluZyBvdmVybGF5XG4gICAgY29uc3QgW3VwZGF0ZXMsIF9tYXJrZWRTZW50XSA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jb3ZlcmxheSwgZnVuY3Rpb24qKCl7XG4gICAgICByZXR1cm4geWllbGQqIHJ1blJlZHVjZXIoc2VsZi4jcmVkdWNlcihzZWxmLiNyeCwgZm9yZWNhc3RzKSk7XG4gICAgfSk7XG4gICAgdGhpcy4jZ3JhcGguZGlydHkodXBkYXRlcyk7XG5cbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgLy8gdGhpcyB3aWxsIHJ1biBhbGwgcXVlcmllcywgZXZlbiBuZXcgb25lc1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5ydW4oKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gIC8vIGRpc2NhcmQgdGhpcy4jcm91bmRUcmlwcGVkIHdpdGhpbiBzb21lIGV4dGVybmFsbHktcHJvdmlkZWQgV1R4blxuICAvLyAoeW91J2xsIGhhdmUgdG8gZXJhc2UgdGhpcy4jcm91bmRUcmlwcGVkIGFmdGVyIHRoZSB0eG4gY29tbWl0cylcbiAgLy8gcmV0dXJuIHRydWUgaWYgc29tZXRoaW5nIHdhcyBkZWxldGVkIChidXQgaXQgYWx3YXlzIHByb2Nlc3NlcyB0aGlzLiNyb3VuZFRyaXBwZWQpXG4gICojZGlzY2FyZFJvdW5kVHJpcHBlZCgpOiBXU3RvcmFnZUdlbmVyYXRvcjxib29sZWFuPiB7XG4gICAgaWYgKHRoaXMuI3JvdW5kVHJpcHBlZC5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCByb3VuZFRyaXBwZWQ6IFJlY29yZDxzdHJpbmcsIHRydWU+ID0ge307XG4gICAgZm9yIChjb25zdCBpZCBvZiB0aGlzLiNyb3VuZFRyaXBwZWQpIHtcbiAgICAgIHJvdW5kVHJpcHBlZFtpZF0gPSB0cnVlO1xuICAgIH1cbiAgICAvLyBsb2FkIHRoZSBpbmRleCBvZiBiYXRjaGVzIG9mIGNvbW1hbmRzXG4gICAgY29uc3QgaW5kZXggPSAoeWllbGQqIHR4bkdldChcIi5jb21tYW5kc1wiKSkgYXMgc3RyaW5nW10gPz8gW107XG4gICAgLy8gZGVjaWRlIHdoYXQgdG8gZGVsZXRlXG4gICAgY29uc3QgdG9EZWxldGUgPSBpbmRleC5maWx0ZXIoKGlkKSA9PiByb3VuZFRyaXBwZWRbaWRdKTtcbiAgICBpZiAodG9EZWxldGUubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yIChjb25zdCBpZCBvZiB0b0RlbGV0ZSkge1xuICAgICAgeWllbGQgKnR4bkRlbChgLmNvbW1hbmQtJHtpZH1gKTtcbiAgICB9XG4gICAgLy8gdXBkYXRlIHRoZSBpbmRleFxuICAgIGNvbnN0IHRvS2VlcCA9IGluZGV4LmZpbHRlcigoaWQpID0+ICFyb3VuZFRyaXBwZWRbaWRdKTtcbiAgICB5aWVsZCogdHhuU2V0KFwiLmNvbW1hbmRzXCIsIHRvS2VlcCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAqI29uUm91bmRUcmlwcGVkKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgY29uc3QgY2hhbmdlZCA9IHlpZWxkKiB3aXRoV1R4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICByZXR1cm4geWllbGQqIHNlbGYuI2Rpc2NhcmRSb3VuZFRyaXBwZWQoKTtcbiAgICB9KTtcbiAgICB0aGlzLiNyb3VuZFRyaXBwZWQubWFwKChpZCkgPT4gdGhpcy4jdW5zZW50LmRlbGV0ZShpZCkpO1xuICAgIHRoaXMuI3JvdW5kVHJpcHBlZCA9IFtdO1xuICAgIGlmIChjaGFuZ2VkICYmIHRoaXMuI2xpdmUpIHtcbiAgICAgIHlpZWxkKiB0aGlzLiNyZWJ1aWxkT3ZlcmxheSgpXG4gICAgfVxuICB9XG5cbiAgKiNvbk5ld1F1ZXJpZXMoKTogR2VuZXJhdG9yPHZvaWQsIHZvaWQsIHZvaWQ+IHtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBjb25zdCBjYnMgPSB5aWVsZCogd2l0aFJUeG4odGhpcy4jZngsIHRoaXMuI292ZXJsYXksIGZ1bmN0aW9uKigpe1xuICAgICAgc2VsZi4jbmV3UXVlcmllcyA9IGZhbHNlO1xuICAgICAgcmV0dXJuIHlpZWxkKiBzZWxmLiNncmFwaC5leHRlbmQoKTtcbiAgICB9KTtcbiAgICBjYnMoKTtcbiAgfVxuXG4gICojb25SZWNvbm5lY3RzKCk6IEdlbmVyYXRvcjx2b2lkLCB2b2lkLCB2b2lkPiB7XG4gICAgY29uc3Qge2NoZWNrcG9pbnQsIGNvbW1hbmRzfSA9IHlpZWxkKiB3aXRoUlR4bih0aGlzLiNmeCwgdGhpcy4jc3RvcmFnZSwgZnVuY3Rpb24qKCl7XG4gICAgICBjb25zdCBjaGVja3BvaW50ID0gKHlpZWxkKiB0eG5HZXQoXCIuY2hlY2twb2ludFwiKSkgYXMgKG51bWJlciB8IHVuZGVmaW5lZCk7XG4gICAgICBjb25zdCBjb21tYW5kczogRXZlbnQ8YW55PltdID0gW107XG4gICAgICBjb25zdCBpbmRleCA9ICh5aWVsZCogdHhuR2V0KFwiLmNvbW1hbmRzXCIpKSBhcyBzdHJpbmdbXSA/PyBbXTtcbiAgICAgIGZvciAoY29uc3QgaWQgb2YgaW5kZXgpIHtcbiAgICAgICAgY29uc3QgY29tbWFuZCA9ICh5aWVsZCogdHhuR2V0KGAuY29tbWFuZC0ke2lkfWApKSBhcyBFdmVudDxhbnk+O1xuICAgICAgICBjb21tYW5kcy5wdXNoKGNvbW1hbmQpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtjaGVja3BvaW50LCBjb21tYW5kc307XG4gICAgfSk7XG4gICAgZm9yIChjb25zdCByZXNvbHZlIG9mIHRoaXMuI3JlY29ubmVjdHMpIHtcbiAgICAgIHJlc29sdmUoeyBjaGVja3BvaW50LCBjb21tYW5kcyB9KTtcbiAgICB9XG4gICAgdGhpcy4jcmVjb25uZWN0cyA9IFtdO1xuICB9XG5cbiAgKiNvblNpbXVsYXRlcygpOiBHZW5lcmF0b3I8dm9pZCwgdm9pZCwgdm9pZD4ge1xuICAgIGNvbnN0IHNpbXVsYXRlcyA9IHRoaXMuI3NpbXVsYXRlcztcbiAgICB0aGlzLiNzaW11bGF0ZXMgPSBbXTtcbiAgICAvLyB1c2UgYSBzaW5nbGUgcmVhZCB0eG4gZm9yIGFsbCBzaW11bGF0aW9ucywgc2luY2UgcnVuUmVkdWNlcigpIHdpdGggc2ltdWxhdGU9dHJ1ZSBkb2Vzbid0IHdyaXRlXG4gICAgeWllbGQqIHdpdGhSVHhuKHRoaXMuI2Z4LCB0aGlzLiNzdG9yYWdlLCBmdW5jdGlvbiooKSB7XG4gICAgICBmb3IgKGNvbnN0IGZuIG9mIHNpbXVsYXRlcykge1xuICAgICAgICB5aWVsZCogcnVuUmVkdWNlcihmbigpLCB0cnVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUmVkdWNlclRlc3RlcjxSWCwgRSwgUz4ge1xuICAjcng6IFJYO1xuICAjcmVkdWNlcjogKHJ4OiBSWCwgZXZlbnRzOiBFW10pID0+IFJlZHVjZXI8dm9pZCB8IGFueVtdPjtcbiAgI3N0b3JhZ2U6IEluTWVtU3RvcmFnZTtcbiAgZGF0YTogUztcblxuICBjb25zdHJ1Y3RvcihcbiAgICByeDogUlgsXG4gICAgbWlncmF0ZTogbnVsbCB8ICgocng6IFJYKSA9PiBSZWR1Y2VyPHZvaWQ+KSxcbiAgICByZWR1Y2VyOiAocng6IFJYLCBldmVudHM6IEVbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgIHN0b3JhZ2U6IEluTWVtU3RvcmFnZSxcbiAgICB0ZXN0RGF0YTogUyxcbiAgKSB7XG4gICAgdGhpcy4jcnggPSByeDtcbiAgICB0aGlzLiNyZWR1Y2VyID0gcmVkdWNlcjtcbiAgICB0aGlzLiNzdG9yYWdlID0gc3RvcmFnZTtcbiAgICB0aGlzLmRhdGEgPSB0ZXN0RGF0YTtcblxuICAgIGlmIChtaWdyYXRlKSB7XG4gICAgICB0aGlzLiNydW4obWlncmF0ZShyeCkpO1xuICAgIH1cbiAgfVxuXG4gICNydW4oZzogUmVkdWNlcjx2b2lkIHwgYW55W10+KTogW3N0cmluZ1tdLCBhbnlbXV0ge1xuICAgIC8vIGRvIHRoZSBcIkZ1dHVyZUNvbnRleHRcIiBkYW5jZS5cbiAgICBsZXQgZng6IEZ1dHVyZUNvbnRleHQ7XG4gICAgbGV0IHJlc3VsdDogW3N0cmluZ1tdLCBhbnlbXV0gfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgY29uc3QgY29ybyA9IGZ1bmN0aW9uKigpIHtcbiAgICAgIHJlc3VsdCA9IHlpZWxkKiB3aXRoV1R4bihmeCEsIHNlbGYuI3N0b3JhZ2UsIGZ1bmN0aW9uKigpIHtcbiAgICAgICAgcmV0dXJuIHlpZWxkKiBydW5SZWR1Y2VyKGcsIGZhbHNlKTtcbiAgICAgIH0pO1xuICAgIH0oKTtcbiAgICBmeCA9IG5ldyBGdXR1cmVDb250ZXh0KGNvcm8pO1xuXG4gICAgLy8gd2l0aCBJbk1lbVN0b3JhZ2UsIHRoaXMgc2hvdWxkIGFsd2F5cyBiZSBjb21wbGV0ZWQgaW4gYSBzaW5nbGUgc2hvdFxuICAgIGZ4Lndha2V1cCgpO1xuICAgIGlmICghcmVzdWx0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHBlY3RlZCB0ZXN0IGNvcm91dGluZSB0byBjb21wbGV0ZSBpbiBvbmUgc2hvdFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIHJ1biBldmVudHMgYWdhaW5zdCBwcm92aWRlZCByZWR1Y2VyXG4gIHJ1bihldmVudHM6IEVbXSk6IHt1cGRhdGVzOiBzdHJpbmdbXSwgbWFya2VkU2VudDogYW55W119IHtcbiAgICBjb25zdCBnID0gdGhpcy4jcmVkdWNlcih0aGlzLiNyeCwgZXZlbnRzKTtcbiAgICBjb25zdCBbIHVwZGF0ZXMsIG1hcmtlZFNlbnQgXSA9IHRoaXMuI3J1bihnKTtcbiAgICB1cGRhdGVzLnNvcnQoKTtcbiAgICByZXR1cm4geyB1cGRhdGVzLCBtYXJrZWRTZW50IH07XG4gIH1cbn1cblxuLy8gZW5kIG9mIHNrZWxldG9uIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG5leHBvcnQgdHlwZSBMaXN0ID0ge2lkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgaXRlbXM6IHN0cmluZ1tdLCBhcmNoaXZlZDogYm9vbGVhbn07XG5cbmV4cG9ydCB0eXBlIEl0ZW0gPSB7aWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBkb25lOiBib29sZWFuLCBhcmNoaXZlZDogYm9vbGVhbn07XG5cbmV4cG9ydCB0eXBlIE5ld0xpc3QgPSB7dHlwZTogXCJuZXctbGlzdFwiLCBpZDogc3RyaW5nLCBuYW1lOiBzdHJpbmd9O1xuXG5leHBvcnQgdHlwZSBSZW5hbWVMaXN0ID0ge3R5cGU6IFwicmVuYW1lLWxpc3RcIiwgaWQ6IHN0cmluZywgbmFtZTogc3RyaW5nfTtcblxuZXhwb3J0IHR5cGUgQXJjaGl2ZUxpc3QgPSB7dHlwZTogXCJhcmNoaXZlLWxpc3RcIiwgaWQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIE5ld0l0ZW0gPSB7dHlwZTogXCJuZXctaXRlbVwiLCBpZDogc3RyaW5nLCBsaXN0OiBzdHJpbmcsIHRleHQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIEVkaXRJdGVtID0ge3R5cGU6IFwiZWRpdC1pdGVtXCIsIGlkOiBzdHJpbmcsIHRleHQ6IHN0cmluZ307XG5cbmV4cG9ydCB0eXBlIE1hcmtJdGVtID0ge3R5cGU6IFwibWFyay1pdGVtXCIsIGlkOiBzdHJpbmcsIGRvbmU6IGJvb2xlYW59O1xuXG5leHBvcnQgdHlwZSBBcmNoaXZlSXRlbSA9IHt0eXBlOiBcImFyY2hpdmUtaXRlbVwiLCBpZDogc3RyaW5nfTtcblxuZXhwb3J0IHR5cGUgVG9kb0V2ZW50cyA9IEVkaXRJdGVtIHwgTmV3SXRlbSB8IE1hcmtJdGVtIHwgTmV3TGlzdCB8IEFyY2hpdmVMaXN0IHwgQXJjaGl2ZUl0ZW0gfCBSZW5hbWVMaXN0O1xuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlTGlzdCh2YWw6IGFueSk6IExpc3Qge1xuICByZXR1cm4gdmFsIGFzIExpc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVJdGVtKHZhbDogYW55KTogSXRlbSB7XG4gIHJldHVybiB2YWwgYXMgSXRlbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZU5ld0xpc3QodmFsOiBhbnkpOiBOZXdMaXN0IHtcbiAgcmV0dXJuIHZhbCBhcyBOZXdMaXN0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlUmVuYW1lTGlzdCh2YWw6IGFueSk6IFJlbmFtZUxpc3Qge1xuICByZXR1cm4gdmFsIGFzIFJlbmFtZUxpc3Q7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVBcmNoaXZlTGlzdCh2YWw6IGFueSk6IEFyY2hpdmVMaXN0IHtcbiAgcmV0dXJuIHZhbCBhcyBBcmNoaXZlTGlzdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZU5ld0l0ZW0odmFsOiBhbnkpOiBOZXdJdGVtIHtcbiAgcmV0dXJuIHZhbCBhcyBOZXdJdGVtO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlRWRpdEl0ZW0odmFsOiBhbnkpOiBFZGl0SXRlbSB7XG4gIHJldHVybiB2YWwgYXMgRWRpdEl0ZW07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZWNvZGVNYXJrSXRlbSh2YWw6IGFueSk6IE1hcmtJdGVtIHtcbiAgcmV0dXJuIHZhbCBhcyBNYXJrSXRlbTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERlY29kZUFyY2hpdmVJdGVtKHZhbDogYW55KTogQXJjaGl2ZUl0ZW0ge1xuICByZXR1cm4gdmFsIGFzIEFyY2hpdmVJdGVtO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gRGVjb2RlVG9kb0V2ZW50cyh2YWw6IGFueSk6IFRvZG9FdmVudHMge1xuICByZXR1cm4gdmFsIGFzIFRvZG9FdmVudHM7XG59XG5cbmZ1bmN0aW9uICpxdWVyeUdldDxUPihrZXk6IHN0cmluZyk6IFF1ZXJ5R2VuZXJhdG9yPFQ+IHtcbiAgY29uc3QgYW5zID0geWllbGQgeydzdG9yZSc6IHtba2V5XTogdHJ1ZX19O1xuICBjb25zdCBzdiA9IGFucy5zdG9yZVtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIHJlYWRPbmx5KHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyT2xkPFQ+KGtleTogc3RyaW5nKTogUmVkdWNlcjxUPiB7XG4gIGNvbnN0IGFucyA9IHlpZWxkIHsnb2xkJzoge1trZXldOiB0cnVlfX07XG4gIGNvbnN0IHN2ID0gYW5zLm9sZFtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIGNvcHlPbldyaXRlKHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyR2V0PFQ+KGtleTogc3RyaW5nKTogUmVkdWNlcjxUPiB7XG4gIGNvbnN0IGFucyA9IHlpZWxkIHsnZ2V0Jzoge1trZXldOiB0cnVlfX07XG4gIGNvbnN0IHN2ID0gYW5zLmdldFtrZXldO1xuICBpZiAoJ2VycicgaW4gc3YpIHRocm93IHN2LmVycjtcbiAgcmV0dXJuIGNvcHlPbldyaXRlKHN2LnZhbHVlKSBhcyBUXG59XG5cbmZ1bmN0aW9uICpyZWR1Y2VyU2V0PFQ+KGtleTogc3RyaW5nLCB2YWx1ZTogVCk6IFJlZHVjZXI8dm9pZD4ge1xuICBjb25zdCBhbnMgPSB5aWVsZCB7J3NldCc6IHtba2V5XTogdmFsdWV9fTtcbiAgY29uc3Qgc3YgPSBhbnMuc2V0W2tleV07XG4gIGlmICgnZXJyJyBpbiBzdikgdGhyb3cgc3YuZXJyO1xufVxuZnVuY3Rpb24gKnJlZHVjZXJEZWwoa2V5OiBzdHJpbmcpOiBSZWR1Y2VyPHZvaWQ+IHtcbiAgY29uc3QgYW5zID0geWllbGQgeydkZWwnOiB7W2tleV06IHRydWV9fTtcbiAgY29uc3Qgc3YgPSBhbnMuZGVsW2tleV07XG4gIGlmICgnZXJyJyBpbiBzdikgdGhyb3cgc3YuZXJyO1xufVxuZnVuY3Rpb24gKnJlZHVjZXJVcGRhdGU8VCwgUj4oa2V5OiBzdHJpbmcsIGZuOiAodDogVCkgPT4gUik6IFJlZHVjZXI8Uj4ge1xuICBjb25zdCBvYmogPSB5aWVsZCogcmVkdWNlckdldDxUPihrZXkpO1xuICBjb25zdCBvdXQgPSBmbihvYmopO1xuICB5aWVsZCogcmVkdWNlclNldChrZXksIG9iaik7XG4gIHJldHVybiBvdXQ7XG59XG5leHBvcnQgdHlwZSBOb1NldDxUIGV4dGVuZHMge1xuICBcImdldFwiOiB1bmtub3duLCBcIm9sZFwiOiB1bmtub3duLCBcImRlbFwiOiB1bmtub3duLCBcInVwZGF0ZVwiOiB1bmtub3duXG59PiA9IFBpY2s8VCwgXCJnZXRcInxcIm9sZFwifFwiZGVsXCJ8XCJ1cGRhdGVcIj47XG5cbmV4cG9ydCBjb25zdCBUb2RvUXVlcnlDb250ZXh0ID0ge1xuICBnZXQ6IHtcbiAgICBhbGxfbGlzdHM6ICgpID0+IHF1ZXJ5R2V0PHN0cmluZ1tdPihgYWxsX2xpc3RzYCksXG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcXVlcnlHZXQ8SXRlbT4oYGl0ZW0uJHtpdGVtX2lkfWApLFxuICAgIGxpc3Q6IChsaXN0X2lkOiBzdHJpbmcpID0+IHF1ZXJ5R2V0PExpc3Q+KGBsaXN0LiR7bGlzdF9pZH1gKSxcbiAgfSxcbn07XG5cblxuZXhwb3J0IHR5cGUgVG9kb1FYID0gdHlwZW9mIFRvZG9RdWVyeUNvbnRleHQ7XG5leHBvcnQgY29uc3QgVG9kb1JlZHVjZXJDb250ZXh0ID0ge1xuICBvbGQ6IHtcbiAgICBhbGxfbGlzdHM6ICgpID0+IHJlZHVjZXJPbGQ8c3RyaW5nW10+KGBhbGxfbGlzdHNgKSxcbiAgICBpdGVtOiAoaXRlbV9pZDogc3RyaW5nKSA9PiByZWR1Y2VyT2xkPEl0ZW0+KGBpdGVtLiR7aXRlbV9pZH1gKSxcbiAgICBsaXN0OiAobGlzdF9pZDogc3RyaW5nKSA9PiByZWR1Y2VyT2xkPExpc3Q+KGBsaXN0LiR7bGlzdF9pZH1gKSxcbiAgfSxcbiAgZ2V0OiB7XG4gICAgYWxsX2xpc3RzOiAoKSA9PiByZWR1Y2VyR2V0PHN0cmluZ1tdPihgYWxsX2xpc3RzYCksXG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcmVkdWNlckdldDxJdGVtPihgaXRlbS4ke2l0ZW1faWR9YCksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZykgPT4gcmVkdWNlckdldDxMaXN0PihgbGlzdC4ke2xpc3RfaWR9YCksXG4gIH0sXG4gIHNldDoge1xuICAgIGFsbF9saXN0czogKHZhbHVlOiBzdHJpbmdbXSkgPT4gcmVkdWNlclNldChgYWxsX2xpc3RzYCwgdmFsdWUpLFxuICAgIGl0ZW06IChpdGVtX2lkOiBzdHJpbmcsIHZhbHVlOiBJdGVtKSA9PiByZWR1Y2VyU2V0KGBpdGVtLiR7aXRlbV9pZH1gLCB2YWx1ZSksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZywgdmFsdWU6IExpc3QpID0+IHJlZHVjZXJTZXQoYGxpc3QuJHtsaXN0X2lkfWAsIHZhbHVlKSxcbiAgfSxcbiAgZGVsOiB7XG4gICAgaXRlbTogKGl0ZW1faWQ6IHN0cmluZykgPT4gcmVkdWNlckRlbChgaXRlbS4ke2l0ZW1faWR9YCksXG4gICAgbGlzdDogKGxpc3RfaWQ6IHN0cmluZykgPT4gcmVkdWNlckRlbChgbGlzdC4ke2xpc3RfaWR9YCksXG4gIH0sXG4gIHVwZGF0ZToge1xuICAgIGFsbF9saXN0czogPFI+KGZuOiAodmFsdWU6IHN0cmluZ1tdKSA9PiBSKSA9PiByZWR1Y2VyVXBkYXRlKGBhbGxfbGlzdHNgLCBmbiksXG4gICAgaXRlbTogPFI+KGl0ZW1faWQ6IHN0cmluZywgZm46ICh2YWx1ZTogSXRlbSkgPT4gUikgPT4gcmVkdWNlclVwZGF0ZShgaXRlbS4ke2l0ZW1faWR9YCwgZm4pLFxuICAgIGxpc3Q6IDxSPihsaXN0X2lkOiBzdHJpbmcsIGZuOiAodmFsdWU6IExpc3QpID0+IFIpID0+IHJlZHVjZXJVcGRhdGUoYGxpc3QuJHtsaXN0X2lkfWAsIGZuKSxcbiAgfSxcbn07XG5cbmV4cG9ydCB0eXBlIFRvZG9SWCA9IHR5cGVvZiBUb2RvUmVkdWNlckNvbnRleHQ7XG5cbmV4cG9ydCBjbGFzcyBUb2RvRnJhbWV3b3JrIGV4dGVuZHMgRnJhbWV3b3JrPFRvZG9RWCwgVG9kb1JYLCBUb2RvRXZlbnRzLCBUb2RvRXZlbnRzPiB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHN0b3JhZ2U6IFN0b3JhZ2UsXG4gICAgY2FsbGJhY2tzOiB7XG4gICAgICAvLyBvcHRpb25hbDogY29uZmlndXJlIHN0b3JhZ2UgYmVmb3JlIGFueSBldmVudHMgYXJyaXZlXG4gICAgICBtaWdyYXRlPzogKHJ4OiBUb2RvUlgpID0+IFJlZHVjZXI8dm9pZD4sXG4gICAgICAvLyByZXF1aXJlZDogcmVkdWNlIGEgYmF0Y2ggb2YgZXZlbnRzIGludG8gdGhlIHJlYWQgbW9kZWxcbiAgICAgIHJlZHVjZXI6IChyeDogVG9kb1JYLCBldmVudHM6IFRvZG9FdmVudHNbXSkgPT4gUmVkdWNlcjx2b2lkIHwgYW55W10+LFxuICAgICAgLy8gb3B0aW9uYWw6IGZvcmVjYXN0IHRoZSBldmVudHMgYSBzZXJ2ZXIgd2lsbCBzZW5kIGZvciBhIGNvbW1hbmRcbiAgICAgIGZvcmVjYXN0ZXI/OiAoY29tbWFuZHM6IFRvZG9FdmVudHMpID0+IFRvZG9FdmVudHNbXSxcbiAgICAgIC8vIHJlcXVpcmVkIGlmIHVzaW5nIHNlbmRDb21tYW5kczogcmVjZWl2ZSBldmVudHMgdG8gc2VuZCBvbiB0aGUgd2lyZVxuICAgICAgb25Db21tYW5kcz86IChjb21tYW5kczogRXZlbnQ8YW55PltdKT0+IHZvaWQsXG4gICAgfSxcbiAgICAvLyB1c2VkIGluIGNyb3NzLWxhbmd1YWdlIHN1cHBvcnQ6IGluamVjdCBhbiBhcmJpdHJhcnkgb2JqZWN0IGFzIHRoZSBRdWVyeUNvbnRleHRcbiAgICBxeD86IGFueSxcbiAgKSB7XG4gICAgc3VwZXIocXggPz8gVG9kb1F1ZXJ5Q29udGV4dCwgVG9kb1JlZHVjZXJDb250ZXh0LCBzdG9yYWdlLCB7XG4gICAgICAgIC4uLmNhbGxiYWNrcyxcbiAgICAgICAgZGVjb2RlRXZlbnQ6IERlY29kZVRvZG9FdmVudHMsXG4gICAgICAgIGRlY29kZUNvbW1hbmQ6IERlY29kZVRvZG9FdmVudHMsXG4gICAgfSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFRvZG9UZXN0RGF0YSB7XG4gIGRhdGE6IFJlY29yZDxzdHJpbmcsIGFueT47XG5cbiAgY29uc3RydWN0b3IoZGF0YTogUmVjb3JkPHN0cmluZywgYW55Pil7XG4gICAgdGhpcy5kYXRhID0gZGF0YTtcbiAgfVxuXG4gIGFsbF9saXN0cygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHRoaXMuZGF0YVtgYWxsX2xpc3RzYF0gYXMgc3RyaW5nW11cbiAgfVxuXG4gIGl0ZW0oaXRlbV9pZDogc3RyaW5nKTogSXRlbSB7XG4gICAgcmV0dXJuIHRoaXMuZGF0YVtgaXRlbS4ke2l0ZW1faWR9YF0gYXMgSXRlbVxuICB9XG5cbiAgbGlzdChsaXN0X2lkOiBzdHJpbmcpOiBMaXN0IHtcbiAgICByZXR1cm4gdGhpcy5kYXRhW2BsaXN0LiR7bGlzdF9pZH1gXSBhcyBMaXN0XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFRvZG9SZWR1Y2VyVGVzdGVyIGV4dGVuZHMgUmVkdWNlclRlc3RlcjxUb2RvUlgsIFRvZG9FdmVudHMsIFRvZG9UZXN0RGF0YT4ge1xuICBjb25zdHJ1Y3RvcihcbiAgICBtaWdyYXRlT3JJbml0aWFsRGF0YTogKChyeDogVG9kb1JYKSA9PiBSZWR1Y2VyPHZvaWQ+KSB8IFJlY29yZDxzdHJpbmcsIGFueT4sXG4gICAgcmVkdWNlcjogKHJ4OiBUb2RvUlgsIGV2ZW50czogVG9kb0V2ZW50c1tdKSA9PiBSZWR1Y2VyPHZvaWQgfCBhbnlbXT4sXG4gICkge1xuICAgIGxldCBtaWdyYXRlOiBudWxsIHwgKChyeDogVG9kb1JYKSA9PiBSZWR1Y2VyPHZvaWQ+KTtcbiAgICBsZXQgZGF0YTogUmVjb3JkPHN0cmluZywgYW55PjtcbiAgICBpZiAobWlncmF0ZU9ySW5pdGlhbERhdGEgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgICBtaWdyYXRlID0gbWlncmF0ZU9ySW5pdGlhbERhdGE7XG4gICAgICAgIGRhdGEgPSB7fTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBtaWdyYXRlID0gbnVsbDtcbiAgICAgICAgZGF0YSA9IG1pZ3JhdGVPckluaXRpYWxEYXRhO1xuICAgIH1cbiAgICBzdXBlcihUb2RvUmVkdWNlckNvbnRleHQsIG1pZ3JhdGUsIHJlZHVjZXIsIG5ldyBJbk1lbVN0b3JhZ2UoZGF0YSksIG5ldyBUb2RvVGVzdERhdGEoZGF0YSkpO1xuICB9XG59XG5cbiIsImltcG9ydCB7XG4gIFJlZHVjZXIsXG4gIFRvZG9FdmVudHMsXG4gIFRvZG9SWCxcbn0gZnJvbSAnLi9tb2RlbC5nZW4nO1xuXG5cbmV4cG9ydCBmdW5jdGlvbiAqbWlncmF0ZVRvZG9zKHJ4OiBUb2RvUlgpOiBSZWR1Y2VyPHZvaWQ+IHtcbiAgLy8ganVzdCBzZXQgXCJhbGxfbGlzdHNcIiBrZXkgdG8gYW4gZW1wdHkgbGlzdCBpZiBpdCBkb2Vzbid0IGV4aXN0IHlldFxuICB5aWVsZCogcnguc2V0LmFsbF9saXN0cyhcbiAgICAoeWllbGQqIHJ4LmdldC5hbGxfbGlzdHMoKSkgPz8gW11cbiAgKTtcbn1cblxuXG5leHBvcnQgZnVuY3Rpb24gKnJlZHVjZVRvZG9zKHJ4OiBUb2RvUlgsIGV2ZW50czogVG9kb0V2ZW50c1tdKTogUmVkdWNlcjx2b2lkPiB7XG4gIGZvciAoY29uc3QgZSBvZiBldmVudHMpIHtcbiAgICBzd2l0Y2ggKGUudHlwZSkge1xuICAgICAgY2FzZSBcIm5ldy1saXN0XCI6XG4gICAgICAgIHlpZWxkKiByeC51cGRhdGUuYWxsX2xpc3RzKChhbGxfbGlzdHMpID0+IGFsbF9saXN0cy5wdXNoKGUuaWQpKTtcbiAgICAgICAgeWllbGQqIHJ4LnNldC5saXN0KGUuaWQsIHsgaWQ6IGUuaWQsIG5hbWU6IGUubmFtZSwgaXRlbXM6IFtdLCBhcmNoaXZlZDogZmFsc2UgfSk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwicmVuYW1lLWxpc3RcIjpcbiAgICAgICAgeWllbGQqIHJ4LnVwZGF0ZS5saXN0KGUuaWQsIChsaXN0KSA9PiBsaXN0Lm5hbWUgPSBlLm5hbWUpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcImFyY2hpdmUtbGlzdFwiOlxuICAgICAgICB5aWVsZCogcngudXBkYXRlLmxpc3QoZS5pZCwgKGxpc3QpID0+IGxpc3QuYXJjaGl2ZWQgPSB0cnVlKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJuZXctaXRlbVwiOlxuICAgICAgICB5aWVsZCogcnguc2V0Lml0ZW0oZS5pZCwgeyBpZDogZS5pZCwgdGV4dDogZS50ZXh0LCBkb25lOiBmYWxzZSwgYXJjaGl2ZWQ6IGZhbHNlIH0pO1xuICAgICAgICB5aWVsZCogcngudXBkYXRlLmxpc3QoZS5saXN0LCAobGlzdCkgPT4gbGlzdC5pdGVtcy5wdXNoKGUuaWQpKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJlZGl0LWl0ZW1cIjpcbiAgICAgICAgeWllbGQqIHJ4LnVwZGF0ZS5pdGVtKGUuaWQsIChpdGVtKSA9PiBpdGVtLnRleHQgPSBlLnRleHQpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIm1hcmstaXRlbVwiOlxuICAgICAgICB5aWVsZCogcngudXBkYXRlLml0ZW0oZS5pZCwgKGl0ZW0pID0+IGl0ZW0uZG9uZSA9IGUuZG9uZSk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiYXJjaGl2ZS1pdGVtXCI6XG4gICAgICAgIHlpZWxkKiByeC51cGRhdGUuaXRlbShlLmlkLCAoaXRlbSkgPT4gaXRlbS5hcmNoaXZlZCA9IHRydWUpO1xuICAgICAgICBicmVhaztcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgY29uc3QgX3R5cGVjaGVjazogbmV2ZXIgPSBlO1xuICAgICAgICByZXR1cm4gX3R5cGVjaGVjaztcbiAgICB9XG4gIH1cbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBO0FBRUE7QUFDQTtTQVVnQixVQUFVLENBQUksR0FBc0IsRUFBRSxHQUFXLEVBQUUsTUFBUyxFQUFBO0FBQzFFLElBQUEsSUFBSSxHQUFHLElBQUksR0FBRyxFQUFFO0FBQ2QsUUFBQSxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUM7SUFDakI7U0FBTztBQUNMLFFBQUEsR0FBRyxDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU07QUFDakIsUUFBQSxPQUFPLE1BQU07SUFDZjtBQUNGO0FBRUEsTUFBTSxNQUFNLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLEVBQUUsR0FBRyxFQUFFLEdBQUcsRUFBRSxHQUFHLENBQUM7QUFFL0Y7QUFDQSxJQUFJLENBQUUsVUFBa0IsQ0FBQyxZQUFZLEVBQUU7QUFDckMsSUFBQSxJQUFJLFlBQVksR0FBRyxZQUFBO1FBQ2pCLElBQUksR0FBRyxHQUFHLEVBQUU7O0FBR1osUUFBQSxNQUFNLE1BQU0sR0FBRyxJQUFJLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFDakMsUUFBQSxNQUFNLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQzs7QUFHOUIsUUFBQSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUM7QUFDckMsUUFBQSxNQUFNLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUM7QUFFckMsUUFBQSxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFJO0FBQ25CLFlBQUEsR0FBRyxJ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LE1BQU0sRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUM3RCxRQUFBLFdBQVcsRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxXQUFXLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUN2RSxRQUFBLEtBQUssRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUMzRCxRQUFBLElBQUksRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUN6RCxRQUFBLFVBQVUsRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUM5RSxRQUFBLFFBQVEsRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUMxRSxRQUFBLFNBQVMsRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUM1RSxRQUFBLE1BQU0sRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztBQUM3RCxRQUFBLElBQUksRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQztRQUNsRSxDQUFDLE1BQU0sQ0FBQyxRQUFRLEdBQUcsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7O0FBR2xGLFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQztBQUN6RCxRQUFBLElBQUksRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUM7QUFDbkQsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsSUFBSSxDQUFDLEdBQUcsSUFBSSxDQUFDO0FBQ25ELFFBQUEsV0FBVyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQU0sSUFBWSxDQUFDLFdBQVcsQ0FBQyxHQUFHLElBQUksQ0FBQztBQUNqRSxRQUFBLGNBQWMsRUFBRSxDQUFDLEdBQUcsSUFBUyxLQUFNLElBQVksQ0FBQyxjQUFjLENBQUMsR0FBRyxJQUFJLENBQUM7QUFDdkUsUUFBQSxRQUFRLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDOztBQUczRCxRQUFBLElBQUksRUFBRSxrQkFBa0I7QUFDeEIsUUFBQSxHQUFHLEVBQUUsa0JBQWtCO0FBQ3ZCLFFBQUEsS0FBSyxFQUFFLGtCQUFrQjtBQUN6QixRQUFBLE9BQU8sRUFBRSxrQkFBa0I7QUFDM0IsUUFBQSxVQUFVLEVBQUUsa0JBQWtCO0FBQzlCLFFBQUEsSUFBSSxFQUFFLGtCQUFrQjtBQUN4QixRQUFBLElBQUksRUFBRSxrQkFBa0I7QUFDeEIsUUFBQSxNQUFNLEVBQUUsa0JBQWtCO0FBQzFCLFFBQUEsT0FBTyxFQUFFLGtCQUFrQjtLQUM1QjtBQUVELElBQUEsT0FBTyxJQUFJLEtBQUssQ0FBQyxJQUFJLEVBQUU7QUFDckIsUUFBQSxjQUFjLEVBQUUsa0JBQWtCO0FBQ2xDLFFBQUEsY0FBYyxFQUFFLGtCQUFrQjtBQUNsQyxRQUFBLEdBQUcsRUFBRSxrQkFBa0I7UUFFdkIsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFTLEVBQUE7WUFDZCxJQUFJLElBQUksS0FBSyxPQUFPO0FBQUUsZ0JBQUEsT0FBTyxNQUFNLFFBQVEsQ0FBQyxJQUFJLENBQUM7QUFFakQsWUFBQSxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztBQUFFLGdCQUFBLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQztZQUNsRCxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxFQUFFO2dCQUM3QixNQUFNLEtBQUssR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ2xDLGdCQUFBLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxLQUFLO0FBQ25CLGdCQUFBLE9BQU8sS0FBSztZQUNkO0FBRUEsWUFBQSxNQUFNLE1BQU0sR0FBRyxjQUFjLENBQUMsSUFBSSxDQUFDO0FBQ25DLFlBQUEsSUFBSSxNQUFNO0FBQUUsZ0JBQUEsT0FBTyxNQUFNO0FBRXpCLFlBQUEsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDO1FBQ25CLENBQUM7QUFDRixLQUFBLENBQUM7QUFDSjtBQUVBLE1BQU0sZUFBZSxHQUFHO0FBQ3RCLElBQUEsT0FBTyxFQUFFLGtCQUFrQjtBQUMzQixJQUFBLFdBQVcsRUFBRSxrQkFBa0I7QUFDL0IsSUFBQSxRQUFRLEVBQUUsa0JBQWtCO0FBQzVCLElBQUEsZUFBZSxFQUFFLGtCQUFrQjtBQUNuQyxJQUFBLFVBQVUsRUFBRSxrQkFBa0I7QUFDOUIsSUFBQSxRQUFRLEVBQUUsa0JBQWtCO0FBQzVCLElBQUEsVUFBVSxFQUFFLGtCQUFrQjtBQUM5QixJQUFBLE9BQU8sRUFBRSxrQkFBa0I7QUFDM0IsSUFBQSxVQUFVLEVBQUUsa0JBQWtCO0FBQzlCLElBQUEsY0FBYyxFQUFFLGtCQUFrQjtBQUNsQyxJQUFBLFdBQVcsRUFBRSxrQkFBa0I7QUFDL0IsSUFBQSxrQkFBa0IsRUFBRSxrQkFBa0I7QUFDdEMsSUFBQSxhQUFhLEVBQUUsa0JBQWtCO0FBQ2pDLElBQUEsV0FBVyxFQUFFLGtCQUFrQjtBQUMvQixJQUFBLGFBQWEsRUFBRSxrQkFBa0I7QUFDakMsSUFBQSxPQUFPLEVBQUUsa0JBQWtCO0NBQzVCO0FBQ0QsTUFBTSxDQUFDLGNBQWMsQ0FBQyxlQUFlLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztBQUV0RCxTQUFTLFlBQVksQ0FBQyxJQUFVLEVBQUE7O0FBRTlCLElBQUEsTUFBTSxHQUFHLEdBQUcsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDO0FBQzFCLElBQUEsTUFBTSxDQUFDLGNBQWMsQ0FBQyxHQUFHLEVBQUUsZUFBZSxDQUFDO0FBQzNDLElBQUEsT0FBTyxHQUFHO0FBQ1o7QUFFQSxTQUFTLFdBQVcsQ0FBTyxJQUFlLEVBQUE7QUFDeEMsSUFBQSxNQUFNLEtBQUssR0FBd0IsSUFBSSxHQUFHLEVBQUU7SUFDNUMsSUFBSSxNQUFNLEdBQUcsS0FBSztJQUVsQixTQUFTLE1BQU0sQ0FBQyxDQUFJLEVBQUE7QUFDbEIsUUFBQSxJQUFJLE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUFFLFlBQUEsT0FBTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUMvQyxRQUFBLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUFFLFlBQUEsT0FBTyxTQUFTO1FBQ2xDLE1BQU0sRUFBRSxHQUFHLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBRSxDQUFDO0FBQ2pDLFFBQUEsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDO0FBQ2hCLFFBQUEsT0FBTyxFQUFFO0lBQ1g7QUFFQSxJQUFBLFNBQVMsUUFBUSxHQUFBO0FBQ2YsUUFBQSxJQUFJLE1BQU07QUFBRSxZQUFBLE9BQU8sS0FBSztRQUN4QixNQUFNLEdBQUcsSUFBSTtRQUNiLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxFQUFFO0FBQzNCLFlBQUEsSUFBSSxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztnQkFBRTtBQUNsQixZQUFBLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBRSxDQUFDLENBQUM7UUFDdEM7QUFDQSxRQUFBLE9BQU8sS0FBSztJQUNkO0FBRUEsSUFBQSxNQUFNLFlBQVksR0FBUTs7UUFFeEIsR0FBRyxFQUFFLENBQUMsR0FBUSxLQUFLLE1BQU0sQ0FBQyxHQUFHLENBQUM7O0FBRzlCLFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQy9ELFFBQUEsT0FBTyxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQy9ELFFBQUEsTUFBTSxFQUFFLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDO1FBQzdELENBQUMsTUFBTSxDQUFDLFFBQVEsR0FBRyxDQUFDLEdBQUcsSUFBUyxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxFQUFFLElBQUksQ0FBQzs7QUFHbEYsUUFBQSxHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQVcsS0FBTSxJQUFZLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxDQUFDO0FBQ25ELFFBQUEsSUFBSSxFQUFFLENBQUMsR0FBRyxJQUFXLEtBQU0sSUFBWSxDQUFDLElBQUksQ0FBQyxHQUFHLElBQUksQ0FBQzs7QUFHckQsUUFBQSxLQUFLLEVBQUUsa0JBQWtCO0FBQ3pCLFFBQUEsTUFBTSxFQUFFLGtCQUFrQjtBQUMxQixRQUFBLFdBQVcsRUFBRSxrQkFBa0I7QUFDL0IsUUFBQSxtQkFBbUIsRUFBRSxrQkFBa0I7QUFDdkMsUUFBQSxHQUFHLEVBQUUsa0JBQWtCO0tBQ3hCO0FBQ0QsSUFBQSxNQUFNLENBQUMsY0FBYyxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUM7QUFFekMsSUFBQSxPQUFPLElBQUksS0FBSyxDQUFDLElBQUksRUFBRTtBQUNyQixRQUFBLGNBQWMsRUFBRSxrQkFBa0I7QUFDbEMsUUFBQSxjQUFjLEVBQUUsa0JBQWtCO0FBQ2xDLFFBQUEsR0FBRyxFQUFFLGtCQUFrQjtRQUV2QixHQUFHLENBQUMsQ0FBQyxFQUFFLElBQVMsRUFBQTtZQUNkLElBQUksSUFBSSxLQUFLLE9BQU87QUFBRSxnQkFBQSxPQUFPLE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQztBQUNqRCxZQUFBLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxJQUFJLENBQUM7QUFDakMsWUFBQSxJQUFJLE1BQU07QUFBRSxnQkFBQSxPQUFPLE1BQU07QUFFekIsWUFBQSxPQUFRLElBQVksQ0FBQyxJQUFJLENBQUM7UUFDNUIsQ0FBQztBQUNGLEtBQUEsQ0FBQztBQUNKO0FBRUE7QUFDQSxTQUFTLFdBQVcsQ0FBSSxJQUFZLEVBQUE7QUFDbEMsSUFBQSxPQUFPLElBQUksS0FBSyxDQUFDLElBQUksRUFBRTtBQUNyQixRQUFBLGNBQWMsRUFBRSxrQkFBa0I7QUFDbEMsUUFBQSxjQUFjLEVBQUUsa0JBQWtCO0FBQ2xDLFFBQUEsR0FBRyxFQUFFLGtCQUFrQjtRQUV2QixHQUFHLENBQUMsQ0FBQyxFQUFFLElBQVMsRUFBQTtZQUNkLElBQUksSUFBSSxLQUFLLE9BQU87QUFBRSxnQkFBQSxPQUFPLE1BQU0sUUFBUSxDQUFDLElBQUksQ0FBQzs7WUFHakQsSUFBSSxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksS0FBSyxRQUFRLElBQUksSUFBSSxLQUFLLE9BQU87QUFBRSxnQkFBQSxPQUFPLGtCQUFrQjtBQUV0RixZQUFBLE1BQU0sS0FBSyxHQUFJLElBQVksQ0FBQyxJQUFJLENBQUM7QUFDakMsWUFBQSxJQUFJLEtBQUssWUFBWSxRQUFRLEVBQUU7QUFDN0IsZ0JBQUEsT0FBTyxDQUFDLEdBQUcsSUFBUyxLQUFLLEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQztZQUNsRDtBQUNBLFlBQUEsT0FBTyxLQUFLO1FBQ2QsQ0FBQztBQUNGLEtBQUEsQ0FBQztBQUNKO0FBRU0sU0FBVSxXQUFXLENBQUksSUFBTyxFQUFFLE1BQW1CLEVBQUE7SUFDekQsUUFBUSxPQUFPLElBQUk7QUFDakIsUUFBQSxLQUFLLFNBQVM7QUFDZCxRQUFBLEtBQUssUUFBUTtBQUNiLFFBQUEsS0FBSyxRQUFRO0FBQ2IsUUFBQSxLQUFLLFFBQVE7QUFDYixRQUFBLEtBQUssV0FBVzs7QUFFZCxZQUFBLE9BQU8sSUFBSTtBQUViLFFBQUEsS0FBSyxRQUFROztZQUVYLElBQUksSUFBSSxLQUFLLElBQUk7QUFBRSxnQkFBQSxPQUFPLElBQUk7WUFDOUIsSUFBSSxJQUFJLFlBQVksSUFBSTtBQUFFLGdCQUFBLE9BQU8sSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFNLENBQUM7O1lBRXJEO0FBRUYsUUFBQSxLQUFLLFFBQVE7QUFDYixRQUFBLEtBQUssVUFBVTtBQUNmLFFBQUE7WUFDRSxNQUFNLElBQUksS0FBSyxDQUFDLENBQUEsY0FBQSxFQUFpQixPQUFPLElBQUksQ0FBQSw0QkFBQSxDQUE4QixDQUFDOzs7QUFJL0UsSUFBQSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO0FBQUUsUUFBQSxPQUFPLGdCQUFnQixDQUFDLElBQUksRUFBRSxNQUFNLENBQU07SUFDbkUsSUFBSSxJQUFJLFlBQVksR0FBRztBQUFFLFFBQUEsT0FBTyxjQUFjLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBTTtJQUNqRSxJQUFJLElBQUksWUFBWSxHQUFHO0FBQUUsUUFBQSxPQUFPLGNBQWMsQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFNO0lBQ2pFLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDO0lBQ3pDLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLENBQUMsU0FBUyxFQUFFO0FBQ3ZDLFFBQUEsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFBLCtCQUFBLENBQWlDLENBQUM7SUFDcEQ7QUFFQSxJQUFBLE9BQU8saUJBQWlCLENBQUMsSUFBVyxFQUFFLE1BQU0sQ0FBTTtBQUNwRDtBQUVBLE1BQU0sVUFBVSxHQUFHLE1BQU0sRUFBRTtBQUVyQixTQUFVLE9BQU8sQ0FBSSxJQUFPLEVBQUE7SUFDaEMsUUFBUSxPQUFPLElBQUk7QUFDakIsUUFBQSxLQUFLLFNBQVM7QUFDZCxRQUFBLEtBQUssUUFBUTtBQUNiLFFBQUEsS0FBSyxRQUFRO0FBQ2IsUUFBQSxLQUFLLFFBQVE7QUFDYixRQUFBLEtBQUssV0FBVzs7QUFFZCxZQUFBLE9BQU8sSUFBSTtBQUViLFFBQUEsS0FBSyxRQUFRO1lBQ1gsSUFBSSxJQUFJLEtBQUssSUFBSTtBQUFFLGdCQUFBLE9BQU8sSUFBSTtZQUM5QixJQUFJLElBQUksWUFBWSxJQUFJO0FBQUUsZ0JBQUEsT0FBTyxJQUFJOztZQUVyQztBQUVGLFFBQUEsS0FBSyxRQUFRO0FBQ2IsUUFBQSxLQUFLLFVBQVU7QUFDZixRQUFBO1lBQ0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFBLGNBQUEsRUFBaUIsT0FBTyxJQUFJLENBQUEsd0JBQUEsQ0FBMEIsQ0FBQzs7O0FBSTNFLElBQUEsTUFBTSxJQUFJLEdBQWEsSUFBWSxDQUFDLFVBQVUsQ0FBQztBQUMvQyxJQUFBLElBQUksSUFBSTtRQUFFLE9BQU8sSUFBSSxFQUFFOztBQUl2QixJQUFBLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtBQUN2QixRQUFBLEtBQUssTUFBTSxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsSUFBSSxJQUFJLENBQUMsT0FBTyxFQUFFLEVBQUU7QUFDdEMsWUFBQSxNQUFNLENBQUMsR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDO0FBQ3ZCLFlBQUEsSUFBSSxDQUFDLEtBQUssSUFBSSxFQUFFO0FBQ2QsZ0JBQUEsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7WUFDYjtRQUNGO0FBQ0EsUUFBQSxPQUFPLElBQUk7SUFDYjtBQUVBLElBQUEsSUFBSSxJQUFJLFlBQVksR0FBRyxFQUFFO0FBQ3ZCLFFBQUEsS0FBSSxNQUFNLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxJQUFJLElBQUksQ0FBQyxPQUFPLEVBQUUsRUFBRTtBQUN4QyxZQUFBLE1BQU0sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7QUFDeEIsWUFBQSxJQUFJLENBQUMsS0FBSyxLQUFLLEVBQUU7QUFDZixnQkFBQSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUM7WUFDbEI7UUFDRjtBQUNBLFFBQUEsT0FBTyxJQUFJO0lBQ2I7O0lBR0EsSUFBSSxJQUFJLFlBQVksR0FBRztBQUFFLFFBQUEsT0FBTyxJQUFJO0lBRXBDLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDO0lBQ3pDLElBQUksS0FBSyxJQUFJLEtBQUssS0FBSyxNQUFNLENBQUMsU0FBUyxFQUFFO0FBQ3ZDLFFBQUEsTUFBTSxJQUFJLEtBQUssQ0FBQyxDQUFBLCtCQUFBLENBQWlDLENBQUM7SUFDcEQ7O0FBR0EsSUFBQSxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtBQUMvQyxRQUFBLE1BQU0sQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLENBQUM7QUFDeEIsUUFBQSxJQUFJLENBQUMsS0FBSyxLQUFLLEVBQUU7QUFDZCxZQUFBLElBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDO1FBQ3hCO0lBQ0Y7QUFDQSxJQUFBLE9BQU8sSUFBUztBQUNsQjtBQUVBLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUM7QUFFakMsU0FBUyxpQkFBaUIsQ0FBSSxJQUF1QixFQUFFLE1BQW1CLEVBQUE7O0lBRXhFLE1BQU0sS0FBSyxHQUF1QyxFQUFFO0lBQ3BELElBQUksS0FBSyxHQUFHLElBQUk7QUFHaEIsSUFBQSxTQUFTLElBQUksR0FBQTtRQUNYLElBQUksS0FBSyxFQUFFO1lBQ1QsS0FBSyxHQUFHLEtBQUs7O0FBRWIsWUFBQSxJQUFJLE1BQU07QUFBRSxnQkFBQSxNQUFNLEVBQUU7UUFDdEI7SUFDRjtBQUVBLElBQUEsU0FBUyxJQUFJLEdBQUE7QUFDWCxRQUFBLElBQUksS0FBSztBQUFFLFlBQUEsT0FBTyxRQUFRLENBQUMsSUFBSSxDQUFDO1FBQ2hDLE1BQU0sR0FBRyxHQUFzQixFQUFFO1FBQ3RCO0FBQ1QsWUFBQSxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDN0MsSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQztvQkFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQztZQUMxRDtRQUNGO0FBQ0EsUUFBQSxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUM5QyxJQUFJLEdBQUcsS0FBSyxPQUFPO2dCQUFFLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsR0FBUSxDQUFDO1FBQ3BEO0FBQ0EsUUFBQSxPQUFPLEdBQUc7SUFDWjtBQUVBLElBQUEsU0FBUyxJQUFJLEdBQUE7O0FBRVgsUUFBQSxJQUFJLEtBQUs7QUFBRSxZQUFBLE9BQU8sSUFBSTs7QUFTdEIsUUFBQSxNQUFNLEdBQUcsR0FBRyxFQUFFLEdBQUcsSUFBSSxFQUFFO0FBQ3ZCLFFBQUEsS0FBSyxNQUFNLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUU7QUFDOUMsWUFBQSxJQUFJLEdBQUcsS0FBSyxPQUFPLEVBQUU7QUFDbkIsZ0JBQUEsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDO1lBQ2pCO2lCQUFPO2dCQUNMLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQ3pCO1FBQ0Y7QUFDQSxRQUFBLE9BQU8sR0FBRztJQUNaO0FBRUEsSUFBQSxPQUFPLElBQUksS0FBSyxDQUFDLElBQUksRUFBRTtRQUNyQixjQUFjLEdBQUE7QUFDWixZQUFBLE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLENBQUM7UUFDakQsQ0FBQztRQUVELGNBQWMsQ0FBQyxDQUFDLEVBQUUsSUFBUyxFQUFBO0FBQ3pCLFlBQUEsSUFBSSxFQUFFO0FBQ04sWUFBQSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsT0FBTztBQUNyQixZQUFBLE9BQU8sSUFBSTtRQUNiLENBQUM7UUFFRCx3QkFBd0IsQ0FBQyxDQUFDLEVBQUUsSUFBUyxFQUFBO0FBQ25DLFlBQUEsSUFBSSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssT0FBTztBQUFFLGdCQUFBLE9BQU8sU0FBUztBQUM3QyxZQUFBLE9BQU8sTUFBTSxDQUFDLHdCQUF3QixDQUFDLEtBQUssRUFBRSxJQUFJLENBQUM7QUFDakQsZ0JBQUEsTUFBTSxDQUFDLHdCQUF3QixDQUFDLElBQUksRUFBRSxJQUFJLENBQUM7UUFDL0MsQ0FBQztRQUVELEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBUyxFQUFBO1lBQ2QsSUFBSSxJQUFJLEtBQUssT0FBTztBQUFFLGdCQUFBLE9BQU8sSUFBSTtZQUNqQyxJQUFJLElBQUksS0FBSyxVQUFVO0FBQUUsZ0JBQUEsT0FBTyxJQUFJOztZQUdwQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQyxFQUFFO0FBQzlCLGdCQUFBLE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUM7Z0JBQ3pCLE9BQU8sS0FBSyxLQUFLLE9BQU8sR0FBRyxLQUFLLEdBQUcsU0FBUztZQUM5Qzs7WUFFQSxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxFQUFFO2dCQUM3QixNQUFNLEtBQUssR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQztBQUMzQyxnQkFBQSxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsS0FBSztBQUNuQixnQkFBQSxPQUFPLEtBQUs7WUFDZDtBQUVBLFlBQUEsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQztBQUN4QixZQUFBLElBQUksS0FBSyxZQUFZLFFBQVEsRUFBRTtBQUM3QixnQkFBQSxPQUFPLENBQUMsR0FBRyxJQUFTLEtBQUssS0FBSyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDO1lBQ25EO0FBQ0EsWUFBQSxPQUFPLEtBQUs7UUFDZCxDQUFDO1FBRUQsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFTLEVBQUE7QUFDZCxZQUFBLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDO0FBQUUsZ0JBQUEsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssT0FBTztZQUM5RCxPQUFPLElBQUksSUFBSSxJQUFJO1FBQ3JCLENBQUM7UUFFRCxPQUFPLEdBQUE7WUFDTCxNQUFNLEdBQUcsR0FBRyxFQUFFO1lBQ2QsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFO0FBQ25DLGdCQUFBLElBQUksS0FBSyxDQUFDLEdBQUcsQ0FBQyxLQUFLLE9BQU87b0JBQUU7QUFDNUIsZ0JBQUEsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7WUFDZjtZQUNBLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtBQUNwQyxnQkFBQSxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQztvQkFBRTtBQUM5QixnQkFBQSxJQUFJLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxPQUFPO0FBQUUsb0JBQUEsR0FBRyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7WUFDM0M7QUFDQSxZQUFBLE9BQU8sR0FBRztRQUNaLENBQUM7QUFFRCxRQUFBLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBUyxFQUFFLEtBQVEsRUFBQTtBQUN4QixZQUFBLElBQUksRUFBRTtBQUNOLFlBQUEsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEtBQUs7QUFDbkIsWUFBQSxPQUFPLElBQUk7UUFDYixDQUFDO0FBQ0YsS0FBQSxDQUFDO0FBQ0o7QUFFQSxTQUFTLGdCQUFnQixDQUFJLElBQVMsRUFBRSxNQUFtQixFQUFBOztJQUV6RCxNQUFNLEtBQUssR0FBRyxLQUFLLENBQXFCLElBQUksQ0FBQyxNQUFNLENBQUM7SUFDcEQsSUFBSSxLQUFLLEdBQUcsSUFBSTtJQUNoQixJQUFJLElBQUksR0FBRyxLQUFLO0FBRWhCLElBQUEsU0FBUyxJQUFJLEdBQUE7UUFDWCxJQUFJLEtBQUssRUFBRTtZQUNULEtBQUssR0FBRyxLQUFLO0FBQ2IsWUFBQSxJQUFJLE1BQU07QUFBRSxnQkFBQSxNQUFNLEVBQUU7UUFDdEI7SUFDRjtJQUVBLFNBQVMsTUFBTSxDQUFDLENBQVMsRUFBQTtBQUN2QixRQUFBLElBQUksSUFBSTtBQUFFLFlBQUEsT0FBTyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3pCLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLEVBQUM7QUFDMUIsWUFBQSxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsQ0FBQyxDQUFDO1lBQ3BCLE9BQU8sR0FBRyxLQUFLLE9BQU8sR0FBRyxHQUFHLEdBQUcsU0FBUztRQUMxQztRQUNBLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7QUFBRSxZQUFBLE9BQU8sU0FBUztRQUM3QyxNQUFNLEVBQUUsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQy9CLFFBQUEsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLEVBQUU7QUFDYixRQUFBLE9BQU8sRUFBRTtJQUNYO0FBRUEsSUFBQSxTQUFTLFFBQVEsR0FBQTtBQUNmLFFBQUEsSUFBSSxJQUFJO0FBQUUsWUFBQSxPQUFPLEtBQUs7UUFDdEIsSUFBSSxHQUFHLElBQUk7O1FBRVgsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxFQUFFO1lBQ25DLElBQUksQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsRUFBRTtBQUM5QixnQkFBQSxLQUFLLENBQUMsR0FBVSxDQUFDLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFVLENBQUMsRUFBRSxJQUFJLENBQUM7WUFDekQ7UUFDRjs7QUFFQSxRQUFBLEtBQUssTUFBTSxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQ2hELElBQUksS0FBSyxLQUFLLE9BQU87QUFBRSxnQkFBQSxPQUFPLEtBQUssQ0FBQyxHQUFVLENBQUM7UUFDakQ7QUFDQSxRQUFBLE9BQU8sS0FBSztJQUNkO0FBRUEsSUFBQSxNQUFNLGVBQWUsR0FBUTs7UUFFM0IsRUFBRSxFQUFFLENBQUMsS0FBYSxLQUFLLE1BQU0sQ0FBQyxLQUFLLEdBQUcsRUFBRSxHQUFHLEtBQUssR0FBRyxJQUFJLENBQUMsTUFBTSxHQUFHLEtBQUssQ0FBQztBQUN2RSxRQUFBLElBQUksRUFBRSxDQUFDLEdBQUcsSUFBVyxNQUFNLElBQUksRUFBRSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQzs7QUFJdkQsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDL0QsUUFBQSxLQUFLLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDM0QsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxTQUFTLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDbkUsUUFBQSxRQUFRLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDMUUsUUFBQSxhQUFhLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsYUFBYSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDcEYsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDL0QsUUFBQSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDL0QsUUFBQSxHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDdkQsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxXQUFXLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDdkUsUUFBQSxLQUFLLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDM0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDekQsUUFBQSxVQUFVLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDOUUsUUFBQSxRQUFRLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDMUUsUUFBQSxTQUFTLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDNUUsUUFBQSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7QUFDN0QsUUFBQSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsS0FBTSxJQUFZLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUM7UUFDbEUsQ0FBQyxNQUFNLENBQUMsUUFBUSxHQUFHLENBQUMsR0FBRyxJQUFTLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxFQUFFLEVBQUUsSUFBSSxDQUFDOztRQUdsRixHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUNqRSxPQUFPLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUN6RSxVQUFVLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUMvRSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUNuRSxJQUFJLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUNuRSxNQUFNLEVBQUUsQ0FBQyxHQUFHLElBQVMsTUFBTSxJQUFJLEVBQUUsRUFBRSxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FB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QSxDQUFFLENBQUM7UUFDOUQsSUFBSSxFQUFFLENBQUMsT0FBZSxLQUFLLFVBQVUsQ0FBTyxDQUFBLEtBQUEsRUFBUSxPQUFPLENBQUEsQ0FBRSxDQUFDO0FBQy9ELEtBQUE7QUFDRCxJQUFBLEdBQUcsRUFBRTtBQUNILFFBQUEsU0FBUyxFQUFFLE1BQU0sVUFBVSxDQUFXLFdBQVcsQ0FBQztRQUNsRCxJQUFJLEVBQUUsQ0FBQyxPQUFlLEtBQUssVUFBVSxDQUFPLENBQUEsS0FBQSxFQUFRLE9BQU8sQ0FBQSxDQUFFLENBQUM7UUFDOUQsSUFBSSxFQUFFLENBQUMsT0FBZSxLQUFLLFVBQVUsQ0FBTyxDQUFBLEtBQUEsRUFBUSxPQUFPLENBQUEsQ0FBRSxDQUFDO0FBQy9ELEtBQUE7QUFDRCxJQUFBLEdBQUcsRUFBRTtRQUNILFNBQVMsRUFBRSxDQUFDLEtBQWUsS0FBSyxVQUFVLENBQUMsQ0FBQSxTQUFBLENBQVcsRUFBRSxLQUFLLENBQUM7QUFDOUQsUUFBQSxJQUFJLEVBQUUsQ0FBQyxPQUFlLEVBQUUsS0FBVyxLQUFLLFVBQVUsQ0FBQyxDQUFBLEtBQUEsRUFBUSxPQUFPLENBQUEsQ0FBRSxFQUFFLEtBQUssQ0FBQztBQUM1RSxRQUFBLElBQUksRUFBRSxDQUFDLE9BQWUsRUFBRSxLQUFXLEtBQUssVUFBVSxDQUFDLENBQUEsS0FBQSxFQUFRLE9BQU8sQ0FBQSxDQUFFLEVBQUUsS0FBSyxDQUFDO0FBQzdFLEtBQUE7QUFDRCxJQUFBLEdBQUcsRUFBRTtRQUNILElBQUksRUFBRSxDQUFDLE9BQWUsS0FBSyxVQUFVLENBQUMsQ0FBQSxLQUFBLEVBQVEsT0FBTyxDQUFBLENBQUUsQ0FBQztRQUN4RCxJQUFJLEVBQUUsQ0FBQyxPQUFlLEtBQUssVUFBVSxDQUFDLENBQUEsS0FBQSxFQUFRLE9BQU8sQ0FBQSxDQUFFLENBQUM7QUFDekQsS0FBQTtBQUNELElBQUEsTUFBTSxFQUFFO1FBQ04sU0FBUyxFQUFFLENBQUksRUFBMEIsS0FBSyxhQUFhLENBQUMsQ0FBQSxTQUFBLENBQVcsRUFBRSxFQUFFLENB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
