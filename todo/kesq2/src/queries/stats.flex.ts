import type { QueryFunction, TodoQX } from '../model';
import type { BoardStats, ListStats } from '../types';

/* Flexible queries: the `.flex.ts` suffix opts this module into codegen
   (gen-queries.mjs), which registers these factories on the query server and
   re-exports them to the client wrapped with their wire references — so each
   call site picks at runtime whether the query executes locally or on the
   server.  The factory arguments must be serializable either way, since they
   may cross the wire. */

export function boardStats(): QueryFunction<TodoQX, BoardStats> {
  return function* (qx) {
    const ids = (yield* qx.get.all_lists()) ?? [];
    let lists = 0;
    let items = 0;
    let done = 0;
    for (const id of ids) {
      const list = yield* qx.get.list(id);
      if (list.archived) continue;
      lists++;
      for (const itemId of list.items) {
        const item = yield* qx.get.item(itemId);
        if (item.archived) continue;
        items++;
        if (item.done) done++;
      }
    }
    return { lists, items, done };
  };
}

export function listStats(listId: string): QueryFunction<TodoQX, ListStats> {
  return function* (qx) {
    const list = yield* qx.get.list(listId);
    let total = 0;
    let done = 0;
    for (const itemId of list.items) {
      const item = yield* qx.get.item(itemId);
      if (item.archived) continue;
      total++;
      if (item.done) done++;
    }
    return { total, done };
  };
}
