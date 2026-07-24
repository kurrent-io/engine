'use server';

import type { QueryFunction, TodoQX } from '../model';
import type { BoardStats, ListStats } from '../types';

/* Server queries: the directive above is the module's entire deployment
   story.  These factories execute on the query server, next to its framework
   instance; in the browser bundle they are replaced by stubs, and calling one
   returns a reference that useQuery subscribes to over the websocket.  The
   factory arguments cross the wire, so they must be serializable. */

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
