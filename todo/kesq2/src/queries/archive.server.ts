import type { QueryFunction, TodoQX } from '../model';
import type { ArchiveStats } from '../types';

/* Server-only queries: the `.server.ts` suffix tells codegen to give the
   client a bare wire reference — this implementation is never part of the
   browser bundle, and useQuery's types won't accept a placement for it.
   (In this demo the client syncs the full event log, so nothing is truly
   hidden; the tier exists to demonstrate the machinery.) */

export function archiveStats(): QueryFunction<TodoQX, ArchiveStats> {
  return function* (qx) {
    const ids = (yield* qx.get.all_lists()) ?? [];
    let lists = 0;
    let items = 0;
    for (const id of ids) {
      const list = yield* qx.get.list(id);
      if (list.archived) lists++;
      for (const itemId of list.items) {
        const item = yield* qx.get.item(itemId);
        if (item.archived) items++;
      }
    }
    return { lists, items };
  };
}
