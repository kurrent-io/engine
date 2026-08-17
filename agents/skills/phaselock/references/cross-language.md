# Cross-language runtimes

The core idea of PhaseLock is that business logic is expressed as *code,
not schema*. Reducers therefore have to be written in some language, and
TypeScript is the chosen one. That makes TypeScript-as-host naturally
seamless — as a byproduct, not by design. Cross-language hosts are still
first-class, and two design choices are what make them palatable:

- **Input events are mostly opaque.** A host pipes events into the
  engine without interpreting them; it only handles the envelope.
- **Query results come out in the host's native types.** The read side
  can be written in the host language: a query body constructs a native
  value, and the query graph tunnels it by reference — never
  serialized — to the subscriber. Reading state is not a foreign-function
  exercise.

Because the generated query contexts are ordinary typed code in each
language, model changes propagate as native type errors: change the
`.tsp`, regenerate, and your host language type-checking or compiler
breaks where the host code no longer matches the model. Cross-language type
checking is real, not aspirational.

## What a host does

Every non-TypeScript component has the same shape:

1. Bundle the business logic (below) and load it into an embedded JS
   engine via the generated wrapper, which exposes the engine and checkers as
   native APIs.
2. Subscribe to relevant events — from a relay or from KurrentDB,
   depending on whether it is a frontend or a backend.
3. Feed events to the engine in `{position, id, data}` envelopes, running the
   reducers.
4. Query state in native types and act on results.

Reducers, forecasters, and validators are always TypeScript, wherever
they run — the business-logic development loop (including tests, see
`reducers.md`) is TypeScript even when no host is. The host language
owns IO and everything IO-shaped: connecting, batching, reshaping,
backpressure. That is the cost of the engine being IO-agnostic, and it
applies equally to TypeScript hosts.  Future host bindings will include
integrations with KurrentDB clients to relieve some of that IO burden.

The embedded JS runtime itself has a nonzero cost. For client
applications it is assumed trivial. For backend workers in a high-write
environment it can be material: at some write rate, running the logic on
a native JS runtime (Node) beats embedding one. Practical guidance:
frontend environments are opinionated about language (web, iOS,
Android), so clients should expect the engine to come to them; backends
choose freely — syncing an external system is usually best served by the
language with the best client for that system, and a performance-
critical worker that only consults queries while doing its primary job
is well served by embedding the engine in the faster language.

## Officially supported hosts

| Host | JS engine | Guide |
|------|-----------|-------|
| TypeScript / JavaScript | native (browser, Node) | `client.md`, `server.md` |
| Python | QuickJS | `py.md` |
| Go | goja (pure Go) | `go.md` |

Official support for C#, Kotlin, and Swift is planned (see ROADMAP.md).
Requests for other languages: open a GitHub issue or ask in Discord. A
motivated user or agent can add a host today, using the existing
emitters and their runtime skeletons as examples.

## Bundling

Each component gets an entry stub in the model package exporting what
that component needs:

```typescript
// model/relay.ts
export { RelayEngine } from './model.gen';
export { relayMigrate, relayReducer, validateUserCommands } from './reducers';
```

A bundler collapses stub + generated code + reducers into one
self-contained JS file per component. The stub is the component's
contract: a decider bundle need not carry UI forecasters, and the
bundle's export names are what the host passes to the engine constructor
("relayMigrate", "relayReducer").

Bundle with inline sourcemaps: stack traces coming out of the embedded
engine then point at real TypeScript lines instead of bundle offsets.
The exact bundler commands (and each language's required module format)
live in the per-language guides.
