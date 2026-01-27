# Kurrent Engine

The sync engine that keeps you "kurrent".

Kurrent engine uses event sourcing to distribute state efficiently from KurrentDB to both backend
and frontend services.  Business logic for processing events can be written in TypeScript and resued
by both backend and frontend services.

## Repo Layout (wip)

The framework and the demo application are currently mixed together in `src/`, because I don't know
anything about packaging typescript libraries yet.  So the following files are framework files:

- `src/framework.ts`
- `src/query.ts`
- `src/projector.ts`
- `src/storage.ts`
- `src/future.ts`
- `src/util.ts`

And the demo files are:

- `src/index.ts`
- `src/App.tsx`
- `src/styles.css`
- `src/reducers.ts`

Additionally, the proto defintions is separated into framework components:

- `tools/protos.py`
- `tools/gen_ts.py`

and a demo-specific file defining the protos for the data model:

- `model/library.py`

And by running `pnpm gen`, a file `src/library.gen.ts` is created.

## Running the Demo

- `pnpm i`: install dependencies
- `pnpm gen`: generate code for data model
- `pnpm serve`: then access `http://localhost:3000` from a browser

## Architecture Diagrams

### Frontend Diagram (simple version w/o optimistic updates)

This diagram gives a useful mental model of the framework, but in practice would have issues that
UI events need to a network round trip before they appear in the UI (a user updates text in a field,
then has to wait a quarter second for that field's value to get update in storage and show in the
UI).

```
(* = owned by user)
 ____________________________________________________________
|                                                            |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | framework                                           |  |
|      _______________      ___________       __________     |
|   | |               |    |           |     |          | |  |
|     |*input shaping |--->| *reducers |<--->| *storage |    |
|   | |_______________|    |___________|     |__________| |  |
|         ^                                       |          |
|   |     |                                       |       |  |
|         |                               ________v____      |
|   |     |                              |             |  |  |
|         |                              | query graph |     |
|   |     |                              |_____________|  |  |
|         |                                     |            |
|   |_ _ _|_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
|         |                                     |            |
|       __|__________                        ___v__          |
|      |             |                      |      |         |
|      | *websocket  |<---------------------| *UI  |         |
|      |_____________|                      |______|         |
|            ^                                               |
|____________|_______________________________________________|
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

The abstract nature of the business logic in the

```
(* = owned by user)
 ______________________________________________________________________
|  PWA                                                                 |
|    _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _   |
|   | framework                                                     |  |
|      _______________      ___________       ____________________     |
|   | |               |  C |           |   D |                    | |  |
|     |*input shaping |--->| *reducers |<--->| *storage + overlay |    |
|   | |_______________|    |___________|     |____________________| |  |
|         ^ B                   ^               ^         |            |
|   |     |                     |               |         | E       |  |
|         |                _____|_______        |   ______v______      |
|   |     |               |             |       |  |             |  |  |
|         |               |*forecasters |       |  | query graph |     |
|   |     |               |_____________|       |  |_____________|  |  |
|         |                     ^ H             |         |            |
|   |     |          J          |           I   |         |         |  |
|         |       +-------------+---------------+         |            |
|   |_ _ _|_ _ _ _|_ _ _ _ _ _ _^_ _ _ _ _ _ _ _ _ _ _ _ _|_ _ _ _ _|  |
|         |       |             |                         | F          |
|       __|_______v__           |                      ___v__          |
|      |             |          |       G             |      |         |
|      | *websocket  |          +---------------------| *UI  |         |
|      |_____________|                                |______|         |
|            ^ A                                                       |
|____________|_________________________________________________________|
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

B: websocket to input shaping:
  - incoming events get batched for processing
  - probably a default batching logic is sufficient for most event streams
  - user can customize if they have specific "packets" boundaries

C: input shaping to reducers:
  - reducers process incoming batches
  - write result to storage
  - txn will be based on storage
  - overlay is invalidated (and reconstructed if necessary)

D: reducers to storage+overlay
  - when reducers run, they are provided a r+w txn
  - for real events, txn is based on storage
      - storage is provided by the user
      - any transactional key-value store works
  - for forecast events, txn is based on overlay
      - overlay is in-memory
      - reads prefer overlay but fall back to storage
      - writes only go to overlay

E: storage+overlay to query graph
  - query graph woken after every write txn
  - query graph always based on overaly
  - modified keys trigger reruns of queries

F: query graph to ui
  - ui creates queries, which are functions that do a series of key lookups and
    return a result that the UI cares about
  - queries are composable, so they are stored in a graph
  - each time a query is run, the graph captures the keys it looks up
  - after every txn, the graph reruns queries that depend on updated keys
  - queries that return different results on rerun wake up the ui
  - we should offer generic callback api, as well as popular UI integrations

G: ui passes new events into framework

H: new events to forecasters
  - forecaster creates 0 or more forecast events per new event
  - forecast events go to reducers to update overlay

I: new events saved to storage (outbox)

J: new events get sent over websocket



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
