import { useCallback } from 'react';
import { Card, Flex, Spin, Tag, Typography } from 'antd';

import { TodoQX, QueryGenerator } from './model';
import { useQuery } from './useQuery';
import { useFramework } from './useFramework';
import { generateUuid } from './util';
import ListView, { InlineAdd, ListData } from './ListView';

const { Text } = Typography;

export default function Window({
  name,
  relayUrl,
}: {
  name: string;
  relayUrl: string;
}) {
  const [fw, connState] = useFramework(relayUrl);

  const listsLookup = useCallback(function* (qx: TodoQX): QueryGenerator<ListData[]> {
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
  }, []);
  const lists = useQuery(fw, listsLookup);

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  function addList(listName: string) {
    fw.sendCommands([
      { type: 'new-list', id: generateUuid(), name: listName },
    ]);
  }

  function renameList(id: string, listName: string) {
    fw.sendCommands([{ type: 'rename-list', id, name: listName }]);
  }

  function archiveList(id: string) {
    fw.sendCommands([{ type: 'archive-list', id }]);
  }

  function addItem(listId: string, itemText: string) {
    fw.sendCommands([
      { type: 'new-item', id: generateUuid(), list: listId, text: itemText },
    ]);
  }

  function toggleItem(id: string, done: boolean) {
    fw.sendCommands([{ type: 'mark-item', id, done }]);
  }

  function editItem(id: string, text: string) {
    fw.sendCommands([{ type: 'edit-item', id, text }]);
  }

  function archiveItem(id: string) {
    fw.sendCommands([{ type: 'archive-item', id }]);
  }

  return (
    <Card
      className="window"
      title={
        <Flex align="center" gap="small">
          <Text strong className="grow">{name}</Text>
          <Tag color={stateColor}>{connState}</Tag>
        </Flex>
      }
    >
      {lists === undefined ? (
        <Spin />
      ) : (
        <>
          {lists.map((list) => (
            <ListView
              key={list.id}
              list={list}
              onRenameList={(name) => renameList(list.id, name)}
              onArchiveList={() => archiveList(list.id)}
              onAddItem={(t) => addItem(list.id, t)}
              onToggleItem={toggleItem}
              onEditItem={editItem}
              onArchiveItem={archiveItem}
            />
          ))}
          <InlineAdd
            label="add list"
            placeholder="list name"
            onSubmit={addList}
          />
        </>
      )}
    </Card>
  );
}
