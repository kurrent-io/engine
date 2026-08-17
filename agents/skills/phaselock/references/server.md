# Building a server

PhaseLock does not prescribe a backend. The engine is IO-agnostic and the
wire protocol is yours; the examples use different protocols.
This file has three layers: the shapes a server can take, the strategy
for commands that conflict, and mechanics that apply to any of them
(validation, authn/authz, catchup, time).

A note on the word "relay": a relay is a pattern — something clients
connect to, that connects to KurrentDB, and forwards events from the
database to clients. A server may implement the relay pattern and more
(the library example), or not be a relay at all (the thin server below).

## Server shapes

Pick per app; a server may also compose several shapes.

### Event relay (fat clients)

The todo-basic server is the minimal relay: per client connection,
subscribe to KurrentDB and forward events; accept commands, validate,
append.

Server → client: forward each event as a `Committed` shape —
`{ "position": <commitPosition>, "id": "<event uuid>", "data": <event> }`
— plus some app-defined "caught up" signal when the subscription crosses
from history to live (todo-basic sends the bare string `"caughtup"`).
Honor the client's resume position (its checkpoint) from your handshake,
and beware redelivery of the event at that position.

Client → server: commands arrive as `Identified` shapes
(`{ id, data }`). Validate, then append to the log — reusing the wrapper
`id` as the stored event's id lets clients discard forecasts by id
alone.

Backpressure: a slow client must not buffer unboundedly. Pause the
KurrentDB subscription when the socket's send queue passes a high-water
mark, resume at a low-water mark (as todo-basic does).

### Thin server (server-side queries)

The todo-thin server holds the only engine: one engine instance for the
whole process, persistent store (LMDB via `ExternalStore`), fed by one
KurrentDB subscription. Clients hold no store; they subscribe to queries
declared in the model and receive results (see `queries.md` for the
generated API).

Shape of the server:

1. Build the engine over a persistent store; `reconnect()` for the
   checkpoint; subscribe to KurrentDB from there.
2. Wait for the first catch-up, call `caughtUp()`, then start accepting
   connections — never serve queries from a half-built store.
3. Per connection: instantiate the query defs with the connection's
   identity, validate incoming query tuples with the generated checker,
   `dispatch` to live handles, push results; close handles on disconnect.
4. Commands: validate, append, then acknowledge (todo-thin sends ordered
   acks so clients can trim their outbox).

Thin-server clients get no forecasts (there is no client store to
overlay); what they get instead is a tiny client and always-server-fresh
results. The same UI can run against either shape — that is the point of
the todo-basic/todo-thin pair.

### Backend worker

Any service can embed an engine to keep an always-current store fed by
the log: subscribe, `recvEvents`, and either react per event (a `case` in
the reducer) or watch derived state with a query and act on changes.
"Notify when X" becomes one `if` in a reducer instead of checks scattered
across every write path. Workers that only read need no wire protocol at
all.

## Conflicting commands

Some commands can conflict: two clients try to hold the last copy of a
book while an admin demotes one of them (the library example,
`examples.md`, which this section draws on throughout). If your app has
commands like that, this section is one decision tree — read it in
order.

### Reject at ingress, or capture and resolve

Choose a strategy per conflict domain.

**Rejecting at ingress is a real option.** KurrentDB's optimistic
concurrency control (an expected stream version on append) lets a server
serialize conflicting writes and refuse the losers before they enter the
log. For always-connected clients this is a simple solution that keeps
the event log easy to understand: the human is still present, context in
hand, and the wire protocol delivers the rejection milliseconds after the
rejected action was taken.

**Capture-then-resolve is the other strategy, and the calculus changes
with offline.** Commands from an offline-capable client are captured
human work — possibly hours of it, possibly a chain of commands where
later ones build on earlier ones — arriving long after the human made
the decisions. Rejecting that queue at reconnect discards intent
wholesale, when the person who could have re-decided is gone. (Imagine
git deleting your branch because your PR conflicted with main.) The
guiding principle: human effort is valuable and disk is cheap, so append
what happened and resolve conflicts after ordering. How visibly to surface a
resolution to the human is domain engineering, not framework policy: some
conflicts converge silently, some deserve a message in the UI (the library
shows the rejection reason for a failed TryHold), some deserve a full
review-and-redo flow. Decide per conflict domain, weighing how much intent is
at stake and how long clients stay offline.

### Where resolution runs

Resolution is a fold like everything else, and write-once reducers mean
it can run anywhere the data allows. The log gives every component the
same events in the same order, so any component that can see the
resolution's inputs reaches the same conclusion independently. When all
consumers can see those inputs — conflicting edits in a project whose
members all see the whole project — resolution is reducer code:
every client and server hits the conflict at the same log position and
resolves it identically. No extra component, no coordination, no new
events.

### The decider

A decider is needed when resolution inputs cross a visibility
boundary: judging a `try-hold` takes global patron state, and clients
cannot see it. Then a privileged component runs the fold and records
its conclusions as decision events; clients consume the recorded
decisions because they cannot re-derive them.

A decider is a backend worker with three extra properties:

- It reads the ordered log and applies reducers that make the
  decision (accept → emit a decision event like `new-vhold`; reject →
  emit `vhold-rejected` with a reason).
- It publishes those decision events back to the log (the library's
  decider collects them in a store key, then appends them to a `vstatus`
  stream after each batch).
- It runs with at most one active instance — not because the fold
  needs one runner (deterministic folds don't), but because recorded
  decisions need a single author, or the log fills with duplicate and
  conflicting decision events. It checkpoints its progress in a
  dedicated stream using optimistic concurrency, so a restart resumes
  where it left off and a duplicate instance loses the write race. To
  scale, shard the domain, one runner per shard.

If no resolution needs data its consumers can't see, no decider is
needed; an app with several such domains may run several. Design the
events first: `try-*` commands in, decision events out.

## Validation

Two layers, both server-side, before anything is appended:

**Structural** — always. The generated checkers verify raw JSON against
the model (`checkTodoEvents(cmd.data)` returns a list of problems; empty
means valid). Available in TS, Python, and Go. Reject and drop the
connection on garbage; never repair a command.

**Semantic** — further protect the event log against junk data.  For example,
the library example's relay enforces that object references in a command must
already exist:

```python
new_uuids, errors = engine.simulate(validator, batch)
if errors:
    raise UserError(errors)
```

Semantic validation can reject broken references ("no such book") and
authorization failures ("can't cancel another user's hold").  It should
not reject what only a race could make invalid; that can only be decided by
writing the event to KurrentDB.  Neither conflict resolution strategy (OCC or
post-commit resolution) adds value pre-commit.  A validating server must also
wait for its own appends to round-trip through its subscription before
validating the next batch against them (the library relay keeps a position
watermark for this).

## Client-minted ids

Entity ids arrive minted by clients (see `client.md` for why that is
load-bearing for offline apps, and for the not-yet-supported
server-minted alternative); the server's job under this scheme is to
honor and police them, not to assign its own:

- **Honor**: reuse the `Identified` wrapper id as the stored event's id,
  so clients can match their commands to committed events by id alone.
  This is not a requirement per se, but where this is not followed, user
  code will have to inform the Engine when commands have round-tripped
  either through reducer return values or `Engine.markSent()`.
- **Police uniqueness**: enforce per-id uniqueness with optimistic
  concurrency — append a tiny event to stream `uuid.<id>` with "no
  stream" expected version; the append fails if the id exists (library
  relay pattern). This also makes outbox retries safe: a resent creation
  is detected instead of silently duplicated.
- **Validate references**: semantic validation checks that ids a command
  cites exist, and tracks ids the same batch creates (the library
  validators collect `newUuids` so a chain of queued commands validates
  as a unit).

## Where authn/authz go

PhaseLock has no auth framework; it has three well-defined places where
your policy plugs in. Auth is your responsibility — these are the
places it goes:

1. **Identity at the connection.** Authenticate when the client connects
   (handshake token, session cookie, mTLS — your choice). Everything
   after keys off that identity. The examples skip real authentication;
   your app still needs it.
2. **Authorization at command ingress.** Semantic validation receives the
   identity and enforces write rights: a patron may rename only
   themselves, cancel only their own holds; an admin may do more. This can
   be implemented as reducer-shaped code that runs in `Engine.simulate()`
   to be able to read from Storage to make decisions against latest-known
   state.
3. **Sanitization on the way out.** Whatever streams a client is not
   entitled to see in full, the server rewrites or withholds before
   forwarding:
   - route: per-user streams go only to their owner (`patron.<id>` to
     that patron, everything to admins);
   - strip: remove fields non-owners must not see (the library relay
     deletes `patron` from `new-vhold` before broadcasting);
   - target: some events go only to the affected user
     (`vhold-rejected` only to its patron).
   The client's store is then derived entirely from what it was allowed
   to see — an unprivileged store never contains the secret in the
   first place, which is the strongest possible client-side guarantee.
   For thin servers the same principle applies to query results:
   instantiate the connection's `QueryDefs` with its identity and
   filter/shape inside the query bodies.

The distribution mechanics map onto the data-visibility categories from
`data-model.md`: public domains broadcast, sharded domains route by
owner, virtualized domains rewrite (possibly with added decision events).
Model support: declare per-audience stores and event variants in the
data model (the library's `VHold` carries `patron?` — present only for
the owner). Sanitized reality is a first-class shape, not an
afterthought, but it is entirely up to user code to actually implement.

It is also worth noting that sanitizing events and sanitizing server-side query
results will almost always require two different implementations of the same
authorization policy; since one must be applied per event and the other to the
output state.  Keep this in mind when implementing both fat and thin clients in
the same application.

## Catchup-to-live handoff

A server composing history reads with a live subscription (e.g. the
library relay serving per-client catchup from `read_all` while sharing
one live `subscribe_to_all`) must bridge the gap without loss or
duplication: cold catchup → attach to live (buffering) → hot catchup of
the gap → drain the buffer, discarding positions already sent → live.  Note
that the cold catchup step is pure memory optimization, not necessary for
correctness.  If the server instead holds one KurrentDB subscription per client
(todo-basic), KurrentDB's own caught-up notification does all of this for you —
for POCs and prototypes, start there, but don't take that into production.

## Time-based triggers

Nothing in PhaseLock fires on time (see ROADMAP and the Tick pattern in
`reducers.md`). When scheduled work has consequences that race —
expirations, overdue checks — run the ticker in a backend worker: it
watches a wakeups query on its own store, sleeps until due, submits a
Tick, and the reducer emits the decision events (e.g.
`overdue-checkout`). One ticker per domain, same at-most-one care as a
decider if the decisions conflict.
