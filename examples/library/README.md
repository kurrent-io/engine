
[**library**](./library) models a library (as in, "a place to check out books"),
illustrating how the PhaseLock architecture solves complex collaboration
problems with ease.  Additionally, this example shows:
- offline-capable UIs with optimistic updates
- a backend worker uses PhaseLock for resolving conflicts
- a relay that sanitizes events for the client
- a relay that uses PhaseLock to semantically validate commands
- cross-language packaging of a PhaseLock data model into go and python


## `library`

A simulated library (as in "the place where you check out books"), according to
[this domain description](https://github.com/ddd-by-examples/library).  A library system offers many
interesting race conditions possible, such as two researchers simultaneously trying to reserve a
restricted book, while a library administer is simultaneously demoting one of them from "researcher"
to plain "patron".

The reducer pattern in Kurrent PhaseLock shines here.  Reducers are plain functions expressing pure
business logic, so even challenging distributed problems, which come up often in distributed
applications, are solved with boring, testable code.

This example illustrates one frontend with multiple backends:

  - `library/relay` shows the "stateful relay" backend: each connection is processed

  - `library/cdn` illustrates how to use cloudflare's CDN can be used to achieve massive scaleout of
    both event-log subscriptions and server-side queries.






### Frontend Diagram (full w/ optimistic updates)

The abstract nature of the business logic encourages the reducers block to be free of side-effects,
making it easy to to reuse that business logic with an in-memory storage overlay to achieve
optimistic UI updates.  This requires an extra function from the user, which I call a "forecaster",
that produces events the application expects the relay to create from each outgoing command.

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
           |   *relay   |
           |____________|
                 ^
                 |
            _____v______
           |            |
           | KurrentDB  |
           |____________|


## Backend Diagram

Or: "Yes, this framework will be useful in backends, too".

Note that the relay shown here scales horizontally, but the decider needs to have at-most-one
runners at a time.  To scale it, you'd need to shard its responsibility (and you'd still have
at-most-one runner mechanics within each shard).

                   ____________________________________________
                 _|__________________________________________  |
               _|__________________________________________  | |
              |                                            | |_|
              |                  clients                   |_|
              |____________________________________________|
                  ^                                   |
                  | events                            | commands
     _____________|___________________________________|____________
    | Relay       |                                   |            |
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


## Run the example

Steps to run the example:

  - ensure `docker` is available (to run KurrentDB locally)
  - ensure `go` is installed (for decider/)
  - ensure `python3` is installed, plus python-dev headers, plus a C compiler
  - install npm dependencies: `pnpm i`
  - build everything: `make`
  - run the demo: `make dev`
  - visit `http://localhost:3000` in your browser
