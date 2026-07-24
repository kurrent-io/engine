import { useMemo, useState } from 'react';

import { useFramework } from './useFramework';
import { useQuery } from './useQuery';
import type { Placement } from './useQuery';
import { allLists } from '../queries/local';
import { boardStats } from '../queries/server';
import { generateUuid } from '../util';
import ListView, { InlineAdd } from './ListView';

const SERVER_URL = 'ws://localhost:3008/ws';

export default function App() {
  const [client, connState] = useFramework(SERVER_URL);

  // placement is a plain runtime value: flipping the toggle re-subscribes the
  // same query on the other side of the wire
  const [statsPlacement, setStatsPlacement] = useState<Placement>('server');

  const lists = useQuery(client, useMemo(() => allLists(), []));
  const stats = useQuery(client, useMemo(() => boardStats(), []), statsPlacement);

  return (
    <div className="board">
      <h1>To-Do — KESQ2</h1>
      <p className="meta">
        <span className={`conn ${connState}`}>{connState}</span>
        {stats && (
          <>
            {' '}· {stats.lists} lists, {stats.done}/{stats.items} done
          </>
        )}{' '}
        <button
          className="badge toggle"
          title="switch where boardStats executes"
          onClick={() => setStatsPlacement((p) => (p === 'server' ? 'local' : 'server'))}
        >
          @{statsPlacement} ⇄
        </button>
      </p>
      {lists === undefined ? (
        <p>loading…</p>
      ) : (
        <>
          {lists.map((list) => (
            <ListView key={list.id} client={client} list={list} />
          ))}
          <InlineAdd
            label="add list"
            placeholder="list name"
            onSubmit={(name) =>
              client.sendCommands([{ type: 'new-list', id: generateUuid(), name }])
            }
          />
        </>
      )}
    </div>
  );
}
