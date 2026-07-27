import type { QueryFunction } from './model';

/* Runtime shapes for queries that can execute on the query server.
 *
 * Queries come in three tiers of capability, in increasing order of setup
 * effort (see README.md):
 *
 * - plain factories return a bare QueryFunction and only ever run in the
 *   browser — no wire id, no registration, nothing here applies;
 * - factories in `*.flex.ts` modules are wrapped by codegen into FlexQuery
 *   producers: the wire reference and the locally-instantiated query
 *   function side by side, so each call site picks a venue at runtime;
 * - factories in `*.server.ts` modules surface to the client only as
 *   ServerQuery producers: a wire reference with no local implementation.
 */

export type ServerQuery<T> = {
  $$kesq: string;
  args: unknown[];
  /* phantom field carrying the result type; never set at runtime */
  __result?: T;
};

export type FlexQuery<QX, T> = ServerQuery<T> & { fn: QueryFunction<QX, T> };

// the parameter makes QueryFunction invariant in both type arguments, so
// only `any` works as a wildcard here
export type QueryFactory = (...args: any[]) => QueryFunction<any, any>;

/* The client-side type of a server-only factory: same parameters, but the
   result is only reachable over the wire. */
export type ServerOnly<F extends QueryFactory> = F extends (
  ...args: infer A
) => QueryFunction<any, infer T>
  ? (...args: A) => ServerQuery<T>
  : never;

export function wrapFlex<A extends unknown[], QX, T>(
  id: string,
  factory: (...args: A) => QueryFunction<QX, T>,
): (...args: A) => FlexQuery<QX, T> {
  return (...args) => ({ $$kesq: id, args, fn: factory(...args) });
}

export function serverRef<F extends QueryFactory>(id: string): ServerOnly<F> {
  return ((...args: unknown[]) => ({ $$kesq: id, args })) as ServerOnly<F>;
}

export function isRemoteRef(q: unknown): q is ServerQuery<unknown> {
  return typeof q === 'object' && q !== null && '$$kesq' in q;
}
