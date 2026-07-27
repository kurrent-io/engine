import { useState, useMemo, useEffect } from 'react';
import type { Query, QueryFunction } from '../model';
import type { FlexQuery, ServerQuery } from '../flex';
import { isRemoteRef } from '../flex';
import { RemoteQueries } from './remote';

export type Placement = 'local' | 'server';

type Client<QX> = {
  // structurally match QX parameter from Framework
  fw: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> };
  remote: RemoteQueries;
};

type Subscription<T> = {
  subscribe(callback: (val: T) => void): unknown;
  close(): void;
};

/* Subscribes on the query server.  If the server rejects the subscription
   (unknown id after a deploy, say) and the query has a local implementation,
   swaps to local execution behind the same subscription surface, so the
   consumer never notices. */
function remoteWithFallback<T>(
  remote: RemoteQueries,
  ref: ServerQuery<T>,
  makeLocal: (() => Subscription<T>) | null,
): Subscription<T> {
  const callbacks = new Set<(val: T) => void>();
  const remoteQuery = remote.subscribe<T>(ref);
  let current: Subscription<T> = remoteQuery;
  let closed = false;

  remoteQuery.onError((reason) => {
    console.error(`server query ${ref.$$kesq} failed: ${reason}`);
    if (closed || !makeLocal) return;
    remoteQuery.close();
    current = makeLocal();
    for (const callback of callbacks) current.subscribe(callback);
  });

  return {
    subscribe(callback) {
      callbacks.add(callback);
      current.subscribe(callback);
    },
    close() {
      closed = true;
      current.close();
    },
  };
}

/* One hook, three tiers of query:

   - a plain query function runs in the browser via fw.newQuery, full stop —
     there is no placement to choose;
   - a flexible query (from a `*.flex.ts` module) carries both a wire
     reference and its local implementation — `placement` picks a side, per
     call site, at runtime, defaulting to local;
   - a server-only query (from a `*.server.ts` module) is a bare wire
     reference; it always subscribes over the websocket, and the overloads
     reject a placement argument for it. */
export function useQuery<QX, T>(client: Client<QX>, query: QueryFunction<QX, T>): T | undefined;
export function useQuery<QX, T>(
  client: Client<QX>,
  query: FlexQuery<QX, T>,
  placement?: Placement,
): T | undefined;
export function useQuery<QX, T>(client: Client<QX>, query: ServerQuery<T>): T | undefined;
export function useQuery<QX, T>(
  client: Client<QX>,
  query: QueryFunction<QX, T> | FlexQuery<QX, T> | ServerQuery<T>,
  placement: Placement = 'local',
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const subscription = useMemo<Subscription<T>>(() => {
    let q: Subscription<T>;
    if (isRemoteRef(query)) {
      const makeLocal =
        'fn' in query ? () => client.fw.newQuery((query as FlexQuery<QX, T>).fn) : null;
      q =
        makeLocal && placement === 'local'
          ? makeLocal()
          : remoteWithFallback(client.remote, query as ServerQuery<T>, makeLocal);
    } else {
      q = client.fw.newQuery(query as QueryFunction<QX, T>);
    }
    q.subscribe((val: T) => setState(val));
    return q;
  }, [client, query, placement]);

  useEffect(() => () => { subscription.close() }, [subscription]);

  return state;
}
