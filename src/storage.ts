// an indexeddb-compatible, transactional key-value store built around generators.
//
// A note about typing: the Storage interface must receive a value with .set() and return the same
// type value with .get().  It must not matter which implementation of Storage is in use.  However,
// most of the access to storage is untyped.  So storage cannot get() and set() the real proto
// values.  Instead, a Storage implementation which stores anywhere other than in-memory must do
// the type-to-storage conversion internally.  Then any generated typed getters built around the
// Storage interface shall be merely typecasting wrappers.

import { FutureContext, Future } from './future';

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

      // start delets
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

  *withRTxn<T>(fx: FutureContext, fn: (txn: WTxn) => Future<T>): Future<T> {
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
