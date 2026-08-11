import { useEffect, useMemo, useState } from 'react';

import type { Query, QueryFunction } from './model';

export function useQuery<QX, T>(
  // structurally match QX parameter from Framework
  fw: { newQuery<X>(fn: QueryFunction<QX, X>): Query<X> },
  fn: QueryFunction<QX, T>,
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const query = useMemo(() => {
    const q = fw.newQuery(fn);
    q.subscribe((val: T) => setState(val));
    return q;
  }, [fw, fn]);

  useEffect(
    () => () => {
      query.close();
    },
    [query],
  );

  return state;
}
