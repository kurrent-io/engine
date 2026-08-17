# todo-thin

This example builds on the [todo-basic](XXX) example by adding Query defintions
to the data model.  This unlocks the ability to power the _exact same ui_ but
with the PhaseLock Engine now running in the server.


## Architecture

The logical flow of information is circular:

- KurrentDB stores events.
- The server feeds fresh events the PhaseLock Engine.
- The server pushes updated query results to clients.
- Clients update their UI with fresh data.
- User actions generate commands to send to the server.
- The server validates commands and writes new events to KurrentDB.
- KurrentDB emits fresh events, the cycle continues.

     ______________________________________
    |                                      |
    |           todo-thin web app          |
    |______________________________________|
               ^                 |
               | query results   | commands
     __________|_________________|_________
    | server   |                 |         |
    |   _ _ _ _|_ _ _ _ _ _      |         |
    |  | PhaseLock Engine  |     |         |
    |        __|______           |         |
    |  |    |      [1]|    |     |         |
    |       | queries |          |         |
    |  |    |_________|    |     |         |
    |        _________           |         |
    |  |    |      [1]|    |     |         |
    |       |  store  |          |         |
    |  |    |_________|    |     |         |
    |        _________           |         |
    |  |    |      [2]|    |     |         |
    |       | reducer |          |         |
    |  |    |_________|    |     |         |
    |          ^                 |         |
    |  |_ _ _ _|_ _ _ _ _ _|     |         |
    |__________|_________________|_________|
               |                 |
               | events          | commands
     __________|_________________v_________
    |                                      |
    |             KurrentDB [1]            |
    |______________________________________|

XXX:

[1] model/model.tsp define event and query types and store layout using TypeSpec
[2] model/reducers.ts defines reducer functions that build state from events
[3] ui/src/Window.tsx defines queries in-line with the UI components.
[4] ui/src/useQuery.ts defines the react hook for queries.
[5] ui/src/usePhaseLock.ts connects a websocket to a PhaseLock Engine.
[6] server/main.ts relays events and commands between KurrentDB and the clietnt.

## Run the example

Steps to run the example:

  - ensure `docker` is available (to run KurrentDB locally)
  - install dependencies: `pnpm i`
  - generate code: `pnpm gen`
  - run the demo in dev mode: `pnpm dev`
  - visit `http://localhost:3000` in your browser
