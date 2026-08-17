import { jsonEvent, KurrentDBClient, START, STREAM_NAME } from '@kurrent/kurrentdb-client';
import type { AllStreamResolvedEvent } from '@kurrent/kurrentdb-client';
import {
  checkTodoEvents,
  checkTodoQuery,
  DecodeTodoQuery,
  dispatchTodoQuery,
  ExternalStore,
  LocalTodoQueries,
  migrateTodos,
  reduceTodos,
  TodoEngine,
} from '@todo-thin/model/server';
import type {
  ClientMessage,
  ListViewData,
  Query,
  QueryGenerator,
  ServerMessage,
  TodoQuery,
  TodoQueryDefs,
  TodoQX,
} from '@todo-thin/model/server';
import { open } from 'lmdb';
import type { Transaction } from 'lmdb';
import { WebSocket, WebSocketServer } from 'ws';
import type { MessageEvent } from 'ws';

// assume all events go into one stream
const TODO_STREAM = 'todo';
// only one event type in this demo
const EVENT_TYPE = 'TodoEvents';
// what we listen on
const LISTEN_PORT = 3001;
const KURRENT_CONNECTION_STRING = 'kurrentdb://admin:changeit@localhost:2113?tls=false';

class ServerQueryDefs implements TodoQueryDefs<TodoQX> {
  *allLists(qx: TodoQX): QueryGenerator<ListViewData[]> {
    const ids = (yield* qx.get.all_lists()) ?? [];
    const out: ListViewData[] = [];
    for (const id of ids) {
      const list = yield* qx.get.list(id);
      if (list.archived) continue;
      const items = [];
      for (const itemId of list.items) {
        const item = yield* qx.get.item(itemId);
        if (item.archived) continue;
        items.push({ id: item.id, text: item.text, done: item.done });
      }
      out.push({ id: list.id, name: list.name, items });
    }
    return out;
  }
}

function handleWebsocketConnection(client: KurrentDBClient, eng: TodoEngine, socket: WebSocket) {
  const openQueries: Record<string, { decoded: TodoQuery; query: undefined | Query<any> }> = {};

  /* normally you'd probably instantiate a ServerQueryDefs with connection info, like
     userid or what groups they're in, but this demo doesn't have users */
  const defs = new ServerQueryDefs(/* userid or other connection-specific info */);
  const queries = LocalTodoQueries(eng, defs);

  // one close function to close everything and log the reason
  let dead = false;
  const closeConnection = (event: string, ...args: any[]) => {
    if (dead) return;
    dead = true;
    console.log(`on ${event}:`, ...args);
    socket.close();
    for (const { query } of Object.values(openQueries)) {
      query?.close();
    }
  };

  // a helper to wrap non-error event handlers with try/catch
  const catchErrors = (event: string, fn: () => void) => {
    if (dead) return;
    try {
      fn();
    } catch (e: unknown) {
      closeConnection(event, e);
    }
  };

  socket.on('error', (e) => closeConnection('error', `websocket died: ${e}`));

  // if client can't keep up with query results, pause subscriptions to not fill up memory
  let nQueued = 0;
  const queueLimit = 64;
  let paused = false;
  let pausedAcks = 0;
  const socketSend = (data: ServerMessage, options?: any) =>
    catchErrors('socketSend', () => {
      if (++nQueued > queueLimit) {
        if (!paused) {
          // shut down queries until the client catches up
          for (const [qid, { query }] of Object.entries(openQueries)) {
            query?.close();
            openQueries[qid].query = undefined;
          }
          paused = true;
        }
      }
      socket.send(JSON.stringify(data), options, () => {
        if (--nQueued < queueLimit / 2) {
          if (paused) {
            if (pausedAcks > 0) {
              socketSend({ acks: pausedAcks });
              pausedAcks = 0;
            }
            // restart queries now that the client caught up
            for (const [qid, { decoded }] of Object.entries(openQueries)) {
              const query = dispatchTodoQuery(queries, decoded);
              query.subscribe((result) => {
                socketSend({ queryResults: { [qid]: result } });
              });
              openQueries[qid].query = query;
            }
            paused = false;
          }
        }
      });
    });

  // there isn't really a handshake message in this protocol, since this demo has no user system
  socket.on('message', (ev: MessageEvent) =>
    catchErrors('message', () => {
      const msg: ClientMessage = JSON.parse(ev as any);
      if (!msg || typeof msg !== 'object') {
        closeConnection('message', 'bad message');
        return;
      }
      for (const header of Object.keys(msg)) {
        switch (header) {
          case 'commands':
            {
              const value = msg.commands!;
              for (const cmd of value) {
                // validate command wrapper
                if (!cmd || typeof cmd !== 'object' || typeof cmd.id != 'string') {
                  closeConnection('message', 'bad command wrapper');
                  return;
                }

                // validate command body
                const errs = checkTodoEvents(cmd.data);
                if (errs.length > 0) {
                  closeConnection('message', `invalid command: ${errs.join(', ')}`);
                  return;
                }

                // append to event stream
                const event = jsonEvent({
                  type: EVENT_TYPE,
                  id: cmd.id,
                  data: cmd.data,
                });
                client
                  .appendToStream(TODO_STREAM, [event])
                  .then(() => {
                    if (!paused) {
                      // send ack now
                      socketSend({ acks: 1 });
                    } else {
                      // send ack later
                      pausedAcks++;
                    }
                  })
                  .catch((e: unknown) => {
                    closeConnection('appendingToStream', e);
                  });
              }
            }
            break;

          case 'subscribeQueries':
            {
              const value = msg.subscribeQueries!;
              for (const [qid, raw] of Object.entries(value)) {
                // validate query
                const errs = checkTodoQuery(raw);
                if (errs.length > 0) {
                  closeConnection('message', `invalid query: ${errs.join(', ')}`);
                  return;
                }
                const decoded = DecodeTodoQuery(raw);
                let query: Query<any> | undefined = undefined;
                if (!paused) {
                  query = dispatchTodoQuery(queries, decoded);
                  // make sure not to leak queries
                  openQueries[qid]?.query?.close();
                  query.subscribe((result) => {
                    socketSend({ queryResults: { [qid]: result } });
                  });
                }
                openQueries[qid] = { decoded, query };
              }
            }
            break;

          case 'closeQueries':
            {
              const value = msg.closeQueries!;
              for (const [qid] of value) {
                openQueries[qid]?.query?.close();
                delete openQueries[qid];
              }
            }
            break;

          default:
            closeConnection('message', 'bad message');
            return;
        }
      }
    }),
  );
}

function lmdbStore(): ExternalStore {
  const db = open({ path: '.db' });

  return new ExternalStore((writable) => {
    // node lmdb library has assymetric read/write API, presumably because lmdb only allows
    // one write txn at a time.
    let commit: () => void;
    let abort: () => void;
    let getOpts: {} | { transaction: Transaction } = {};
    if (writable) {
      // open the write txn by returning a promise that we resolve or reject at a later time
      let resolve: () => void;
      let reject: () => void;
      const promise = new Promise<void>((rs, rj) => {
        resolve = rs;
        reject = rj;
      });
      const lmdbTxn = db.transaction(() => promise);
      commit = () => {
        resolve();
        return lmdbTxn;
      };
      abort = () => {
        reject();
        return lmdbTxn;
      };
    } else {
      // open an explicit read transaction
      const transaction = db.useReadTransaction();
      getOpts = { transaction };
      commit = () => {
        transaction.done();
      };
      abort = () => {
        transaction.done();
      };
    }

    // combine read/write-specific commit and abort with generic get/set/del to form a full txn
    return {
      commit,
      abort,
      get(key: string) {
        return db.get(key, getOpts);
      },
      set(key: string, value: any) {
        db.put(key, value);
      },
      del(key: string) {
        db.remove(key);
      },
    };
  });
}

// returns a Promise that is fulfilled after the first catchup
function configureSubscription(client: KurrentDBClient, eng: TodoEngine): Promise<void> {
  let resolve: () => void;
  const promise = new Promise<void>((rs) => (resolve = rs));
  let caughtUp = false;

  const connect = () => {
    // ask eng to load our subscription starting position (based on lmdb)
    eng.reconnect(({ checkpoint: ckpt }) => {
      const start = ckpt ? { commit: BigInt(ckpt), prepare: BigInt(ckpt) } : START;
      const subscription = client.subscribeToAll({
        fromPosition: start,
        resolveLinkTos: true,
        filter: {
          filterOn: STREAM_NAME,
          prefixes: ['todo'],
          checkpointInterval: 1000,
        },
      });
      subscription.on('error', (e) => {
        // try again after error
        console.error('failure in subscription (trying again in 1s):', e);
        setTimeout(connect, 1000);
      });
      subscription.on('end', () => {
        // this should never happen; don't bother recovering
        process.stderr.write('unexpected end-of-stream', process.exit(1));
      });

      if (!caughtUp) {
        subscription.once('caughtUp', () => {
          caughtUp = true;
          eng.caughtUp();
          resolve();
        });
      }

      subscription.on('data', (ev: AllStreamResolvedEvent) => {
        // de-dupe: KurrentDB redelivers the event at `since`
        const position = Number(ev.commitPosition);
        if (position === ckpt) return;
        eng.recvEvents([
          {
            position: position,
            id: ev.event!.id,
            data: ev.event!.data,
          },
        ]);
      });
    });
  };

  connect();

  return promise;
}

function main() {
  // assume non-tls, connecting to localhost, with default creds
  const client = KurrentDBClient.connectionString`${KURRENT_CONNECTION_STRING}`;

  // create a single TodoEngine, with LMDB-based store.
  const eng = new TodoEngine(lmdbStore(), {
    migrate: migrateTodos,
    reducer: reduceTodos,
  });

  // subscribe once to $all stream, feeding all events to eng
  const catchup = configureSubscription(client, eng);

  // wait for first catchup before serving to clients
  console.log('catching up...');
  catchup.then(() => {
    console.log('done catching up');

    // start a websocket server
    const server = new WebSocketServer({ port: LISTEN_PORT });

    server.on('connection', (socket) => handleWebsocketConnection(client, eng, socket));

    console.log(`todo-thin server is listening on ${LISTEN_PORT}`);
  });
}

main();
