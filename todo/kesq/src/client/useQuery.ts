import { useState, useMemo, useEffect } from 'react';
import type { Query, QueryFunction } from '../model';
import { isServerRef, RemoteQueries } from './remote';

type Subscription<T> = {
  subscribe(callback: (val: T) => void): unknown;
  close(): void;
};

/* Accepts the result of calling any query factory.  Local factories return a
   query function, which runs in the browser through fw.newQuery; factories
   from a 'use server' module return a reference (the bundler stubbed them),
   which subscribes to the query server instead.  The call site can't tell
   the difference — the directive on the factory's module decides. */
export function useQuery<QX, T>(
  client: {
    // structurally match QX parameter from Framework
    fw: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> };
    remote: RemoteQueries;
  },
  fn: QueryFunction<QX, T>,
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const query = useMemo<Subscription<T>>(() => {
    const q = isServerRef(fn) ? client.remote.subscribe<T>(fn) : client.fw.newQuery(fn);
    q.subscribe((val: T) => setState(val));
    return q;
  }, [client, fn]);

  useEffect(() => () => { query.close() }, [query]);

  return state;
}
