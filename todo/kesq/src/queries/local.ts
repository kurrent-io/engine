import type { QueryFunction, TodoQX } from '../model';
import type { ListData } from '../types';

/* Local queries: factories returning a query function that runs in the
   browser, against the state synced by the client's own framework instance.
   Note the shape is identical to ../queries/server.ts — the directive at the
   top of that file is the only difference. */

export function allLists(): QueryFunction<TodoQX, ListData[]> {
  return function* (qx) {
    const ids = (yield* qx.get.all_lists()) ?? [];
    const out: ListData[] = [];
    for (const id of ids) {
      const list = yield* qx.get.list(id);
      if (list.archived) continue;
      const items = [];
      for (const itemId of list.items) {
        const item = yield* qx.get.item(itemId);
        if (item.archived) continue;
        items.push({ id: item.id, text: item.text, done: item.done });
      }
      out.push({ id: list.id, name: list.name, items });
    }
    return out;
  };
}
