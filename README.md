# Kurrent PhaseLock

No more polling for new data.  No more writing REST APIs.

Define your data types and how to process them once, and reuse that in your web
app, your mobile apps, and your backend workers.

## How does PhaseLock work?

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

## Do I need KurrentDB to use PhaseLock?

Well technically no.

PhaseLock is an "event sourcing" architecture, which is where events are
_saved_ and state is _derived_.  So all PhaseLock needs is events, and how you
produce those events is up to you.

But KurrentDB is the best event sourcing database, so... we're not sure why you
wouldn't use KurrentDB.

## How do I start using PhaseLock?

Kurrent PhaseLock is still in alpha.  Tests are sparse, docs are missing.

Your coding agent can help until our docs are ready.  Try:

- For Claude: `/plugin marketplace add kurrent-io/phaselock` (XXX, is that it?)
- For XXX: `...`

Then ask your agent: "How do I use PhaseLock to build \<decribe your app\>?"

Also check out our [examples][examples], which demonstrate many of the core
capabilities.

Finally, skim through [skeleton.ts][skeleton-ts], the backbone to all of PhaseLock.

Open issues when you find them, and come say hi in [discord][discord]!

[examples]: https://github.com/kurrent-io/phaselock/tree/master/examples
[skeleton-ts]: https://github.com/kurrent-io/phaselock/blob/master/tools/emitter-ts/assets/skeleton.ts
[discord]: https://discord.gg/Phn9pmCw3t
