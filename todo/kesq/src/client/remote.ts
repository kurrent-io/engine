/* Client side of server queries: a registry of live subscriptions, keyed by
   a client-chosen id.  useFramework wires it to the websocket (attach on
   every (re)connect, deliver for each incoming result); useQuery calls
   subscribe with the reference objects that stubbed query factories return. */

export type ServerQueryRef = {
  $$kesq: string;
  args: unknown[];
};

export function isServerRef(q: unknown): q is ServerQueryRef {
  return typeof q === 'object' && q !== null && '$$kesq' in q;
}

export type RemoteQuery<T> = {
  latest: T | undefined;
  subscribe(callback: (value: T) => void): () => void;
  close(): void;
};

type Entry = {
  ref: ServerQueryRef;
  callbacks: Set<(value: never) => void>;
  latest: unknown;
};

export class RemoteQueries {
  #send: ((msg: unknown) => void) | null = null;
  #subs = new Map<number, Entry>();
  #nextId = 1;

  // called on every (re)connect; re-issues all live subscriptions
  attach(send: (msg: unknown) => void) {
    this.#send = send;
    for (const [sub, entry] of this.#subs) this.#issue(sub, entry);
  }

  detach() {
    this.#send = null;
  }

  deliver(sub: number, value: unknown) {
    const entry = this.#subs.get(sub);
    if (!entry) return;
    entry.latest = value;
    for (const callback of entry.callbacks) (callback as (v: unknown) => void)(value);
  }

  #issue(sub: number, entry: Entry) {
    this.#send?.({ type: 'subscribe', sub, query: entry.ref.$$kesq, args: entry.ref.args });
  }

  subscribe<T>(ref: ServerQueryRef): RemoteQuery<T> {
    const sub = this.#nextId++;
    const entry: Entry = { ref, callbacks: new Set(), latest: undefined };
    this.#subs.set(sub, entry);
    this.#issue(sub, entry);

    const subs = this.#subs;
    const unsubscribe = () => this.#send?.({ type: 'unsubscribe', sub });
    return {
      get latest() {
        return entry.latest as T | undefined;
      },
      subscribe(callback) {
        entry.callbacks.add(callback as (v: never) => void);
        if (entry.latest !== undefined) callback(entry.latest as T);
        return () => entry.callbacks.delete(callback as (v: never) => void);
      },
      close() {
        subs.delete(sub);
        unsubscribe();
      },
    };
  }
}
