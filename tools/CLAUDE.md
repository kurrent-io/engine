# TypeSpec DSL — status and design decisions

Context for working on the TypeSpec model tooling (`@kurrent/typespec-engine` + the three
emitters).  See README.md for layout, build commands, and the test suite.

## Status

This is the repo's model tooling.  It replaced the earlier in-repo Python DSL
(`tools/protos.py` + `tools/gen_*.py`, retired July 2026) after a byte-for-byte comparison
period; the only intended output differences were union-member ordering (the Python DSL used
frozenset hash order, this pipeline preserves declaration order) and the generated-file headers.
Demo data models live with the demos (`model/library.tsp`, `todo/model/model.tsp`), which
depend on the engine and emitter packages via `link:` entries; demo makefiles drive generation
(`make model` from the demo directory).

## Design decisions

- **Declaration style: interface templates.**
  `interface BookStore extends Store<{"edition.{isbn}": Edition}> {}` and
  `interface RelayFramework extends Framework<LibraryEvents, RelayCommands, RelayStore> {}`.
  Quoted property names carry key templates directly, deps are a tuple template param
  (`Store<Spec, Deps = []>` — templates have no varargs), and interfaces don't pollute the
  data-type space.  Lowering discovers them via `sourceInterfaces` + `templateMapper.args`
  (unwrapping `Indeterminate` entities — model expressions and tuple literals arrive as
  type-or-value).
- **Queries are interfaces too**: `interface AdminQueries extends Queries { allPatrons(): AdminPatronInfo[]; }`
  declares a typed query contract — a message contract only, binding no store (which storage backs
  an implementation is the implementation's business).  Lowering collects them as `KQueries`
  (one `KQuery` per op: name, args, result) on `LoweredProgram.queries` for the emitters to walk.
  The full generated-API plan is QUERIES.md at the repo root.
- **Commands stay a union** (`Framework<Events, Commands, Store>`).  Someday: allow a
  null/omitted Commands argument, with commands declared as ops in the framework interface body
  instead — the endgame where the command union is *derived* from the interface:
  `interface UserFramework extends Framework<LibraryEvents, UserStore> { tryHold(cmd: TryHold): NewVHold | VHoldRejected; ... }`
  The op return type declares the command→event correlation that today lives only in decider code
  and forecasters.
- **`op` is reserved for that commands-as-operations future.**  Do not spend it as a generic
  `X = f(args)` binder for stores/frameworks (it works — `op X is store<...>` — but collides with
  the higher-value meaning).
- **Constraint validation (`@minLength`, `@pattern`, ...): JS-only, enforced at relay command
  ingress** — morally json-schema-at-the-API-edge.  Not at store-write time (too late: the event
  is already durable).  Constraints are write-time ingress policy, not read-time type invariants
  (other writers like populate.py bypass the relay; history doesn't re-validate).  Keeping them out
  of decode/IR means they never affect type identity/interning, and the `@pattern` cross-runtime
  regex-dialect problem disappears (JS is the only dialect).  TypeSpec's std constraint decorators +
  compiler accessor functions (`getMinLength` etc.) mean no new vocabulary is needed.
- **API design principle (Ryan):** emitters being easy to read and write outranks any shorthand
  inside the core.  When core ergonomics (e.g. TS parameter-property shorthand) conflict with clean
  names at emitter call sites (e.g. `solution.default` vs `solution.dflt`), the call site wins.
- **Skeletons:** each emitter ships its runtime skeleton as `assets/skeleton.{ts,py,go}` (in the
  package `files`) and prepends it by default; `$onEmit` resolves it via `import.meta.url`.  The
  `skeleton` option overrides with a project-root-relative path; there is no skeleton-less mode
  (generated code requires the skeleton).  The assets are the canonical copies of the runtime
  skeletons — edit them here.
- **Naming convention: `K` prefix (for Kurrent) on IR model nouns** — KType and subclasses, KStore,
  KStoreItem, KFramework, plus KTypeRegistry (which creates KTypes).  Machinery stays unprefixed
  (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the ktypes.ts header.

## Behavior notes / gaps

- All three emitters generate the structural *checkers* (`checkUserCommands` etc.) the relays
  use (ts checkers target node-hosted relays); semantic validation (`validateUserCommands` in
  model/reducers.ts) is hand-written and separate.
- The Go emitter names slice/record converters after their builtin item type by convention
  (`sliceOfString`); anonymous non-builtin converters get path-derived numbers.
- `$onValidate` (`engine/src/validate.ts`) runs `lowerProgram()` (store collisions, not-a-store,
  invalid template args, ...) plus a solver pass over every union, so "union without discriminator"
  is a targeted diagnostic rather than an emitter crash.  It skips validation when the program
  already has checker errors, and all engine diagnostics are severity error, so emit never runs on a
  broken model.  Editor support for the interface idiom is first-class: completion, go-to-def, and
  hover (with the doc comments) work inside template-arg model expressions, and `tsp format` is
  idempotent (rewrites quoted keys to backticked identifiers, explodes inline anonymous unions to
  multi-line).
- Scalars extending builtins lower to the plain builtin (use `alias` to name one).
- A *named* model used as a `Store` spec emits broken code (see BUGS.md); write store specs
  inline (`Store<{...}>`).
- An interface extending multiple `Store<...>` instantiations, or extending another store interface
  directly, is not handled (only the first direct `Store` instance is read).

## Proposed directions (discussed, but Ryan only skimmed — not settled)

- **Custom types (map to TypeSpec library packages).**
  The `.tsp` half declares `scalar duration extends string;` (schema stays declarative — the
  containment property is preserved); the JS half registers per-target codegen hooks with a
  registry the engine exports, at import time.  Lowering produces a `KCustom` IR node (interned by
  name) instead of flattening the scalar; emitters branch on it ahead of the builtin switch, with
  `(d, annos, visit)`-shaped hook signatures.  Missing-target coverage becomes a clean diagnostic,
  and hook interfaces are typed (they should live in the engine as an open record keyed by target
  name, to avoid custom-type→emitter dependency cycles).  Design the gentler on-ramp first: a
  table-driven scalar-encoding extension (name → annotation / decode-expression / check-expression
  per language, à la `@encode`) covers most realistic cases (duration, decimal-as-string, base64,
  uuid) with data instead of code — `Date` is the archetype and would itself fit the table.  Keep
  the full hook registry as the escape hatch behind it.
