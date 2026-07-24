import { useMemo } from 'react';

import { useFramework } from './useFramework';
import { useQuery } from './useQuery';
import { allLists } from '../queries/local';
import { boardStats } from '../queries/server';
import { generateUuid } from '../util';
import ListView, { InlineAdd } from './ListView';

const SERVER_URL = 'ws://localhost:3006/ws';

export default function App() {
  const [client, connState] = useFramework(SERVER_URL);

  // Identical call sites, opposite execution: allLists runs here against
  // synced state; boardStats is a stub whose module says 'use server', so
  // useQuery subscribes and the query server pushes results.
  const lists = useQuery(client, useMemo(() => allLists(), []));
  const stats = useQuery(client, useMemo(() => boardStats(), []));

  return (
    <div className="board">
      <h1>To-Do — KESQ</h1>
      <p className="meta">
        <span className={`conn ${connState}`}>{connState}</span>
        {stats && (
          <>
            {' '}· {stats.lists} lists, {stats.done}/{stats.items} done{' '}
            <span className="badge">server query</span>
          </>
        )}
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
