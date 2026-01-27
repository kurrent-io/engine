import { WStorageQuestion, WStorageGenerator, StorageValue, StorageDone } from './storage';
import { setdefault } from './util';

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
