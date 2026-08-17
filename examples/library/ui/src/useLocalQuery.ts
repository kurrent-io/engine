import { useEffect, useMemo, useState } from 'react';

import type { Query, QueryFunction } from './model';

export function useLocalQuery<QX, T>(
  // structurally match QX parameter from Engine
  eng: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },
  fn: QueryFunction<QX, T>,
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const query = useMemo(() => {
    const q = eng.newQuery(fn);
    q.subscribe((val: T) => setState(val));
    return q;
  }, [eng, fn]);

  useEffect(
    () => () => {
      query.close();
    },
    [query],
  );

  return state;
}
