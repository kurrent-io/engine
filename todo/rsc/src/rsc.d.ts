// Hand-written types for the react-server-dom-webpack entry points this demo
// uses; the package ships no TypeScript types.

declare module 'react-server-dom-webpack/server.edge' {
  import type { ReactNode } from 'react';

  export function renderToReadableStream(
    model: ReactNode,
    clientManifest: unknown,
    options?: { onError?: (error: unknown) => void },
  ): ReadableStream<Uint8Array>;

  export function registerClientReference<T>(
    stub: T,
    moduleId: string,
    exportName: string,
  ): T;
}

declare module 'react-server-dom-webpack/client' {
  export function createFromReadableStream<T>(
    stream: ReadableStream<Uint8Array>,
    options?: unknown,
  ): PromiseLike<T>;
}

// virtual module provided by ../rsc-plugin.ts
declare module 'rsc:client-modules';

// ships no types
declare module 'rollup-plugin-serve';
