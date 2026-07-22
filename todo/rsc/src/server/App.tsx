import { InlineAdd, ItemRow, ListCard } from '../client/interactive';
import type { ListData } from '../types';

/* Server components: they execute only on the flight server, and only their
   *output* goes over the wire.  ListCard / ItemRow / InlineAdd are client
   components — the flight payload carries a reference and props for each, and
   for ListCard the server-rendered rows flow through as children. */

export function App({ lists, renderedAt }: { lists: ListData[]; renderedAt: string }) {
  return (
    <div className="board">
      <h1>To-Do — RSC over WebSocket</h1>
      <p className="meta">
        server-rendered at {renderedAt} — {lists.length} list{lists.length === 1 ? '' : 's'}
      </p>
      {lists.map((list) => (
        <ListCard key={list.id} id={list.id} name={list.name}>
          {list.items.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
          <InlineAdd
            label="add item"
            placeholder="item text"
            field="text"
            command={{ type: 'new-item', list: list.id }}
          />
        </ListCard>
      ))}
      <InlineAdd
        label="add list"
        placeholder="list name"
        field="name"
        command={{ type: 'new-list' }}
      />
    </div>
  );
}
