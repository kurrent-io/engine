import { useState, useMemo, useEffect } from 'react';
import type { Query } from '@todo-thin/model/ui';

// useQuery is the generic react hook for consuming a query.
//
// If your generated Queries interface looks like:
//
//   export interface MyQueries {
//     myList(filter: string): Query<MyData[]>;
//   }
//
// Then you can call useQuery() like:
//
//   function MyComponent({queries}: {queries: MyQueries}) {
//     const myList = useQuery(queries, "myList", "your-filter-here");
//   }
//
// useQuery() offers full type safety.  It typescript's "keyof" operator to determine legal string
// values for `name`, and it uses typescript's "inferring with conditional types" to determined
// the return type and legal argument types.
//
// Note that the return value will always be undefined upon first creating a new query; that is
// because most storage backends (other than in-memory storage) cannot populate query results
// synchronously.
export function useQuery<
  Q,
  K extends keyof Q,
  T extends Q[K] extends (...a: any[]) => Query<infer R> ? R : never
>(
  queries: Q,
  name: K,
  // args inferred by matching args of Q[K]
  ...args: Q[K] extends (...a: infer A) => Query<any> ? A : never
): T | undefined {
  const [state, setState] = useState<T | undefined>();

  const query = useMemo(() => {
    const q = (queries as any)[name](...args);
    q.subscribe((val: T) => setState(val));
    return q;
  }, [queries, name, ...args])

  useEffect(() => () => { query.close() }, [query]);

  return state;
}
