import { Card, Flex, Spin, Tag, Typography } from 'antd';

import ListView, { InlineAdd } from './ListView';
import { useFramework } from './useFramework';
import { useQuery } from './useQuery';
import { generateUuid } from './util';

const { Text } = Typography;

export default function Window({ name, serverUrl }: { name: string; serverUrl: string }) {
  const [server, connState] = useFramework(serverUrl);
  const lists = useQuery(server.queries, 'allLists');

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  function addList(listName: string) {
    server.sendCommand({ type: 'new-list', id: generateUuid(), name: listName });
  }

  function renameList(id: string, listName: string) {
    server.sendCommand({ type: 'rename-list', id, name: listName });
  }

  function archiveList(id: string) {
    server.sendCommand({ type: 'archive-list', id });
  }

  function addItem(listId: string, itemText: string) {
    server.sendCommand({ type: 'new-item', id: generateUuid(), list: listId, text: itemText });
  }

  function toggleItem(id: string, done: boolean) {
    server.sendCommand({ type: 'mark-item', id, done });
  }

  function editItem(id: string, text: string) {
    server.sendCommand({ type: 'edit-item', id, text });
  }

  function archiveItem(id: string) {
    server.sendCommand({ type: 'archive-item', id });
  }

  return (
    <Card
      className="window"
      title={
        <Flex align="center" gap="small">
          <Text strong className="grow">
            {name}
          </Text>
          <Tag color={stateColor}>{connState}</Tag>
        </Flex>
      }>
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
          <InlineAdd label="add list" placeholder="list name" onSubmit={addList} />
        </>
      )}
    </Card>
  );
}
