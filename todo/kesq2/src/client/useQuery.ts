import { useState, useMemo, useEffect } from 'react';
import type { Query, QueryFunction } from '../model';
import { isServerRef, RemoteQueries } from './remote';

export type Placement = 'local' | 'server';

type Subscription<T> = {
  subscribe(callback: (val: T) => void): unknown;
  close(): void;
};

/* Accepts the result of calling any query factory.  Plain factories return a
   query function, which runs in the browser through fw.newQuery.  Factories
   from a 'use server' module return a flexible wrapper carrying both a wire
   reference and the locally-instantiated query function — `placement` picks
   which one is used, per call site, at runtime. */
export function useQuery<QX, T>(
  client: {
    // structurally match QX parameter from Framework
    fw: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> };
    remote: RemoteQueries;
  },
  fn: QueryFunction<QX, T>,
  placement: Placement = 'local',
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const query = useMemo<Subscription<T>>(() => {
    let q: Subscription<T>;
    if (isServerRef(fn)) {
      q =
        placement === 'server'
          ? client.remote.subscribe<T>(fn)
          : client.fw.newQuery((fn as { fn?: unknown }).fn as QueryFunction<QX, T>);
    } else {
      q = client.fw.newQuery(fn);
    }
    q.subscribe((val: T) => setState(val));
    return q;
  }, [client, fn, placement]);

  useEffect(() => () => { query.close() }, [query]);

  return state;
}
