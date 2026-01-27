import { OverlayStorage, Storage, withRTxn, withWTxn, txnGet, txnSet, txnDel } from './storage';
import { ProjectorGenerator, runProjector } from './projector';
import { QueryGraph, QueryFunction, Query } from './query';
import { FutureContext } from './future';
import { generateUuid } from './util';

interface TypeSet<PX, QX, E, C> {
  // projector context
  px: PX;
  // query context
  qx: QX;
  isEvent(e: E): true;
  isCommand(c: C): true;
};

// "P"rojectorConte"x"t
// "Q"ueryConte"x"t
// "E"vents
// "C"ommands
// check"P"oint
export class Framework<PX, QX, E, C, P> {
  #storage: Storage;
  #shaper: (events: E[]) => {events: E[], checkpoint: P};
  #projector: (events: E[]) => ProjectorGenerator<void>; // wrapper around user's projector
  #forecaster: null | ((commands: C[]) => E[]);
  #forecastKey: null | ((event: E) => string);
  #onCommands: null | ((commands: C[], onSent: ()=> void) => void);

  #overlay: OverlayStorage;
  #graph: QueryGraph<QX>;
  #coro: Generator<void, void, void>;
  #fx: FutureContext;

  #scheduled: boolean = false;

  // #reconnects is a list of promise resolve functions
  #reconnects: ((value: {checkpoint: P | undefined, commands: C[]}) => void)[] = [];
  #recvdEvents: E[] = [];
  #recvdCommands: C[] = [];
  #sentCommands: string[] = [];
  #forecasts: Map<string, E> = new Map();
  // just a flag if new queries exist to be run; we don't store them here for typing purposes.
  #newQueries: boolean = false;

  constructor(
    typeset: TypeSet<PX, QX, E, C>,
    storage: Storage,
    callbacks: {
      // required: new events from the wire may be batched, and a checkpoint is produced
      shaper: (events: E[]) => {events: E[], checkpoint: P},
      // required: project a batch of events into the read model
      projector: (px: PX, events: E[]) => ProjectorGenerator<void>,
      // optional: forecast the events a server will send for a command
      forecaster?: (commands: C[]) => E[],
      // required if using forecaster: create a unique forecast key for an event; used to create a
      // map of forecast events and to invalidate the forecasted event when the real event arrives
      forecastKey?: (event: E) => string,
      // required if using sendCommands: receive events to send on the wire and a callback to signal
      // when that succeeded
      onCommands?: (commands: C[], onSent: ()=> void)=> void,
    },
  ) {
    this.#storage = storage;
    this.#shaper = callbacks.shaper;
    this.#projector = (events: E[]) => callbacks.projector(typeset.px, events);
    this.#forecaster = callbacks.forecaster ?? null;
    this.#forecastKey = callbacks.forecastKey ?? null;
    this.#onCommands = callbacks.onCommands ?? null;
    if (this.#forecaster && !this.#forecastKey) {
      throw new Error("forecastKey is required if forecast is set");
    }

    this.#overlay = new OverlayStorage(this.#storage);
    this.#graph = new QueryGraph(typeset.qx);

    this.#coro = this.#advancer();
    this.#fx = new FutureContext(this.#coro);
    // let the advancer begin initializing
    this.#fx.wakeup();
  }

  //// public api ////

  // request info needed to resume a connection: last committed checkpoint and unsent commands
  reconnect(): Promise<{checkpoint: P | undefined, commands: C[]}> {
    return new Promise((resolve) => {
      this.#reconnects.push(resolve);
    });
  }

  // new events from the wire come here
  recvEvents(events: E[]): void {
    this.#recvdEvents.push.apply(this.#recvdEvents, events);
    this.#schedule();
  }

  // after forecasting and saving to storage, these will appear in an onCommands() callback
  sendCommands(commands: C[]): void {
    if (!this.#onCommands) {
      throw new Error("sendCommands() used but onCommands callback was not set");
    }
    this.#recvdCommands.push.apply(commands);
    this.#schedule();
  }

  // add a new Query to the graph
  newQuery<T>(fn: QueryFunction<QX, T>): Query<T> {
    this.#newQueries = true;
    this.#schedule();
    return this.#graph.newQuery(fn);
  }

  //// end of public api ////

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.#fx.wakeup();
    });
  }

  *#initialize(): Generator<void, void, void> {
    const self = this;
    if (!this.#forecaster) return;

    // load unset commands from storage
    const commands: C[] = [];
    yield* withRTxn(this.#fx, this.#storage, function*() {
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      for (const uuid of Object.keys(index)) {
        // TODO: convert from json for typed return value
        const batch = yield* txnGet(`.command-${uuid}`)
        commands.push.apply(batch);
      }
    });
    if (commands.length === 0) return;

    // forecast events
    const forecasts = this.#forecaster(commands);
    if (forecasts.length === 0) return;

    // remember these forecasts for later
    for (const forecast of forecasts) {
      const key = this.#forecastKey!(forecast);
      this.#forecasts.set(key, forecast);
    }

    // populate the initial overlay
    yield* withWTxn(this.#fx, this.#overlay, function*() {
      yield* runProjector(self.#projector(forecasts));
      // ignore updated keys and don't trigger a run of the graph; let that happen as part of the
      // normal newQuery processing
    });
  }

  // our main logic is implemented as a coroutine
  *#advancer(): Generator<void, void, void> {
    yield* this.#initialize();

    // what are the different things we can have to do?
    // - receive events,
    //     - then shape them,
    //     - then pass shaped events into projectors,
    //     - then commit that result along with the checkpoint,
    //     - then take the commit and pass it to the query graph
    // - recieve sentCommands and update commands in storage
    // - receive sendCommands
    //     - then commit them to storage,
    //         - then send those to onCommand hook
    //     - then forecast events,
    //     - then pass them to projectors,
    //     - then commit that result to the overlay
    //     - then pass that commit to the query graph
    // - recieve a new query
    //     - extend the graph
    // - recieve a reconnect request
    //     - then return the checkpoint in storage
    while(true){
      if (this.#recvdEvents.length > 0) {
        yield* this.#onRecvEvents();
        continue;
      }

      if (this.#recvdCommands.length > 0) {
        yield* this.#onSendCommands();
        continue;
      }

      if (this.#sentCommands.length > 0) {
        yield* this.#onSentCommands();
        continue;
      }

      if (this.#newQueries) {
        yield* this.#onNewQueries();
        continue;
      }

      if (this.#reconnects.length > 0) {
        yield* this.#onReconnects();
        continue;
      }

      // if we got here we probably had a spurious wakeup
      yield
    }
  }

  *#onRecvEvents(): Generator<void, void, void> {
    const self = this;
    // input shaping step, which also produces a checkpoint
    const {events, checkpoint} = this.#shaper(this.#recvdEvents);
    this.#recvdEvents = [];

    // open a write txn to real storage
    // IDEA: what if we wrote a txn wrapper that could automatically allow high-value gets/sets to
    // happen in between the normal gets/sets?
    const updates = yield* withWTxn(this.#fx, this.#storage, function*(){
      // update our checkpoint when this txn finishes
      yield* txnSet(".checkpoint", checkpoint);

      // run the projector with our new events
      return yield* runProjector(self.#projector(events));
    })
    this.#graph.dirty(updates);

    // our old overlay is now invalid; start a new one
    this.#graph.dirty(this.#overlay.keys());
    this.#overlay = new OverlayStorage(this.#storage);

    // clean up now-irrelevant forecasts
    if (this.#forecasts.size > 0) {
      for (const event of events) {
        const key = this.#forecastKey!(event);
        this.#forecasts.delete(key);
      }
    }

    // rebuild overlay using all remaining forecasts
    if (this.#forecasts.size > 0) {
      yield* withWTxn(this.#fx, this.#overlay, function*(){
        const updates = yield* runProjector(
          self.#projector([...self.#forecasts.values()]),
        );
        self.#graph.dirty(updates);
      });
    }

    const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
      // this will run all queries, even new ones
      self.#newQueries = false;
      return yield* self.#graph.run();
    });
    cbs();
  }

  *#onSendCommands(): Generator<void, void, void> {
    const self = this;
    const commands = this.#recvdCommands;
    this.#recvdCommands = [];

    const uuid = generateUuid();

    // open a write txn to real storage
    yield* withWTxn(this.#fx, this.#storage, function*(){
      // save a batch of commands
      // TODO: convert to json for untyped access
      yield* txnSet(`.command-${uuid}`, commands);
      // extend the index of batches
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      yield* txnSet(`.commands`, {...index, uuid: true});
    });

    // define a hook to trigger cleanup when those commands are actually sent
    const onSent = () => {
      this.#sentCommands.push(uuid);
      this.#schedule();
    };

    // now forecast events based on those commands
    if (this.#forecaster) {
      const forecasts = this.#forecaster(commands);
      if (forecasts.length > 0) {
        // remember these forecasts for later
        for (const forecast of forecasts) {
          const key = this.#forecastKey!(forecast);
          this.#forecasts.set(key, forecast);
        }

        // open a write txn against the existing overlay
        const updates = yield* withWTxn(this.#fx, this.#overlay, function*(){
          return yield* runProjector(self.#projector(forecasts));
        });
        this.#graph.dirty(updates);

        const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
          // this will run all queries, even new ones
          self.#newQueries = false;
          return yield* self.#graph.run();
        });
        cbs();
      }
    }

    // schedule a callback for the user to know it is time to send the commands
    setTimeout(() => this.#onCommands!(commands, onSent));
  }

  *#onSentCommands(): Generator<void, void, void> {
    const self = this;
    yield* withWTxn(this.#fx, this.#storage, function*(){
      // load the index of batches of commands
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      // delete any batches we know to be sent
      let uuid;
      while ((uuid = self.#sentCommands.shift())) {
        yield* txnDel(`.command-${uuid}`);
        delete index[uuid];
      }
      // update the index
      yield* txnSet(".commands", index);
    });
  }

  *#onNewQueries(): Generator<void, void, void> {
    const self = this;
    const cbs = yield* withRTxn(this.#fx, this.#overlay, function*(){
      self.#newQueries = false;
      return yield* self.#graph.extend();
    });
    cbs();
  }

  *#onReconnects(): Generator<void, void, void> {
    const {checkpoint, commands} = yield* withRTxn(this.#fx, this.#storage, function*(){
      const checkpoint = (yield* txnGet(".checkpoint")) as (P | undefined);
      const commands: C[] = [];
      const index = (yield* txnGet(".commands")) as Record<string, true> ?? {};
      for (const uuid of Object.keys(index)) {
        // TODO: convert from json for typed return value
        const batch = yield* txnGet(`.command-${uuid}`)
        commands.push.apply(batch);
      }
      return {checkpoint, commands};
    });
    for (const resolve of this.#reconnects) {
      resolve({checkpoint, commands});
    }
    this.#reconnects = [];
  }
}
