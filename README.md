# Kurrent PhaseLock

No more polling for new data.  No more writing REST APIs.

Define your data types and how to process them once, and reuse that in your web
app, your mobile app, and your backend workers.

## How it works

An "event" is what happened, stored in KurrentDB.

A "command" is what a client submits, like an event but flowing towards
KurrentDB rather than read from it.

A "reducer" is a function that reads events to derive current state.

     ______________________________
    |          Frontend            |
    |  _________   _______   ____  |
    | |         | |       | |    | |
    | | Reducer | | State | | UI | |
    | |_________| |_______| |____| |
    |___^____________________|_____|
        |                    |
        | Events             | Commands
        | are                | are
        | read               | written
     ___|____________________v_____
    |           Backend            |
    |  __________________________  |
    | |                          | |
    | |         Server           | |
    | |__________________________| |
    |  __________________________  |
    | |                          | |
    | |        KurrentDB         | |
    | |__________________________| |
    |______________________________|


PhaseLock is tooling around this simple architecture to unlock:

- Live queries against current state
- Optimistic updates without modifying reducers or UI
- Offline-capable clients that maintain state locally
- Thin clients that rely on server-side state
- Hybrid clients that read server-side state while hydrating local state
- Backend workers that watch the event log to trigger side-effects

## How to get started

Kurrent PhaseLock is still in alpha.  Tests are sparse, docs are missing.

Your coding agent can help until our docs are ready.  Try:

- For Claude: `/plugin marketplace add kurrent-io/phaselock` (XXX, is that it?)
- For XXX: `...`

Then ask your agent, "how do I use PhaseLock to build \<decribe your app\>?"

Also check out our [examples](./examples), which demonstrate many of the core
capabilities.

Finally, skim through [skeleton.ts](XXX), the backbone to all of PhaseLock.

Open issues when you find them, and come say hi in [discord](XXX)!
