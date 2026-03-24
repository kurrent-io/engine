# Kurrent Engine

The sync engine that keeps you "kurrent".

Kurrent engine uses event sourcing to distribute state efficiently from KurrentDB to both backend
and frontend services.  Business logic for processing events can be written in TypeScript and resued
by both backend and frontend services.

## Repo Layout (wip)

The tooling for defining types and generating code is in `tools/`:

- `tools/protos.py` defines the available types
- `tools/skeleton.{ts,py,go}` are starting points for the code generators
- `tools/gen_{ts,py,go}.py` are the code generators themselves

The data model is defined in `model/`.  The basic idea is that a bundler (`rollup`, in this case) is
used to capture the all the business logic in `model/` and expose it to one of the system components
(the `ui`, the `relay`, or the `decider`):

- `model/library.py` defines the data types using types from `tools/protos.py`
- `model/library.gen.ts` is the output of running `tools/gen_ts.py` to `model/library.py`
- `model/reducers.ts` contains the business logic for compiling snapshots from events
- `model/{ui,relay,decider}.ts` are the stubs that export names for use in each system component.

Each system component (`ui/`, `relay/`, `decider`) follows a similar pattern:

- The `model/` is bundled into a json file:
    - `relay/model.py`
    - `decider/model/model.go`
    - `ui/src/{model.js,model.d.ts}`
- The remaining files implement approximately the user code needed to consume the framework.
- The relay additioanl contains quickjs bindings for python in `relay/_quickjs.c`.

All outputs (except the built ui) can be generated or built by running `make`.  Type checking for
python and typescript can be ran with `make check`.

## Running the Demo

- `cd model && pnpm i`: install dependencies for model
- `cd ui && pnpm i`: install dependencies for ui
- `make`: generate and compile all non-ui outputs
- `cd ui && pnpm serve`: run the ui demo

## Architecture Diagrams

### Frontend Diagram (simple version w/o optimistic updates)

This diagram gives a useful mental model of the framework, but in practice would have issues that
UI events need to a network round trip before they appear in the UI (a user updates text in a field,
then has to wait a quarter second for that field's value to get update in storage and show in the
UI).

```
(* = owned by user)
 ____________________________________________
|                                            |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | framework                           |  |
|      ___________            __________     |
|   | |           |          |          | |  |
|     | *reducers |<-------->| *storage |    |
|   | |___________|          |__________| |  |
|         ^                       |          |
|   |     |                       |       |  |
|         |               ________v____      |
|   |     |              |             |  |  |
|         |              | query graph |     |
|   |     |              |_____________|  |  |
|         |                     |            |
|   |_ _ _|_ _ _ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
|         |                     |            |
|       __|__________        ___v__          |
|      |             |      |      |         |
|      | *websocket  |<-----| *UI  |         |
|      |_____________|      |______|         |
|            ^                               |
|____________|_______________________________|
             |
        _____v______
       |            |
       |  *server   |
       |____________|
             ^
             |
        _____v______
       |            |
       | KurrentDB  |
       |____________|
```

### Frontend Diagram (full w/ optimistic updates)

The abstract nature of the business logic encourages the reducers block to be free of side-effects,
making it easy to to reuse that business logic with an in-memory storage overlay to achieve
optimistic UI updates.  This requires an extra function from the user, which I call a "forecaster",
that produces events the application expects the server to create from each outgoing command.

```
(* = owned by user)
 ______________________________________________________
|  PWA                                                 |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | framework                                     |  |
|       ___________           ____________________     |
|   |  |           |       C |                    | |  |
|      | *reducers |<------->| *storage + overlay |    |
|   |  |___________|         |____________________| |  |
|         ^ B    ^              ^         |            |
|   |     |      |              |         | D       |  |
|         |     _|___________   |   ______v______      |
|   |     |    |             |  |  |             |  |  |
|         |    |*forecasters |  |  | query graph |     |
|   |     |    |_____________|  |  |_____________|  |  |
|         |             ^ G     |         |            |
|   |     |         I   |     H |         |         |  |
|         |       +-----+-------+         |            |
|   |_ _ _|_ _ _ _|_ _ _^_ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
|         |       |     |                 | E          |
|       __|_______v__   |              ___v__          |
|      |             |  | F           |      |         |
|      | *websocket  |  +-------------| *UI  |         |
|      |_____________|                |______|         |
|            ^ A                                       |
|____________|_________________________________________|
             |
        _____v______
       |            |
       |  *server   |
       |____________|
             ^
             |
        _____v______
       |            |
       | KurrentDB  |
       |____________|
```

**Interfaces**

A: server to/from websocket:
  - server authenticates connection
  - server authorizes which streams a client can read, relays from KurrentDB
  - server authorizes and validates incoming write events, relays to KurrentDB
  - websocket automatically reconnects after network disruptions

B: websocket to reducers:
  - incoming events accumulate into batches while waiting for processing
  - checkpoint data is passed along with events
  - user can customize batch boundaries if they have specific "packet" boundaries to honor
  - reducers process incoming batches
  - write result to storage, along with provided checkpoint
  - txn will be based on storage
  - overlay is invalidated (and reconstructed if necessary)

C: reducers to storage+overlay
  - when reducers run, they are provided a r+w txn
  - for real events, txn is based on storage
      - storage is provided by the user
      - any transactional key-value store works
  - for forecast events, txn is based on overlay
      - overlay is in-memory
      - reads prefer overlay but fall back to storage
      - writes only go to overlay

D: storage+overlay to query graph
  - query graph woken after every write txn
  - query graph always based on overaly
  - modified keys trigger reruns of queries

D: query graph to ui
  - ui creates queries, which are functions that do a series of key lookups and
    return a result that the UI cares about
  - queries are composable, so they are stored in a graph
  - each time a query is run, the graph captures the keys it looks up
  - after every txn, the graph reruns queries that depend on updated keys
  - queries that return different results on rerun wake up the ui
  - we should offer generic callback api, as well as popular UI integrations

F: ui passes new events into framework

G: new events to forecasters
  - forecaster creates 0 or more forecast events per new event
  - forecast events go to reducers to update overlay

H: new events saved to storage (outbox)

I: new events get sent over websocket


## Backend Diagram

Or: "Yes, this framework will be useful in backends, too".

Note that the Server shown here scales horizontally, but the decider needs to have at-most-one
runners at a time.  To scale it, you'd need to shard its responsibility (and you'd still have
at-most-one runner mechanics within each shard).
```
               ____________________________________________
             _|__________________________________________  |
           _|__________________________________________  | |
          |                                            | |_|
          |                  clients                   |_|
          |____________________________________________|
              ^                                   |
              | events                            | commands
 _____________|___________________________________|____________
| Server      |                                   |            |
|     ________|___________________________________v____        |
|    |                                                 |       |
|    |                  websockets                     |       |
|    |_________________________________________________|       |
|             ^                                   |            |
|      _______|_________                  ________v_____       |
|     |                 |                |              |      |
|     | incoming stream |                | authn checks |      |
|     |_________________|                |______________|      |
|             ^                                   |            |
|_____________|___________________________________|____________|
              |                                   |
 _____________|___________________________________v____________
|                                                              |
|                         KurrentDB                            |
|______________________________________________________________|
              ^                                   |
 _____________|___________________________________|____________
| Decider     |                                   |            |
|             |                          _________v________    |
|             | outgoing                |                  |   |
|             | decision                | committed events |   |
|             | events                  |__________________|   |
|             |                                   |            |
|  _ _ _ _ _ _|_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _|_ _ _ _ _   |
| | framework |                                   |         |  |
|       ______|______       _________       ______v___         |
| |    |             |     |         |     |          |     |  |
|      | query graph |<----| storage |<--->| reducers |        |
| |    |_____________|     |_________|     |__________|     |  |
|                                                              |
| |_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _|  |
|______________________________________________________________|
```
