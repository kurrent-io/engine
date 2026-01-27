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

import { RStorageGenerator, StorageValue } from './storage';
import { setdefault } from './util';

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
