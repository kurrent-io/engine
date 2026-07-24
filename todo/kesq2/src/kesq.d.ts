// virtual module provided by ../kesq2-plugin.ts (server builds only): the
// registry of flexible query factories, keyed by "<module>#<export>"
declare module 'kesq:queries' {
  export const queries: Record<string, ((...args: any[]) => any) | undefined>;
}

// ships no types
declare module 'rollup-plugin-serve';
