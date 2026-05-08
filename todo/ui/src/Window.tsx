import { useCallback, useState } from 'react';
import { Card, Empty, Flex, Switch, Tag, Typography } from 'antd';

import { TodoQX, QueryGenerator } from './model';
import { useQuery } from './useQuery';
import { useFramework } from './useFramework';

const { Text } = Typography;

export default function Window({
  name,
  relayUrl,
}: {
  name: string;
  relayUrl: string;
}) {
  const [enabled, setEnabled] = useState(true);
  const [fw, connState] = useFramework(relayUrl, enabled);

  const listCountLookup = useCallback(function*(qx: TodoQX): QueryGenerator<number> {
    const all = yield* qx.get.all_lists();
    return all?.length ?? 0;
  }, []);
  const listCount = useQuery(fw, listCountLookup);

  const stateColor = {
    connecting: 'orange',
    connected: 'green',
    disconnected: 'red',
  }[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          <Text strong>{name}</Text>
          <span style={{ flex: 1 }} />
          <Tag color={stateColor}>{connState}</Tag>
          <Switch
            size="small"
            checked={enabled}
            onChange={setEnabled}
            checkedChildren="on"
            unCheckedChildren="off"
          />
        </Flex>
      }
      style={{ width: '32em' }}
    >
      <Empty
        description={
          <Text type="secondary">
            {listCount === undefined
              ? 'loading…'
              : `${listCount} list${listCount === 1 ? '' : 's'} — todo UI goes here`}
          </Text>
        }
      />
    </Card>
  );
}
