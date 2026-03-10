// utils //////////////////////////////////////////////////////////////////////

export function setdefault<T>(obj: Record<string, T>, key: string, dfault: T): T {
  if (key in obj) {
    return obj[key];
  } else {
    obj[key] = dfault;
    return dfault;
  }
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
  let ans: StorageAnswer = {get: {}, set: {}, del: {}};
  let ready = false;
  try {
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

//

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

// projectors /////////////////////////////////////////////////////////////////

export type ProjectorQuestion = {
  // keys to look up
  old?: Record<string, true>,
  // keys to look up
  get?: Record<string, true>,
  // key-values to set
  set?: Record<string, unknown>,
  // key-values to delete
  del?: Record<string, true>,
};

export type ProjectorAnswer = {
  old: Record<string, StorageValue>,
  // key-value lookup results
  get: Record<string, StorageValue>,
  // keys done setting
  set: Record<string, StorageDone>,
  // keys done deleting
  del: Record<string, StorageDone>,
};

export type ProjectorGenerator<T> = Generator<ProjectorQuestion, T, ProjectorAnswer>;
// ProjectorContext looks like:
// yield* px.set.project(key, val): set new value (you only get to set it once per txn)
// yield* px.get.project(key): get the current value for key, possibly setting it from old
// yield* px.old.project(key): explicitly get the old value for key

// wrap a ProjectorGenerator so it acts like a WStorageGenerator, returning a set of updated keys
export function *runProjector(g: ProjectorGenerator<void>): WStorageGenerator<string[]> {
  const old: Record<string, StorageValue> = {};
  const updates: Record<string, StorageValue> = {};

  let ans: ProjectorAnswer = {old: {}, get: {}, set: {}, del: {}};
  // inflight is for gets we have submitted but haven't received
  // (you can have many olds or gets in flight simultaneously, but only one set, and it cannot be
  //  simultaneous with any gets)
  let inflight: Record<string, true> = {};
  // delayedSets is for sets that were delayed because we had to do a get first
  let delayedSets: Record<string, unknown> = {};
  // pending is for answers we're trying to deliver
  // note: old may always be present, but get/set/del are mutually exclusive.
  // {key: pending_ops}
  let pending: Record<string, {old?: true, get?: true, set?: true, del?: true}> = {};
  let storageQuestion: WStorageQuestion = {get: {}, set: {}, del: {}};

  // run the projector to completion
  while (true) {
    let ready = true;
    while (ready) {
      const {value, done} = g.next(ans);
      if (done) return Object.keys(updates);

      ans = {old: {}, get: {}, set: {}, del: {}};
      ready = false;

      for (const key of Object.keys(value.old ?? {})) {
        if (key in old) {
          // we already know this one
          ans.old[key] = old[key];
          ready = true;
        } else if (!inflight[key]) {
          inflight[key] = true;
          storageQuestion.get![key] = true;
          setdefault(pending, key, {}).old = true;
        }
      }

      for (const key of Object.keys(value.get ?? {})) {
        if (pending[key]?.set) {
          ans.set[key] = {err: new Error('simultaneous set and get')};
          ready = true;
        } else if (key in updates) {
          // value was already set
          ans.get[key] = updates[key];
          ready = true;
        } else if (key in old) {
          // an implicit set
          updates[key] = old[key];
          ans.get[key] = old[key];
        } else if (!inflight[key]) {
          inflight[key] = true;
          storageQuestion.get![key] = true;
          setdefault(pending, key, {}).get = true;
        }
      }

      for (const [key, val] of Object.entries(value.set ?? {})) {
        const pnd = pending[key] ?? {};
        /*if (key in updates) {
          ans.set[key] = {err: new Error('call to set after a get, set, or del')};
          ready = true;
        } else */ if (pnd.set) {
          ans.set[key] = {err: new Error('simultaneous sets')};
          ready = true;
        } else if (pnd.del) {
          ans.set[key] = {err: new Error('simultaneous set and del')};
          ready = true;
        } else if (pnd.get) {
          ans.set[key] = {err: new Error('simultaneous set and get')};
          ready = true;
        } else {
          if (!(key in old)) {
            // do a get now, and a set later
            storageQuestion.get![key] = true;
            delayedSets[key] = val;
          } else {
            // do the set immediately
            storageQuestion.set![key] = val;
          }
          setdefault(pending, key, {}).set = true;
          updates[key] = {value: val};
        }
      }

      for (const key of Object.keys(value.del ?? {})) {
        const pnd = pending[key] ?? {};
        /* if (key in updates) {
          ans.set[key] = {err: new Error('call to set after a get, set, or del')};
          ready = true;
        } else*/ if (pnd.del) {
          ans.set[key] = {err: new Error('simultaneous deletes')};
          ready = true;
        } else if (pnd.set) {
          ans.set[key] = {err: new Error('simultaneous del and set')};
          ready = true;
        } else if (pnd.get) {
          ans.set[key] = {err: new Error('simultaneous del and get')};
          ready = true;
        } else {
          if (!(key in old)) {
            // do a get now, and a del later
            storageQuestion.get![key] = true;
          } else {
            // do the del immediately
            storageQuestion.del![key] = true;
          }
          setdefault(pending, key, {}).del = true;
          updates[key] = {value: undefined};
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
      storageQuestion = {get: {}, set: {}, del: {}};

      for (const [key, val] of Object.entries(storageAnswer.get)) {
        // remember the answer for later
        old[key] = val;
        // done with this query
        delete inflight[key];
        const pnd = pending[key];
        let keepPending: {set?: true, del?: true} | undefined = undefined;
        // why did we need this again?
        // (note: get/set/del are mutually exclusive, but old is not)
        if (pnd.old) {
          ans.old[key] = val;
          ready = true;
        }
        if (pnd.get) {
          ans.get[key] = val;
          ready = true;
        } else if (pnd.set) {
          // we needed to do a get before we did a set; issue the set now
          storageQuestion.set![key] = delayedSets[key];
          delete delayedSets[key];
          // preserve only the pending .set=true
          keepPending = {del: true};
          pending[key] = {set: true};
        } else if (pnd.del) {
          // we needed to do a get before we did a set; issue the set now
          storageQuestion.del![key] = true;
          // preserve only the pending .del=true
          keepPending = {del: true};
        }
        if (keepPending) {
          pending[key] = keepPending;
        } else {
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
  // awaitResult has no effect when executed outside of a query function
  awaitResult(): QueryGenerator<T>
  // subscribe returns an unsubscribe function
  subscribe(callback: (val: T) => void): () => void;
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
  closed: boolean = false;

  #subs: ((val: T) => void)[] = [];

  // {key: true}
  #keyDeps: Record<string, true> = {};
  // {query_id: true}
  #queryDeps: Record<string, true> = {};
  #runs: number = 0;
  #result: T | undefined = undefined;
  #fn: (qx: QX, prev: T | undefined, prevIsValid: boolean) => QueryGenerator<T>;

  constructor(id: string, fn: QueryFunction<QX, T>) {
    this.id = id;
    this.#fn = fn;
  }

  // part of public api
  *awaitResult(): QueryGenerator<T> {
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

  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    const id = `${this.#id++}`;
    const q = new _Query(id, fn);
    this.#queries[id] = q;
    this.#newQueries.push(q);
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

// "E"vents
// "C"ommands
// check"p"oint
// "P"rojectorConte"x"t
// "Q"ueryConte"x"t
export class Framework<E, C, P, PX, QX> {
  #storage: Storage;
  #shaper: (events: E[]) => {events: E[], checkpoint: P};
  #projector: (events: E[]) => ProjectorGenerator<void>; // wrapper around user's projector
  #forecaster: null | ((commands: C[]) => E[]);
  #forecastKey: null | ((event: E) => string);
  #onCommands: null | ((commands: C[], onSent: ()=> void) => void);

  #overlay: OverlayStorage;
  #graph: QueryGraph<QX>;
  #coro: Generator<void, void, void>;
  #fx: FutureContext;

  #scheduled: boolean = false;
  #commandId: number = 0;

  // #reconnects is a list of promise resolve functions
  #reconnects: ((value: {checkpoint: P | undefined, commands: C[]}) => void)[] = [];
  #recvdEvents: E[] = [];
  #recvdCommands: C[] = [];
  #sentCommands: string[] = [];
  #forecasts: Map<string, E> = new Map();
  // just a flag if new queries exist to be run; we don't store them here for typing purposes.
  #newQueries: boolean = false;

  constructor(
    px: PX,
    qx: QX,
    storage: Storage,
    callbacks: {
      // required: new events from the wire may be batched, and a checkpoint is produced
      shaper: (events: E[]) => {events: E[], checkpoint: P},
      // required: project a batch of events into the read model
      projector: (px: PX, events: E[]) => ProjectorGenerator<void>,
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
    this.#storage = storage;
    this.#shaper = callbacks.shaper;
    this.#projector = (events: E[]) => callbacks.projector(px, events);
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
  reconnect(): Promise<{checkpoint: P | undefined, commands: C[]}> {
    return new Promise((resolve) => {
      this.#reconnects.push(resolve);
    });
  }

  // new events from the wire come here
  recvEvents(events: E[]): void {
    this.#recvdEvents.push.apply(this.#recvdEvents, events);
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
  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    this.#newQueries = true;
    this.#schedule();
    return this.#graph.newQuery(fn);
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
      yield* runProjector(self.#projector(forecasts));
      // ignore updated keys and don't trigger a run of the graph; let that happen as part of the
      // normal newQuery processing
    });
  }

  // our main logic is implemented as a coroutine
  *#advancer(): Generator<void, void, void> {
    yield* this.#initialize();

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
    while(true){
      if (this.#recvdEvents.length > 0) {
        yield* this.#onRecvEvents();
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

      if (this.#newQueries) {
        yield* this.#onNewQueries();
        continue;
      }

      if (this.#reconnects.length > 0) {
        yield* this.#onReconnects();
        continue;
      }

      // if we got here we probably had a spurious wakeup
      yield
    }
  }

  *#onRecvEvents(): Generator<void, void, void> {
    const self = this;
    // input shaping step, which also produces a checkpoint
    const {events, checkpoint} = this.#shaper(this.#recvdEvents);
    this.#recvdEvents = [];

    // open a write txn to real storage
    // IDEA: what if we wrote a txn wrapper that could automatically allow high-value gets/sets to
    // happen in between the normal gets/sets?
    const updates = yield* withWTxn(this.#fx, this.#storage, function*(){
      // update our checkpoint when this txn finishes
      yield* txnSet(".checkpoint", checkpoint);

      // run the projector with our new events
      return yield* runProjector(self.#projector(events));
    })
    this.#graph.dirty(updates);

    // our old overlay is now invalid; start a new one
    this.#graph.dirty(this.#overlay.keys());
    this.#overlay = new OverlayStorage(this.#storage);

    // clean up now-irrelevant forecasts
    if (this.#forecasts.size > 0) {
      for (const event of events) {
        const key = this.#forecastKey!(event);
        this.#forecasts.delete(key);
      }
    }

    // rebuild overlay using all remaining forecasts
    if (this.#forecasts.size > 0) {
      yield* withWTxn(this.#fx, this.#overlay, function*(){
        const updates = yield* runProjector(
          self.#projector([...self.#forecasts.values()]),
        );
        self.#graph.dirty(updates);
      });
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

        // open a write txn against the existing overlay
        const updates = yield* withWTxn(this.#fx, this.#overlay, function*(){
          return yield* runProjector(self.#projector(forecasts));
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
}

// end of skeleton ////////////////////////////////////////////////////////////
