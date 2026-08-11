import type { Reducer, TodoEvents, TodoRX } from './model.gen';

export function* migrateTodos(rx: TodoRX): Reducer<void> {
  // just set "all_lists" key to an empty list if it doesn't exist yet
  yield* rx.set.all_lists((yield* rx.get.all_lists()) ?? []);
}

export function* reduceTodos(rx: TodoRX, events: TodoEvents[]): Reducer<void> {
  for (const e of events) {
    switch (e.type) {
      case 'new-list':
        yield* rx.update.all_lists((all_lists) => all_lists.push(e.id));
        yield* rx.set.list(e.id, { id: e.id, name: e.name, items: [], archived: false });
        break;

      case 'rename-list':
        yield* rx.update.list(e.id, (list) => (list.name = e.name));
        break;

      case 'archive-list':
        yield* rx.update.list(e.id, (list) => (list.archived = true));
        break;

      case 'new-item':
        yield* rx.set.item(e.id, { id: e.id, text: e.text, done: false, archived: false });
        yield* rx.update.list(e.list, (list) => list.items.push(e.id));
        break;

      case 'edit-item':
        yield* rx.update.item(e.id, (item) => (item.text = e.text));
        break;

      case 'mark-item':
        yield* rx.update.item(e.id, (item) => (item.done = e.done));
        break;

      case 'archive-item':
        yield* rx.update.item(e.id, (item) => (item.archived = true));
        break;

      default: {
        const _typecheck: never = e;
        return _typecheck;
      }
    }
  }
}
