import { QueryGraph, QueryGenerator } from './query';
import { FutureContext } from './future';
import { InMemStorage, withRTxn, withWTxn } from './storage';

function runFutureContext(fn: (fx: FutureContext) => Generator<void, void, void>) {
  const lazy: {fx?: FutureContext} = {};
  let done = false;
  lazy.fx = new FutureContext(function*(){
    const fx = lazy.fx!;
    const g = fn(fx);
    const {value: v, done: d} = g.next();
    if (d) {
      done = true
    } else {
      console.log("generator yielded", v);
    }
  }());
  lazy.fx.wakeup();
  if (!done) {
    throw new Error("generator did not finish");
  }
}


function *QxItem<T>(key: string): QueryGenerator<T> {
  const ans = (yield {store: {[key]: true}}).store[key];
  if ("err" in ans) {
    throw ans.err;
  }
  return ans.value as T;
}

test("query graph", () => {
  // configure fake storage
  let storage = new InMemStorage({a: 1, b: 2, c: 3});

  // configure a graph
  const qx = {
    get: {
      a: () => QxItem<number>("a"),
      b: () => QxItem<number>("b"),
      c: () => QxItem<number>("c"),
    },
  };
  let graph = new QueryGraph(qx);

  // add queries
  const aPlusB = graph.newQuery(function*(qx){
    return (yield* qx.get.a()) + (yield* qx.get.b());
  });
  const cSquaredTimesAPlusB = graph.newQuery(function*(qx){
    const c = yield* qx.get.c();
    return c * c * (yield* aPlusB.awaitResult());
  });

  let aplusbResult = -1;
  let fullResult = -1;
  let aplusbCount = 0;
  let fullCount = 0;

  aPlusB.subscribe((val) => { aplusbResult = val; aplusbCount++; });
  cSquaredTimesAPlusB.subscribe((val) => { fullResult = val; fullCount++; });

  let check = (xCount: number, yCount: number, xVal: number, yVal: number) => {
    if (aplusbCount !== xCount)
      throw new Error(`expected aplusbCount == ${xCount} but got ${aplusbCount}`);
    if (fullCount !== yCount)
      throw new Error(`expected fullCount == ${yCount} but got ${fullCount}`);
    if (aplusbResult !== xVal)
      throw new Error(`expected aplusbResult == ${xVal} but got ${aplusbResult}`);
    if (fullResult !== yVal)
      throw new Error(`expected fullResult == ${yVal} but got ${fullResult}`);
  };

  // run the graph against storage
  runFutureContext(function*(fx: FutureContext){
    const run = function*() {
      yield* withRTxn(fx, storage, function*(){
        const cbs = yield* graph.run();
        cbs();
      });
    };
    // run a fresh graph
    yield* run();
    check(1, 1, 3, 27);
    // run with no updates
    yield* run();
    check(1, 1, 3, 27);
    // run with all updates
    yield* withWTxn(fx, storage, function*(){
      yield {"set": {a: 2, b: 3, c: 4}};
    });
    graph.dirty(["a", "b", "c"]);
    yield* run();
    check(2, 2, 5, 80);
    // run early function expecting same result, expect second function to be pruned
    // (update c but mark a as dirty; if late function does not run it won't see c)
    yield* withWTxn(fx, storage, function*(){
      yield {"set": {c: 5}};
    });
    graph.dirty(["a"]);
    yield* run();
    check(2, 2, 5, 80);
    // run with partial updates, late in graph
    graph.dirty(["c"]);
    yield* run();
    check(2, 3, 5, 125);
  });
});
