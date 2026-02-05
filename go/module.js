/******************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */
/* global Reflect, Promise, SuppressedError, Symbol, Iterator */


function __classPrivateFieldGet(receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

function __classPrivateFieldSet(receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
}

typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
};

// an indexeddb-compatible, transactional key-value store built around generators.
//
// A note about typing: the Storage interface must receive a value with .set() and return the same
// type value with .get().  It must not matter which implementation of Storage is in use.  However,
// most of the access to storage is untyped.  So storage cannot get() and set() the real proto
// values.  Instead, a Storage implementation which stores anywhere other than in-memory must do
// the type-to-storage conversion internally.  Then any generated typed getters built around the
// Storage interface shall be merely typecasting wrappers.
var _InMemStorage_instances, _InMemStorage_data, _InMemStorage_withTxn, _InMemTxn_data, _InMemTxn_updates, _OverlayStorage_instances, _OverlayStorage_base, _OverlayStorage_data, _OverlayStorage_withTxn, _OverlayTxn_base, _OverlayTxn_data, _OverlayTxn_updates;
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
            // start delets
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
    constructor(data) {
        _InMemStorage_instances.add(this);
        _InMemStorage_data.set(this, void 0);
        __classPrivateFieldSet(this, _InMemStorage_data, data !== undefined ? data : {}, "f");
    }
    *withWTxn(_fx, fn) {
        return yield* __classPrivateFieldGet(this, _InMemStorage_instances, "m", _InMemStorage_withTxn).call(this, fn);
    }
    *withRTxn(_fx, fn) {
        return yield* __classPrivateFieldGet(this, _InMemStorage_instances, "m", _InMemStorage_withTxn).call(this, fn);
    }
}
_InMemStorage_data = new WeakMap(), _InMemStorage_instances = new WeakSet(), _InMemStorage_withTxn = function* _InMemStorage_withTxn(fn) {
    const updates = {};
    const txn = new InMemTxn(__classPrivateFieldGet(this, _InMemStorage_data, "f"), updates);
    // abort case is that we don't catch the exception here:
    const result = yield* fn(txn);
    // commit case
    for (const [key, val] of Object.entries(updates)) {
        if (val === undefined) {
            delete __classPrivateFieldGet(this, _InMemStorage_data, "f")[key];
        }
        else {
            __classPrivateFieldGet(this, _InMemStorage_data, "f")[key] = val;
        }
    }
    return result;
};
class InMemTxn {
    constructor(data, updates) {
        _InMemTxn_data.set(this, void 0);
        _InMemTxn_updates.set(this, void 0);
        __classPrivateFieldSet(this, _InMemTxn_data, data, "f");
        __classPrivateFieldSet(this, _InMemTxn_updates, updates, "f");
    }
    get(key, cb) {
        if (key in __classPrivateFieldGet(this, _InMemTxn_updates, "f")) {
            cb({ value: __classPrivateFieldGet(this, _InMemTxn_updates, "f")[key] });
        }
        else {
            cb({ value: __classPrivateFieldGet(this, _InMemTxn_data, "f")[key] });
        }
    }
    set(key, value, cb) {
        __classPrivateFieldGet(this, _InMemTxn_updates, "f")[key] = value;
        cb({ value: true });
    }
    del(key, cb) {
        __classPrivateFieldGet(this, _InMemTxn_updates, "f")[key] = undefined;
        cb({ value: true });
    }
}
_InMemTxn_data = new WeakMap(), _InMemTxn_updates = new WeakMap();
//
class OverlayStorage {
    constructor(base) {
        _OverlayStorage_instances.add(this);
        _OverlayStorage_base.set(this, void 0);
        _OverlayStorage_data.set(this, {});
        __classPrivateFieldSet(this, _OverlayStorage_base, base, "f");
    }
    keys() {
        return Object.keys(__classPrivateFieldGet(this, _OverlayStorage_data, "f"));
    }
    *withWTxn(fx, fn) {
        return yield* __classPrivateFieldGet(this, _OverlayStorage_instances, "m", _OverlayStorage_withTxn).call(this, fx, fn);
    }
    *withRTxn(fx, fn) {
        return yield* __classPrivateFieldGet(this, _OverlayStorage_instances, "m", _OverlayStorage_withTxn).call(this, fx, fn);
    }
}
_OverlayStorage_base = new WeakMap(), _OverlayStorage_data = new WeakMap(), _OverlayStorage_instances = new WeakSet(), _OverlayStorage_withTxn = function* _OverlayStorage_withTxn(fx, fn) {
    // regardless of read/write status on the overlay txn, we only ever open a read txn on #base
    const self = this;
    return yield* __classPrivateFieldGet(this, _OverlayStorage_base, "f").withRTxn(fx, function* (baseTxn) {
        const updates = {};
        const txn = new OverlayTxn(baseTxn, __classPrivateFieldGet(self, _OverlayStorage_data, "f"), updates);
        // abort case is that we don't catch the exception here:
        const result = yield* fn(txn);
        // commit case
        for (const [key, val] of Object.entries(updates)) {
            // note: we must keep undefined values rather than propagate deletions to base
            __classPrivateFieldGet(self, _OverlayStorage_data, "f")[key] = val;
        }
        return result;
    });
};
class OverlayTxn {
    constructor(base, data, updates) {
        _OverlayTxn_base.set(this, void 0);
        _OverlayTxn_data.set(this, void 0);
        _OverlayTxn_updates.set(this, void 0);
        __classPrivateFieldSet(this, _OverlayTxn_base, base, "f");
        __classPrivateFieldSet(this, _OverlayTxn_data, data, "f");
        __classPrivateFieldSet(this, _OverlayTxn_updates, updates, "f");
    }
    get(key, cb) {
        if (key in __classPrivateFieldGet(this, _OverlayTxn_updates, "f")) {
            cb({ value: __classPrivateFieldGet(this, _OverlayTxn_updates, "f")[key] });
        }
        else if (key in __classPrivateFieldGet(this, _OverlayTxn_data, "f")) {
            cb({ value: __classPrivateFieldGet(this, _OverlayTxn_data, "f")[key] });
        }
        else {
            __classPrivateFieldGet(this, _OverlayTxn_base, "f").get(key, cb);
        }
    }
    set(key, value, cb) {
        __classPrivateFieldGet(this, _OverlayTxn_updates, "f")[key] = value;
        cb({ value: true });
    }
    del(key, cb) {
        __classPrivateFieldGet(this, _OverlayTxn_updates, "f")[key] = undefined;
        cb({ value: true });
    }
}
_OverlayTxn_base = new WeakMap(), _OverlayTxn_data = new WeakMap(), _OverlayTxn_updates = new WeakMap();

const NIBBLE = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
function generateUuid() {
    let out = '';
    if (crypto?.getRandomValues) {
        // Get 128 bits of randomness.
        const values = new Uint8Array(16);
        crypto.getRandomValues(values);
        // rfc4122 compliance: type 4 uuid
        values[6] = 0x40 | (values[6] & 0x0f);
        values[8] = 0x80 | (values[8] & 0x3f);
        values.forEach((x) => {
            out += NIBBLE[x >>> 4] + NIBBLE[x & 0x0f];
        });
    }
    else {
        out = new Array(32)
            .fill(null)
            .map(() => NIBBLE[Math.floor(Math.random() * NIBBLE.length)])
            .join('');
    }
    return [
        out.substring(0, 8),
        out.substring(8, 12),
        out.substring(12, 16),
        out.substring(16, 20),
        out.substring(20, 32),
    ].join('-');
}
function setdefault(obj, key, dfault) {
    if (key in obj) {
        return obj[key];
    }
    else {
        obj[key] = dfault;
        return dfault;
    }
}

// ProjectorContext looks like:
// yield* px.set.project(key, val): set new value (you only get to set it once per txn)
// yield* px.get.project(key): get the current value for key, possibly setting it from old
// yield* px.old.project(key): explicitly get the old value for key
// wrap a ProjectorGenerator so it acts like a WStorageGenerator, returning a set of updated keys
function* runProjector(g) {
    const old = {};
    const updates = {};
    let ans = { old: {}, get: {}, set: {}, del: {} };
    // inflight is for gets we have submitted but haven't received
    // (you can have many olds or gets in flight simultaneously, but only one set, and it cannot be
    //  simultaneous with any gets)
    let inflight = {};
    // delayedSets is for sets that were delayed because we had to do a get first
    let delayedSets = {};
    // pending is for answers we're trying to deliver
    // note: old may always be present, but get/set/del are mutually exclusive.
    // {key: pending_ops}
    let pending = {};
    let storageQuestion = { get: {}, set: {}, del: {} };
    // run the projector to completion
    while (true) {
        let ready = true;
        while (ready) {
            const { value, done } = g.next(ans);
            if (done)
                return Object.keys(updates);
            ans = { old: {}, get: {}, set: {}, del: {} };
            ready = false;
            for (const key of Object.keys(value.old ?? {})) {
                if (key in old) {
                    // we already know this one
                    ans.old[key] = old[key];
                    ready = true;
                }
                else if (!inflight[key]) {
                    inflight[key] = true;
                    storageQuestion.get[key] = true;
                    setdefault(pending, key, {}).old = true;
                }
            }
            for (const key of Object.keys(value.get ?? {})) {
                if (pending[key]?.set) {
                    ans.set[key] = { err: new Error('simultaneous set and get') };
                    ready = true;
                }
                else if (key in updates) {
                    // value was already set
                    ans.get[key] = updates[key];
                    ready = true;
                }
                else if (key in old) {
                    // an implicit set
                    updates[key] = old[key];
                    ans.get[key] = old[key];
                }
                else if (!inflight[key]) {
                    inflight[key] = true;
                    storageQuestion.get[key] = true;
                    setdefault(pending, key, {}).get = true;
                }
            }
            for (const [key, val] of Object.entries(value.set ?? {})) {
                const pnd = pending[key] ?? {};
                /*if (key in updates) {
                  ans.set[key] = {err: new Error('call to set after a get, set, or del')};
                  ready = true;
                } else */ if (pnd.set) {
                    ans.set[key] = { err: new Error('simultaneous sets') };
                    ready = true;
                }
                else if (pnd.del) {
                    ans.set[key] = { err: new Error('simultaneous set and del') };
                    ready = true;
                }
                else if (pnd.get) {
                    ans.set[key] = { err: new Error('simultaneous set and get') };
                    ready = true;
                }
                else {
                    if (!(key in old)) {
                        // do a get now, and a set later
                        storageQuestion.get[key] = true;
                        delayedSets[key] = val;
                    }
                    else {
                        // do the set immediately
                        storageQuestion.set[key] = val;
                    }
                    setdefault(pending, key, {}).set = true;
                    updates[key] = { value: val };
                }
            }
            for (const key of Object.keys(value.del ?? {})) {
                const pnd = pending[key] ?? {};
                /* if (key in updates) {
                  ans.set[key] = {err: new Error('call to set after a get, set, or del')};
                  ready = true;
                } else*/ if (pnd.del) {
                    ans.set[key] = { err: new Error('simultaneous deletes') };
                    ready = true;
                }
                else if (pnd.set) {
                    ans.set[key] = { err: new Error('simultaneous del and set') };
                    ready = true;
                }
                else if (pnd.get) {
                    ans.set[key] = { err: new Error('simultaneous del and get') };
                    ready = true;
                }
                else {
                    if (!(key in old)) {
                        // do a get now, and a del later
                        storageQuestion.get[key] = true;
                    }
                    else {
                        // do the del immediately
                        storageQuestion.del[key] = true;
                    }
                    setdefault(pending, key, {}).del = true;
                    updates[key] = { value: undefined };
                }
            }
        }
        // interact with storage until we have an answer to return to the projectors
        // TODO: this control flow has the weird effect that if parallel projector operations are in
        // flight, and one of those is a set or del requiring a get beforehand, we may likely only do
        // the get, then return control to the projector, and only start the set after it returns again.
        // But in practice, I think that is probably not a big concern.
        while (!ready) {
            const storageAnswer = yield storageQuestion;
            storageQuestion = { get: {}, set: {}, del: {} };
            for (const [key, val] of Object.entries(storageAnswer.get)) {
                // remember the answer for later
                old[key] = val;
                // done with this query
                delete inflight[key];
                const pnd = pending[key];
                let keepPending = undefined;
                // why did we need this again?
                // (note: get/set/del are mutually exclusive, but old is not)
                if (pnd.old) {
                    ans.old[key] = val;
                    ready = true;
                }
                if (pnd.get) {
                    ans.get[key] = val;
                    ready = true;
                }
                else if (pnd.set) {
                    // we needed to do a get before we did a set; issue the set now
                    storageQuestion.set[key] = delayedSets[key];
                    delete delayedSets[key];
                    // preserve only the pending .set=true
                    keepPending = { del: true };
                    pending[key] = { set: true };
                }
                else if (pnd.del) {
                    // we needed to do a get before we did a set; issue the set now
                    storageQuestion.del[key] = true;
                    // preserve only the pending .del=true
                    keepPending = { del: true };
                }
                if (keepPending) {
                    pending[key] = keepPending;
                }
                else {
                    delete pending[key];
                }
            }
            for (const [key, val] of Object.entries(storageAnswer.set)) {
                ans.set[key] = val;
                ready = true;
                // note: when we send the StorageQuestion for set, we already have the old value cached so
                // pending must have been only {set: true}.
                delete pending[key];
            }
            for (const [key, val] of Object.entries(storageAnswer.del)) {
                ans.del[key] = val;
                ready = true;
                // note: when we send the StorageQuestion for del, we already have the old value cached so
                // pending must have been only {del: true}.
                delete pending[key];
            }
        }
    }
}

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
var __Query_instances, __Query_subs, __Query_keyDeps, __Query_queryDeps, __Query_runs, __Query_result, __Query_fn, __Query_shouldSkip, _GraphRun_qx, _GraphRun_commitKeys, _GraphRun_ran, _QueryGraph_instances, _QueryGraph_qx, _QueryGraph_dirty, _QueryGraph_queries, _QueryGraph_newQueries, _QueryGraph_id, _QueryGraph_run, _QueryGraph_execute;
class _Query {
    constructor(id, fn) {
        __Query_instances.add(this);
        Object.defineProperty(this, "id", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "closed", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        __Query_subs.set(this, []);
        // {key: true}
        __Query_keyDeps.set(this, {});
        // {query_id: true}
        __Query_queryDeps.set(this, {});
        __Query_runs.set(this, 0);
        __Query_result.set(this, undefined);
        __Query_fn.set(this, void 0);
        this.id = id;
        __classPrivateFieldSet(this, __Query_fn, fn, "f");
    }
    // part of public api
    *awaitResult() {
        // don't try to coordinate our own #result vaule with the graph being executed; just use this as
        // an idiomatic way to ask the graph run for the result from our .id.
        const ans = yield { query: { [this.id]: true } };
        const [result] = ans.query[this.id];
        return result;
    }
    // part of public api
    subscribe(callback) {
        __classPrivateFieldGet(this, __Query_subs, "f").push(callback);
        return () => {
            __classPrivateFieldSet(this, __Query_subs, __classPrivateFieldGet(this, __Query_subs, "f").filter((x) => x !== callback), "f");
        };
    }
    // part of public api
    close() {
        this.closed = true;
    }
    // part of graph api
    *run(qx, commitKeys) {
        var _a;
        // shift current values to old values
        const oldResult = __classPrivateFieldGet(this, __Query_result, "f");
        __classPrivateFieldSet(this, __Query_runs, (_a = __classPrivateFieldGet(this, __Query_runs, "f"), _a++, _a), "f");
        if (yield* __classPrivateFieldGet(this, __Query_instances, "m", __Query_shouldSkip).call(this, commitKeys)) {
            return [__classPrivateFieldGet(this, __Query_result, "f"), false];
        }
        // rebuild deps
        __classPrivateFieldSet(this, __Query_keyDeps, {}, "f");
        __classPrivateFieldSet(this, __Query_queryDeps, {}, "f");
        const g = __classPrivateFieldGet(this, __Query_fn, "f").call(this, qx, oldResult, __classPrivateFieldGet(this, __Query_runs, "f") > 1);
        let ans = { query: {}, store: {} };
        // run query function to completion
        while (true) {
            // pass the current answer to the coroutine
            const { value, done } = g.next(ans);
            if (done) {
                __classPrivateFieldSet(this, __Query_result, value, "f");
                const dirty = (__classPrivateFieldGet(this, __Query_runs, "f") === 1) || (__classPrivateFieldGet(this, __Query_result, "f") !== oldResult);
                return [__classPrivateFieldGet(this, __Query_result, "f"), dirty];
            }
            // capture dependencies before yielding up to the graph for answers
            // {store: {storage_key: true}, query: {query_id: true}}
            for (const key of Object.keys(value.store ?? {})) {
                __classPrivateFieldGet(this, __Query_keyDeps, "f")[key] = true;
            }
            for (const qid of Object.keys(value.query ?? {})) {
                __classPrivateFieldGet(this, __Query_queryDeps, "f")[qid] = true;
            }
            // let the graph provide answers
            ans = yield value;
        }
    }
    // part of graph api
    notify() {
        if (this.closed)
            return;
        for (const sub of __classPrivateFieldGet(this, __Query_subs, "f")) {
            sub(__classPrivateFieldGet(this, __Query_result, "f"));
        }
    }
}
__Query_subs = new WeakMap(), __Query_keyDeps = new WeakMap(), __Query_queryDeps = new WeakMap(), __Query_runs = new WeakMap(), __Query_result = new WeakMap(), __Query_fn = new WeakMap(), __Query_instances = new WeakSet(), __Query_shouldSkip = function* __Query_shouldSkip(commitKeys) {
    if (__classPrivateFieldGet(this, __Query_runs, "f") === 1) {
        // this is our first time; always run
        return false;
    }
    // check if a key dependency was updated
    for (const key of Object.keys(__classPrivateFieldGet(this, __Query_keyDeps, "f"))) {
        if (key in commitKeys)
            return false;
    }
    // check if any query dependency changed its result
    for (const qid of Object.keys(__classPrivateFieldGet(this, __Query_queryDeps, "f"))) {
        const ans = yield { "query": { [qid]: true } };
        const [, dirty] = ans["query"][qid];
        if (dirty)
            return false;
    }
    return true;
};
/* GraphRun represents one run of the QueryGraph.  Having it as a separate object rather than a
   single generator function (as it once was written) allows a graph to be extended if new queries
   arrive */
class GraphRun {
    constructor(qx, commitKeys) {
        _GraphRun_qx.set(this, void 0);
        // {key: true}
        _GraphRun_commitKeys.set(this, void 0);
        // the [result, dirty] of queries which have ran
        // {query_id: [value, dirty]}
        _GraphRun_ran.set(this, {});
        __classPrivateFieldSet(this, _GraphRun_qx, qx, "f");
        __classPrivateFieldSet(this, _GraphRun_commitKeys, commitKeys, "f");
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
            const g = q.run(__classPrivateFieldGet(this, _GraphRun_qx, "f"), __classPrivateFieldGet(this, _GraphRun_commitKeys, "f"));
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
                        __classPrivateFieldGet(this, _GraphRun_ran, "f")[qid] = result;
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
                        if (id in __classPrivateFieldGet(this, _GraphRun_ran, "f")) {
                            // we already have this result
                            setdefault(runnable, qid, { query: {}, store: {} }).query[id] = __classPrivateFieldGet(this, _GraphRun_ran, "f")[id];
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
                const [, dirty] = __classPrivateFieldGet(this, _GraphRun_ran, "f")[q.id];
                if (dirty)
                    q.notify();
            }
        };
    }
}
_GraphRun_qx = new WeakMap(), _GraphRun_commitKeys = new WeakMap(), _GraphRun_ran = new WeakMap();
/* QueryGraph is responsible for tracking queries generated by the UI and rerunning them when new
   data is present.  It tracks dependencies of a query function by injecting a query context, which
   provides the actual key-value lookup capability to the function.  It is informed of changes to
   storage by the Midend, such as some keys being updated by the UI, keys of an old overlay being
   discarded, or new forecast data from the UI itself. */
class QueryGraph {
    constructor(qx) {
        _QueryGraph_instances.add(this);
        _QueryGraph_qx.set(this, void 0);
        _QueryGraph_dirty.set(this, {});
        _QueryGraph_queries.set(this, {});
        _QueryGraph_newQueries.set(this, []);
        _QueryGraph_id.set(this, 1);
        _QueryGraph_run.set(this, void 0);
        __classPrivateFieldSet(this, _QueryGraph_qx, qx, "f");
        // start with an empty graphrun
        __classPrivateFieldSet(this, _QueryGraph_run, new GraphRun(__classPrivateFieldGet(this, _QueryGraph_qx, "f"), {}), "f");
    }
    newQuery(fn) {
        var _a, _b;
        const id = `${__classPrivateFieldSet(this, _QueryGraph_id, (_b = __classPrivateFieldGet(this, _QueryGraph_id, "f"), _a = _b++, _b), "f"), _a}`;
        const q = new _Query(id, fn);
        __classPrivateFieldGet(this, _QueryGraph_queries, "f")[id] = q;
        __classPrivateFieldGet(this, _QueryGraph_newQueries, "f").push(q);
        return q;
    }
    dirty(keys) {
        for (const key of keys) {
            __classPrivateFieldGet(this, _QueryGraph_dirty, "f")[key] = true;
        }
    }
    *run() {
        // start a new graph run
        const commitKeys = __classPrivateFieldGet(this, _QueryGraph_dirty, "f");
        __classPrivateFieldSet(this, _QueryGraph_dirty, {}, "f");
        __classPrivateFieldSet(this, _QueryGraph_run, new GraphRun(__classPrivateFieldGet(this, _QueryGraph_qx, "f"), commitKeys), "f");
        // run against all queries
        const queries = Object.values(__classPrivateFieldGet(this, _QueryGraph_queries, "f"));
        __classPrivateFieldSet(this, _QueryGraph_newQueries, [], "f");
        return yield* __classPrivateFieldGet(this, _QueryGraph_instances, "m", _QueryGraph_execute).call(this, queries);
    }
    *extend() {
        // extend an existing graph run with only new queries
        const queries = __classPrivateFieldGet(this, _QueryGraph_newQueries, "f");
        __classPrivateFieldSet(this, _QueryGraph_newQueries, [], "f");
        return yield* __classPrivateFieldGet(this, _QueryGraph_instances, "m", _QueryGraph_execute).call(this, queries);
    }
}
_QueryGraph_qx = new WeakMap(), _QueryGraph_dirty = new WeakMap(), _QueryGraph_queries = new WeakMap(), _QueryGraph_newQueries = new WeakMap(), _QueryGraph_id = new WeakMap(), _QueryGraph_run = new WeakMap(), _QueryGraph_instances = new WeakSet(), _QueryGraph_execute = function* _QueryGraph_execute(queries) {
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
    return yield* __classPrivateFieldGet(this, _QueryGraph_run, "f").run(queries);
};

var _FutureContext_coro, _FutureContext_awake;
/* A FutureContext corresponds to the first generator in our callstack.  Though it may be delegating
   yields to some child generator through yield* statements, when a condition is met to wake up the
   child, the .next() has to be sent to the root generator, not the child (or grandchild).

   FutureContext makes that trivial. */
class FutureContext {
    constructor(coro) {
        _FutureContext_coro.set(this, void 0);
        _FutureContext_awake.set(this, false);
        __classPrivateFieldSet(this, _FutureContext_coro, coro, "f");
    }
    wakeup() {
        // disallow calls to the base wakeup from inside the base wakeup
        if (__classPrivateFieldGet(this, _FutureContext_awake, "f"))
            return;
        __classPrivateFieldSet(this, _FutureContext_awake, true, "f");
        try {
            __classPrivateFieldGet(this, _FutureContext_coro, "f").next();
        }
        finally {
            __classPrivateFieldSet(this, _FutureContext_awake, false, "f");
        }
    }
    throw(e) {
        // if we're actually inside the coro, throw the error now
        if (__classPrivateFieldGet(this, _FutureContext_awake, "f"))
            throw (e);
        __classPrivateFieldSet(this, _FutureContext_awake, true, "f");
        try {
            __classPrivateFieldGet(this, _FutureContext_coro, "f").throw(e);
        }
        finally {
            __classPrivateFieldSet(this, _FutureContext_awake, false, "f");
        }
    }
}
_FutureContext_coro = new WeakMap(), _FutureContext_awake = new WeakMap();

var _Framework_instances, _Framework_storage, _Framework_shaper, _Framework_projector, _Framework_forecaster, _Framework_forecastKey, _Framework_onCommands, _Framework_overlay, _Framework_graph, _Framework_coro, _Framework_fx, _Framework_scheduled, _Framework_reconnects, _Framework_recvdEvents, _Framework_recvdCommands, _Framework_sentCommands, _Framework_forecasts, _Framework_newQueries, _Framework_schedule, _Framework_initialize, _Framework_advancer, _Framework_onRecvEvents, _Framework_onSendCommands, _Framework_onSentCommands, _Framework_onNewQueries, _Framework_onReconnects;
// "P"rojectorConte"x"t
// "Q"ueryConte"x"t
// "E"vents
// "C"ommands
// check"P"oint
class Framework {
    constructor(typeset, storage, callbacks) {
        _Framework_instances.add(this);
        _Framework_storage.set(this, void 0);
        _Framework_shaper.set(this, void 0);
        _Framework_projector.set(this, void 0); // wrapper around user's projector
        _Framework_forecaster.set(this, void 0);
        _Framework_forecastKey.set(this, void 0);
        _Framework_onCommands.set(this, void 0);
        _Framework_overlay.set(this, void 0);
        _Framework_graph.set(this, void 0);
        _Framework_coro.set(this, void 0);
        _Framework_fx.set(this, void 0);
        _Framework_scheduled.set(this, false);
        // #reconnects is a list of promise resolve functions
        _Framework_reconnects.set(this, []);
        _Framework_recvdEvents.set(this, []);
        _Framework_recvdCommands.set(this, []);
        _Framework_sentCommands.set(this, []);
        _Framework_forecasts.set(this, new Map());
        // just a flag if new queries exist to be run; we don't store them here for typing purposes.
        _Framework_newQueries.set(this, false);
        __classPrivateFieldSet(this, _Framework_storage, storage, "f");
        __classPrivateFieldSet(this, _Framework_shaper, callbacks.shaper, "f");
        __classPrivateFieldSet(this, _Framework_projector, (events) => callbacks.projector(typeset.px, events), "f");
        __classPrivateFieldSet(this, _Framework_forecaster, callbacks.forecaster ?? null, "f");
        __classPrivateFieldSet(this, _Framework_forecastKey, callbacks.forecastKey ?? null, "f");
        __classPrivateFieldSet(this, _Framework_onCommands, callbacks.onCommands ?? null, "f");
        if (__classPrivateFieldGet(this, _Framework_forecaster, "f") && !__classPrivateFieldGet(this, _Framework_forecastKey, "f")) {
            throw new Error("forecastKey is required if forecast is set");
        }
        __classPrivateFieldSet(this, _Framework_overlay, new OverlayStorage(__classPrivateFieldGet(this, _Framework_storage, "f")), "f");
        __classPrivateFieldSet(this, _Framework_graph, new QueryGraph(typeset.qx), "f");
        __classPrivateFieldSet(this, _Framework_coro, __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_advancer).call(this), "f");
        __classPrivateFieldSet(this, _Framework_fx, new FutureContext(__classPrivateFieldGet(this, _Framework_coro, "f")), "f");
        // let the advancer begin initializing
        __classPrivateFieldGet(this, _Framework_fx, "f").wakeup();
    }
    //// public api ////
    // request info needed to resume a connection: last committed checkpoint and unsent commands
    reconnect() {
        return new Promise((resolve) => {
            __classPrivateFieldGet(this, _Framework_reconnects, "f").push(resolve);
        });
    }
    // new events from the wire come here
    recvEvents(events) {
        __classPrivateFieldGet(this, _Framework_recvdEvents, "f").push.apply(__classPrivateFieldGet(this, _Framework_recvdEvents, "f"), events);
        __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_schedule).call(this);
    }
    // after forecasting and saving to storage, these will appear in an onCommands() callback
    sendCommands(commands) {
        if (!__classPrivateFieldGet(this, _Framework_onCommands, "f")) {
            throw new Error("sendCommands() used but onCommands callback was not set");
        }
        __classPrivateFieldGet(this, _Framework_recvdCommands, "f").push.apply(commands);
        __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_schedule).call(this);
    }
    // add a new Query to the graph
    newQuery(fn) {
        __classPrivateFieldSet(this, _Framework_newQueries, true, "f");
        __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_schedule).call(this);
        return __classPrivateFieldGet(this, _Framework_graph, "f").newQuery(fn);
    }
}
_Framework_storage = new WeakMap(), _Framework_shaper = new WeakMap(), _Framework_projector = new WeakMap(), _Framework_forecaster = new WeakMap(), _Framework_forecastKey = new WeakMap(), _Framework_onCommands = new WeakMap(), _Framework_overlay = new WeakMap(), _Framework_graph = new WeakMap(), _Framework_coro = new WeakMap(), _Framework_fx = new WeakMap(), _Framework_scheduled = new WeakMap(), _Framework_reconnects = new WeakMap(), _Framework_recvdEvents = new WeakMap(), _Framework_recvdCommands = new WeakMap(), _Framework_sentCommands = new WeakMap(), _Framework_forecasts = new WeakMap(), _Framework_newQueries = new WeakMap(), _Framework_instances = new WeakSet(), _Framework_schedule = function _Framework_schedule() {
    if (__classPrivateFieldGet(this, _Framework_scheduled, "f"))
        return;
    __classPrivateFieldSet(this, _Framework_scheduled, true, "f");
    setTimeout(() => {
        __classPrivateFieldSet(this, _Framework_scheduled, false, "f");
        __classPrivateFieldGet(this, _Framework_fx, "f").wakeup();
    });
}, _Framework_initialize = function* _Framework_initialize() {
    const self = this;
    if (!__classPrivateFieldGet(this, _Framework_forecaster, "f"))
        return;
    // load unset commands from storage
    const commands = [];
    yield* withRTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_storage, "f"), function* () {
        const index = (yield* txnGet(".commands")) ?? {};
        for (const uuid of Object.keys(index)) {
            // TODO: convert from json for typed return value
            const batch = yield* txnGet(`.command-${uuid}`);
            commands.push.apply(batch);
        }
    });
    if (commands.length === 0)
        return;
    // forecast events
    const forecasts = __classPrivateFieldGet(this, _Framework_forecaster, "f").call(this, commands);
    if (forecasts.length === 0)
        return;
    // remember these forecasts for later
    for (const forecast of forecasts) {
        const key = __classPrivateFieldGet(this, _Framework_forecastKey, "f")(forecast);
        __classPrivateFieldGet(this, _Framework_forecasts, "f").set(key, forecast);
    }
    // populate the initial overlay
    yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
        yield* runProjector(__classPrivateFieldGet(self, _Framework_projector, "f").call(self, forecasts));
        // ignore updated keys and don't trigger a run of the graph; let that happen as part of the
        // normal newQuery processing
    });
}, _Framework_advancer = function
// our main logic is implemented as a coroutine
* _Framework_advancer() {
    yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_initialize).call(this);
    // what are the different things we can have to do?
    // - receive events,
    //     - then shape them,
    //     - then pass shaped events into projectors,
    //     - then commit that result along with the checkpoint,
    //     - then take the commit and pass it to the query graph
    // - recieve sentCommands and update commands in storage
    // - receive sendCommands
    //     - then commit them to storage,
    //         - then send those to onCommand hook
    //     - then forecast events,
    //     - then pass them to projectors,
    //     - then commit that result to the overlay
    //     - then pass that commit to the query graph
    // - recieve a new query
    //     - extend the graph
    // - recieve a reconnect request
    //     - then return the checkpoint in storage
    while (true) {
        if (__classPrivateFieldGet(this, _Framework_recvdEvents, "f").length > 0) {
            yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_onRecvEvents).call(this);
            continue;
        }
        if (__classPrivateFieldGet(this, _Framework_recvdCommands, "f").length > 0) {
            yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_onSendCommands).call(this);
            continue;
        }
        if (__classPrivateFieldGet(this, _Framework_sentCommands, "f").length > 0) {
            yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_onSentCommands).call(this);
            continue;
        }
        if (__classPrivateFieldGet(this, _Framework_newQueries, "f")) {
            yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_onNewQueries).call(this);
            continue;
        }
        if (__classPrivateFieldGet(this, _Framework_reconnects, "f").length > 0) {
            yield* __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_onReconnects).call(this);
            continue;
        }
        // if we got here we probably had a spurious wakeup
        yield;
    }
}, _Framework_onRecvEvents = function* _Framework_onRecvEvents() {
    const self = this;
    // input shaping step, which also produces a checkpoint
    const { events, checkpoint } = __classPrivateFieldGet(this, _Framework_shaper, "f").call(this, __classPrivateFieldGet(this, _Framework_recvdEvents, "f"));
    __classPrivateFieldSet(this, _Framework_recvdEvents, [], "f");
    // open a write txn to real storage
    // IDEA: what if we wrote a txn wrapper that could automatically allow high-value gets/sets to
    // happen in between the normal gets/sets?
    const updates = yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_storage, "f"), function* () {
        // update our checkpoint when this txn finishes
        yield* txnSet(".checkpoint", checkpoint);
        // run the projector with our new events
        return yield* runProjector(__classPrivateFieldGet(self, _Framework_projector, "f").call(self, events));
    });
    __classPrivateFieldGet(this, _Framework_graph, "f").dirty(updates);
    // our old overlay is now invalid; start a new one
    __classPrivateFieldGet(this, _Framework_graph, "f").dirty(__classPrivateFieldGet(this, _Framework_overlay, "f").keys());
    __classPrivateFieldSet(this, _Framework_overlay, new OverlayStorage(__classPrivateFieldGet(this, _Framework_storage, "f")), "f");
    // clean up now-irrelevant forecasts
    if (__classPrivateFieldGet(this, _Framework_forecasts, "f").size > 0) {
        for (const event of events) {
            const key = __classPrivateFieldGet(this, _Framework_forecastKey, "f")(event);
            __classPrivateFieldGet(this, _Framework_forecasts, "f").delete(key);
        }
    }
    // rebuild overlay using all remaining forecasts
    if (__classPrivateFieldGet(this, _Framework_forecasts, "f").size > 0) {
        yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
            const updates = yield* runProjector(__classPrivateFieldGet(self, _Framework_projector, "f").call(self, [...__classPrivateFieldGet(self, _Framework_forecasts, "f").values()]));
            __classPrivateFieldGet(self, _Framework_graph, "f").dirty(updates);
        });
    }
    const cbs = yield* withRTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
        // this will run all queries, even new ones
        __classPrivateFieldSet(self, _Framework_newQueries, false, "f");
        return yield* __classPrivateFieldGet(self, _Framework_graph, "f").run();
    });
    cbs();
}, _Framework_onSendCommands = function* _Framework_onSendCommands() {
    const self = this;
    const commands = __classPrivateFieldGet(this, _Framework_recvdCommands, "f");
    __classPrivateFieldSet(this, _Framework_recvdCommands, [], "f");
    const uuid = generateUuid();
    // open a write txn to real storage
    yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_storage, "f"), function* () {
        // save a batch of commands
        // TODO: convert to json for untyped access
        yield* txnSet(`.command-${uuid}`, commands);
        // extend the index of batches
        const index = (yield* txnGet(".commands")) ?? {};
        yield* txnSet(`.commands`, { ...index, uuid: true });
    });
    // define a hook to trigger cleanup when those commands are actually sent
    const onSent = () => {
        __classPrivateFieldGet(this, _Framework_sentCommands, "f").push(uuid);
        __classPrivateFieldGet(this, _Framework_instances, "m", _Framework_schedule).call(this);
    };
    // now forecast events based on those commands
    if (__classPrivateFieldGet(this, _Framework_forecaster, "f")) {
        const forecasts = __classPrivateFieldGet(this, _Framework_forecaster, "f").call(this, commands);
        if (forecasts.length > 0) {
            // remember these forecasts for later
            for (const forecast of forecasts) {
                const key = __classPrivateFieldGet(this, _Framework_forecastKey, "f")(forecast);
                __classPrivateFieldGet(this, _Framework_forecasts, "f").set(key, forecast);
            }
            // open a write txn against the existing overlay
            const updates = yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
                return yield* runProjector(__classPrivateFieldGet(self, _Framework_projector, "f").call(self, forecasts));
            });
            __classPrivateFieldGet(this, _Framework_graph, "f").dirty(updates);
            const cbs = yield* withRTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
                // this will run all queries, even new ones
                __classPrivateFieldSet(self, _Framework_newQueries, false, "f");
                return yield* __classPrivateFieldGet(self, _Framework_graph, "f").run();
            });
            cbs();
        }
    }
    // schedule a callback for the user to know it is time to send the commands
    setTimeout(() => __classPrivateFieldGet(this, _Framework_onCommands, "f")(commands, onSent));
}, _Framework_onSentCommands = function* _Framework_onSentCommands() {
    const self = this;
    yield* withWTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_storage, "f"), function* () {
        // load the index of batches of commands
        const index = (yield* txnGet(".commands")) ?? {};
        // delete any batches we know to be sent
        let uuid;
        while ((uuid = __classPrivateFieldGet(self, _Framework_sentCommands, "f").shift())) {
            yield* txnDel(`.command-${uuid}`);
            delete index[uuid];
        }
        // update the index
        yield* txnSet(".commands", index);
    });
}, _Framework_onNewQueries = function* _Framework_onNewQueries() {
    const self = this;
    const cbs = yield* withRTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_overlay, "f"), function* () {
        __classPrivateFieldSet(self, _Framework_newQueries, false, "f");
        return yield* __classPrivateFieldGet(self, _Framework_graph, "f").extend();
    });
    cbs();
}, _Framework_onReconnects = function* _Framework_onReconnects() {
    const { checkpoint, commands } = yield* withRTxn(__classPrivateFieldGet(this, _Framework_fx, "f"), __classPrivateFieldGet(this, _Framework_storage, "f"), function* () {
        const checkpoint = (yield* txnGet(".checkpoint"));
        const commands = [];
        const index = (yield* txnGet(".commands")) ?? {};
        for (const uuid of Object.keys(index)) {
            // TODO: convert from json for typed return value
            const batch = yield* txnGet(`.command-${uuid}`);
            commands.push.apply(batch);
        }
        return { checkpoint, commands };
    });
    for (const resolve of __classPrivateFieldGet(this, _Framework_reconnects, "f")) {
        resolve({ checkpoint, commands });
    }
    __classPrivateFieldSet(this, _Framework_reconnects, [], "f");
};

/*

from: https://github.com/ddd-by-examples/library

A public library allows patrons to place books on hold at its various library branches. Available
books can be placed on hold only by one patron at any given point in time. Books are either
circulating or restricted, and can have retrieval or usage fees. A restricted book can only be held
by a researcher patron. A regular patron is limited to five holds at any given moment, while a
researcher patron is allowed an unlimited number of holds. An open-ended book hold is active until
the patron checks out the book, at which time it is completed. A closed-ended book hold that is not
completed within a fixed number of days after it was requested will expire. This check is done at
the beginning of a day by taking a look at daily sheet with expiring holds. Only a researcher patron
can request an open-ended hold duration. Any patron with more than two overdue checkouts at a
library branch will get a rejection if trying a hold at that same library branch. A book can be
checked out for up to 60 days. Check for overdue checkouts is done by taking a look at daily sheet
with overdue checkouts. Patron interacts with his/her current holds, checkouts, etc. by taking a
look at patron profile. Patron profile looks like a daily sheet, but the information there is
limited to one patron and is not necessarily daily. Currently a patron can see current holds (not
canceled nor expired) and current checkouts (including overdue).  Also, he/she is able to hold a
book and cancel a hold.

How actually a patron knows which books are there to lend? Library has its catalogue of books where
books are added together with their specific instances. A specific book instance of a book can be
added only if there is book with matching ISBN already in the catalogue. Book must have non-empty
title and price. At the time of adding an instance we decide whether it will be Circulating or
Restricted. This enables us to have book with same ISBN as circulated and restricted at the same
time (for instance, there is a book signed by the author that we want to keep as Restricted)

*/
function* projectAddEdition(px, e) {
    // add this edition
    yield* px.set.edition(e.isbn, {
        isbn: e.isbn,
        title: e.title,
        books: {},
        holds: {},
    });
    // create new edition
    const editions = (yield* px.get.editions()) ?? {}; // TODO: maybe formalize migrations somehow?
    editions[e.isbn] = true;
    yield* px.set.editions(editions);
}
function* projectUpdateEditionTitle(px, e) {
    const edition = yield* px.get.edition(e.isbn);
    edition.title = e.title;
    yield* px.set.edition(e.isbn, edition);
}
function* projectAddBook(px, e) {
    // create new book
    yield* px.set.book(e.id, {
        id: e.id,
        isbn: e.isbn,
        restricted: e.restricted,
    });
    // add book to edition
    const edition = yield* px.get.edition(e.isbn);
    edition.books[e.id] = true;
    yield* px.set.edition(e.isbn, edition);
}
function* projectUpdateBookRestricted(px, e) {
    const book = yield* px.get.book(e.id);
    book.restricted = e.restricted;
    yield* px.set.book(e.id, book);
}
function* projectRemoveBook(px, e) {
    const book = yield* px.get.book(e.id);
    yield* px.del.book(e.id);
    // just remove from edition
    const edition = yield* px.get.edition(book.isbn);
    delete edition.books[e.id];
    yield* px.set.edition(book.isbn, edition);
}
function* projectAddPatron(px, e) {
    yield* px.set.patron(e.id, {
        id: e.id,
        name: e.name,
        researcher: e.researcher,
        checkouts: {},
        holds: {},
    });
}
function* projectRenamePatron(px, e) {
    const patron = yield* px.get.patron(e.id);
    patron.name = e.name;
    yield* px.set.patron(e.id, patron);
}
// returns nowInvalidHolds
function* projectAssignPatron(px, e) {
    const patron = yield* px.get.patron(e.id);
    patron.researcher = e.researcher;
    // check for now-invalid holds
    const invalidHolds = [];
    for (const hold_uuid of Object.keys(patron.holds)) {
        const hold = yield* px.get.hold(hold_uuid); // TODO: fix types
        if ("edition" in hold.target)
            continue;
        const book = yield* px.get.book(hold.target.book); // TODO: fix types
        if (!book.restricted)
            continue;
        invalidHolds.push(hold_uuid);
    }
    yield* px.set.patron(e.id, patron);
    return invalidHolds;
}
// reusable for either status or vstatus stores
function* projectOverdueCheckout(px, e) {
    const checkout = yield* px.get.checkout(e.checkout); // TODO: fix types
    checkout.overdue = true;
    yield* px.set.checkout(e.checkout, checkout);
}
function* projectNewVHold(px, e) {
    const hold = {
        id: e.id,
        target: e.target,
    };
    if (e.patron)
        hold.patron = e.patron;
    yield* px.set.hold(e.id, hold);
}
function* projectVHoldRejected(px, e) {
    // TODO: handle this
    console.log(px, e);
}
function* projectVEndHold(px, e) {
    // look up the hold
    const hold = yield* px.get.hold(e.hold);
    // be idempotent
    if (!hold)
        return;
    // delete the hold
    yield* px.del.hold(e.hold);
    // update hold target (book or edition)
    if ("book" in hold.target) {
        const book = yield* px.get.book(hold.target.book);
        delete book.status;
        yield* px.set.book(hold.target.book, book);
    }
    else {
        const edition = yield* px.get.edition(hold.target.edition);
        delete edition.holds[e.hold];
        yield* px.set.edition(hold.target.edition, edition);
    }
    // update patron
    if (hold.patron) {
        const patron = yield* px.get.patron(hold.patron);
        delete patron.holds[hold.id];
        yield* px.set.patron(hold.patron, patron);
    }
}
function* projectNewVCheckout(px, e) {
    console.log("handling new vcheckout");
    const checkout = {
        id: e.id,
        book: e.book,
        expires: e.expires,
        overdue: false,
    };
    if (e.patron) {
        checkout.patron = e.patron;
        // also update our patron object
        const patron = yield* px.get.patron(e.patron);
        patron.checkouts[e.id] = true;
        yield* px.set.patron(e.patron, patron);
    }
    yield* px.set.checkout(e.id, checkout);
}
function* projectVEndCheckout(px, e) {
    const checkout = yield* px.get.checkout(e.checkout);
    /* no need for idempotency; only the front desk can end a checkout and that system should
       guarantee exactly-once behavior */
    yield* px.del.checkout(e.checkout);
    // update book
    const book = yield* px.get.book(checkout.book);
    delete book.status;
    yield* px.set.book(checkout.book, book);
    // update patron
    if (checkout.patron) {
        const patron = yield* px.get.patron(checkout.patron);
        delete patron.checkouts[checkout.id];
        yield* px.set.patron(checkout.patron, patron);
    }
}
// client composition
function* clientProjector(px, events) {
    for (const e of events) {
        // extend read model
        switch (e.type) {
            case "add-edition":
                yield* projectAddEdition(px, e);
                break;
            case "update-edition-title":
                yield* projectUpdateEditionTitle(px, e);
                break;
            case "add-book":
                yield* projectAddBook(px, e);
                break;
            case "update-book-restricted":
                yield* projectUpdateBookRestricted(px, e);
                break;
            case "remove-book":
                yield* projectRemoveBook(px, e);
                break;
            case "add-patron":
                yield* projectAddPatron(px, e);
                break;
            case "rename-patron":
                yield* projectRenamePatron(px, e);
                break;
            case "assign-patron":
                yield* projectAssignPatron(px, e);
                break;
            case "new-vhold":
                yield* projectNewVHold(px, e);
                break;
            case "vhold-rejected":
                yield* projectVHoldRejected(px, e);
                break;
            case "cancel-hold": // fallthru
            case "expire-hold":
                yield* projectVEndHold(px, e);
                break;
            case "new-vcheckout":
                yield* projectNewVCheckout(px, e);
                break;
            case "end-checkout":
                yield* projectVEndCheckout(px, e);
                break;
            case "overdue-checkout":
                yield* projectOverdueCheckout(px, e);
                break;
            // events we aren't allowed to receive
            case "try-hold":
            case "try-checkout":
                break;
            default:
                const _typecheck = e;
                return _typecheck;
        }
    }
}

function* queryGet(key) {
    const ans = yield { 'store': { [key]: true } };
    const sv = ans.store[key];
    if ('err' in sv)
        throw sv.err;
    return sv.value;
}
function* projectorOld(key) {
    const ans = yield { 'old': { [key]: true } };
    const sv = ans.old[key];
    if ('err' in sv)
        throw sv.err;
    return sv.value;
}
function* projectorGet(key) {
    const ans = yield { 'get': { [key]: true } };
    const sv = ans.get[key];
    if ('err' in sv)
        throw sv.err;
    return sv.value;
}
function* projectorSet(key, value) {
    const ans = yield { 'set': { [key]: value } };
    const sv = ans.set[key];
    if ('err' in sv)
        throw sv.err;
}
function* projectorDel(key) {
    const ans = yield { 'del': { [key]: true } };
    const sv = ans.del[key];
    if ('err' in sv)
        throw sv.err;
}
const BookStoreQueryContext = {
    get: {
        book: (book_uuid) => queryGet(`book.${book_uuid}`),
        edition: (edition_isbn) => queryGet(`edition.${edition_isbn}`),
        editions: () => queryGet(`editions`),
    },
};
const BookStoreProjectorContext = {
    old: {
        book: (book_uuid) => projectorOld(`book.${book_uuid}`),
        edition: (edition_isbn) => projectorOld(`edition.${edition_isbn}`),
        editions: () => projectorOld(`editions`),
    },
    get: {
        book: (book_uuid) => projectorGet(`book.${book_uuid}`),
        edition: (edition_isbn) => projectorGet(`edition.${edition_isbn}`),
        editions: () => projectorGet(`editions`),
    },
    set: {
        book: (book_uuid, value) => projectorSet(`book.${book_uuid}`, value),
        edition: (edition_isbn, value) => projectorSet(`edition.${edition_isbn}`, value),
        editions: (value) => projectorSet(`editions`, value),
    },
    del: {
        book: (book_uuid) => projectorDel(`book.${book_uuid}`),
        edition: (edition_isbn) => projectorDel(`edition.${edition_isbn}`),
    },
};
const PatronStoreQueryContext = {
    get: {
        patron: (patron_uuid) => queryGet(`patron.${patron_uuid}`),
        patrons: () => queryGet(`patrons`),
    },
};
const PatronStoreProjectorContext = {
    old: {
        patron: (patron_uuid) => projectorOld(`patron.${patron_uuid}`),
        patrons: () => projectorOld(`patrons`),
    },
    get: {
        patron: (patron_uuid) => projectorGet(`patron.${patron_uuid}`),
        patrons: () => projectorGet(`patrons`),
    },
    set: {
        patron: (patron_uuid, value) => projectorSet(`patron.${patron_uuid}`, value),
        patrons: (value) => projectorSet(`patrons`, value),
    },
    del: {
        patron: (patron_uuid) => projectorDel(`patron.${patron_uuid}`),
    },
};
const VStatusStoreQueryContext = {
    get: {
        checkout: (checkout_uuid) => queryGet(`checkout.${checkout_uuid}`),
        hold: (hold_uuid) => queryGet(`hold.${hold_uuid}`),
    },
};
const VStatusStoreProjectorContext = {
    old: {
        checkout: (checkout_uuid) => projectorOld(`checkout.${checkout_uuid}`),
        hold: (hold_uuid) => projectorOld(`hold.${hold_uuid}`),
    },
    get: {
        checkout: (checkout_uuid) => projectorGet(`checkout.${checkout_uuid}`),
        hold: (hold_uuid) => projectorGet(`hold.${hold_uuid}`),
    },
    set: {
        checkout: (checkout_uuid, value) => projectorSet(`checkout.${checkout_uuid}`, value),
        hold: (hold_uuid, value) => projectorSet(`hold.${hold_uuid}`, value),
    },
    del: {
        checkout: (checkout_uuid) => projectorDel(`checkout.${checkout_uuid}`),
        hold: (hold_uuid) => projectorDel(`hold.${hold_uuid}`),
    },
};
const UserStoreQueryContext = {
    get: {
        ...BookStoreQueryContext.get,
        ...PatronStoreQueryContext.get,
        ...VStatusStoreQueryContext.get,
    },
};
const UserStoreProjectorContext = {
    old: {
        ...BookStoreProjectorContext.old,
        ...PatronStoreProjectorContext.old,
        ...VStatusStoreProjectorContext.old,
    },
    get: {
        ...BookStoreProjectorContext.get,
        ...PatronStoreProjectorContext.get,
        ...VStatusStoreProjectorContext.get,
    },
    set: {
        ...BookStoreProjectorContext.set,
        ...PatronStoreProjectorContext.set,
        ...VStatusStoreProjectorContext.set,
    },
    del: {
        ...BookStoreProjectorContext.del,
        ...PatronStoreProjectorContext.del,
        ...VStatusStoreProjectorContext.del,
    },
};

const typeset = {
    px: UserStoreProjectorContext,
    qx: UserStoreQueryContext,
    isEvent(_) { return true; },
    isCommand(_) { return true; },
};
const storage = new InMemStorage();
new Framework(typeset, storage, {
    shaper(events) {
        return { events, checkpoint: null };
    },
    projector: clientProjector,
});

function putValue(val) {
  switch(typeof(val)) {
    case "boolean": return glue.putBoolean(val);
    case "string": return glue.putString(val);
    case "number": return glue.putNumber(val);
    case "bigint": return glue.putBigInt(val);
    case "undefined": return glue.putNull();
    case "object":
      if (val === null) return glue.putNull();
      if (Array.isArray(val)) {
        glue.openArray(val.length);
        for (let i = 0; i < val.length; i++){
          console.log('putting', i, val[i])
          putValue(val[i]);
          glue.putItem(i);
        }
        return glue.putArray(val.length);
      }
      const entries = Object.entries(val);
      glue.openObject(entries.length);
      for (const [k, v] of entries) {
        putValue(v);
        glue.putKey(k);
      }
      return glue.putObject(entries.length);
  }
  throw new Error("unrecognized type: " + typeof(val));
}

console.log("console.log working?", {a: 1, b: 2})

putValue({a: 8, b:7, c:5})

// define a setTimeout
const _todo = [];
function setTimeout(fn) {
  todo.push(fn)
}

// final value is returned to script
function run() {
  let fn;
  while((fn = todo.shift())) {
    fn();
  }
}
