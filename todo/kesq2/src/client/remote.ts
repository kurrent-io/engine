/* Client side of server queries: a registry of live subscriptions, keyed by
   a client-chosen id.  useFramework wires it to the websocket (attach on
   every (re)connect, deliver results and errors as they arrive); useQuery
   calls subscribe with the wire references that flexible and server-only
   query factories produce. */

export type ServerQueryRef = {
  $$kesq: string;
  args: unknown[];
};

export type RemoteQuery<T> = {
  latest: T | undefined;
  subscribe(callback: (value: T) => void): () => void;
  onError(callback: (reason: string) => void): void;
  close(): void;
};

type Entry = {
  ref: ServerQueryRef;
  callbacks: Set<(value: never) => void>;
  latest: unknown;
  onError: ((reason: string) => void) | null;
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

  // the server rejected the subscription (unknown query id, bad args, ...)
  deliverError(sub: number, reason: string) {
    const entry = this.#subs.get(sub);
    if (!entry) return;
    if (entry.onError) entry.onError(reason);
    else console.error(`server query ${entry.ref.$$kesq} failed: ${reason}`);
  }

  #issue(sub: number, entry: Entry) {
    this.#send?.({ type: 'subscribe', sub, query: entry.ref.$$kesq, args: entry.ref.args });
  }

  subscribe<T>(ref: ServerQueryRef): RemoteQuery<T> {
    const sub = this.#nextId++;
    const entry: Entry = { ref, callbacks: new Set(), latest: undefined, onError: null };
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
      onError(callback) {
        entry.onError = callback;
      },
      close() {
        subs.delete(sub);
        unsubscribe();
      },
    };
  }
}
