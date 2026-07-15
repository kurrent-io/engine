# TypeSpec DSL exploration — status and design decisions

Context for resuming work on the TypeSpec-based replacement for the Python proto DSL
(`tools/protos.py` + `tools/gen_*.py`).  Last updated 2026-07-18.

## Status

A working first pass lives in this directory (see README.md for layout and build commands):
the `@kurrent/typespec-engine` definition library, all three emitters (`-ts`, `-py`, `-go`,
porting gen_ts.py / gen_py.py / gen_go.py), and a TypeSpec port of the library demo.  Each
emitter's output matches the Python tooling's: same line count, same top-level symbol set,
differences confined to one ordering/naming family (see README "Comparison status").  Run
`./compare.sh` to regenerate all three and diff against fresh Python output.  Semantic checks:
TS typechecks + passes reducer tests swapped into `model/`; Python `ast.parse`s; Go `gofmt -e`
parses (full `go build` not run — needs the module deps).  The Python tooling stays until
side-by-side comparison is complete.  `BUGS.md` at the repo root lists Python-tooling bugs
found during the port; the port replicates live-path bugs for parity (e.g. gen_py's framework
command-type-is-event-type) and carries unreachable-path bugs as-is.

## Design decisions

- **Declaration style: interface templates — IMPLEMENTED (2026-07-13).**
  `interface BookStore extends Store<{"edition.{isbn}": Edition}> {}` and
  `interface RelayFramework extends Framework<LibraryEvents, RelayCommands, RelayStore> {}`.
  The earlier decorator vocabulary (`@store`/`@template` on models, `@framework` on
  namespaces) is gone.  Quoted property names carry key templates directly, deps are a tuple
  template param (`Store<Spec, Deps = []>` — templates have no varargs), and interfaces don't
  pollute the data-type space.  Lowering discovers them via `sourceInterfaces` +
  `templateMapper.args` (unwrap `Indeterminate` entities — model expressions and tuple
  literals arrive as type-or-value).  Output is byte-identical to the decorator version.
- **Commands stay a union for now** (`Framework<Events, Commands, Store>`).  Someday: allow a
  null/omitted Commands argument, with commands declared as ops in the framework interface
  body instead — the endgame Ryan likes a lot, where the command union is *derived* from the
  interface:
  `interface UserFramework extends Framework<LibraryEvents, UserStore> { tryHold(cmd: TryHold): NewVHold | VHoldRejected; ... }`
  The op return type declares the command→event correlation that today lives only in decider
  code and forecasters.
- **`op` is reserved for that commands-as-operations future.**  Do not spend it as a generic
  `X = f(args)` binder for stores/frameworks (it works — `op X is store<...>` — but collides
  with the higher-value meaning).
- **Constraint validation (`@minLength`, `@pattern`, ...): JS-only, enforced at relay command
  ingress** — morally json-schema-at-the-API-edge.  Not at store-write time (too late: the
  event is already durable).  Constraints are write-time ingress policy, not read-time type
  invariants (other writers like populate.py bypass the relay; history doesn't re-validate).
  Keeping them out of decode/IR means they never affect type identity/interning.  The
  `@pattern` cross-runtime regex-dialect problem disappears (JS is the only dialect).
  TypeSpec's std constraint decorators + compiler accessor functions (`getMinLength` etc.)
  mean no new vocabulary is needed to adopt this.

- **API design principle (Ryan):** emitters being easy to read and write outranks any
  shorthand inside the core.  When core ergonomics (e.g. TS parameter-property shorthand)
  conflict with clean names at emitter call sites (e.g. `solution.default` vs `solution.dflt`),
  the call site wins.
- **Default skeleton (2026-07-18):** emitter-ts ships `assets/skeleton.ts` (in the package
  `files`) and prepends it by default; `$onEmit` resolves it via `import.meta.url`.  The
  `skeleton` option overrides with a project-root-relative path; there is no skeleton-less
  mode (generated code requires the skeleton).  `assets/skeleton.ts` is currently a copy of
  `tools/skeleton.ts` — Ryan syncs the two manually while the Python tooling coexists; at
  cutover the asset becomes canonical.
- **Naming convention: `K` prefix (for Kurrent) on IR model nouns** — KType and subclasses,
  KStore, KStoreItem, KFramework, plus KTypeRegistry (which creates KTypes).  Machinery stays
  unprefixed (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the
  ir.ts header.

## Proposed directions (discussed, but Ryan only skimmed — not settled)

- **Custom types (protos.py's `ts_generate_annotation`/`py_generate_checker`/`go_generate_type`
  etc. hooks — designed-in but currently unexercised): map to TypeSpec library packages.**
  The `.tsp` half declares `scalar duration extends string;` (schema stays declarative — the
  containment property is preserved); the JS half registers per-target codegen hooks with a
  registry the engine exports, at import time (same lifecycle protos.py gets from Python
  imports).  Lowering produces a `KCustom` IR node (interned by name) instead of flattening the
  scalar; emitters branch on it ahead of the builtin switch, same `(d, annos, visit)`-shaped
  hook signatures as Python.  Improvements over `hasattr` duck-typing: missing-target coverage
  becomes a clean diagnostic, and hook interfaces are typed (they should live in the engine as
  an open record keyed by target name, to avoid custom-type→emitter dependency cycles).
  Design the gentler on-ramp first: a table-driven scalar-encoding extension (name →
  annotation / decode-expression / check-expression per language, à la `@encode`) covers most
  realistic cases (duration, decimal-as-string, base64, uuid) with data instead of code —
  `Date` is the archetype and would itself fit the table.  Keep the full hook registry as the
  escape hatch behind it.

## Known gaps (first pass)

- ~~Only the TS emitter exists~~ — all three emitters ported (2026-07-18).  The py/go emitters
  also generate the structural *checkers* (`checkUserCommands` etc.) the relays use; semantic
  validation (`validateUserCommands` in model/reducers.ts) is hand-written and unaffected.
  Go-emitter-specific note: it names slice/record converters after builtin item types by
  convention (`sliceOfString`); the Python tooling derived that from the model module's
  `import` list — no TypeSpec analog, so anon numbering differs (documented in README).  The
  generated-file header reads `// Code generated by @kurrent/typespec-engine-go. DO NOT EDIT.`
  (names the real generator; one intended line of divergence from the Python `gen_go.py` header).
- ~~No `$onValidate`~~ — IMPLEMENTED (2026-07-15, `engine/src/validate.ts`): runs
  `lowerProgram()` (store collisions, not-a-store, invalid template args, ...) plus a solver
  pass over every union, so "union without discriminator" is a targeted diagnostic instead of
  an emitter crash.  Verified in the IDE via an LSP-driven test: key-template collisions now
  squiggle on the store interface name; checker errors inside specs land on exact token
  ranges.  It skips validation when the program already has checker errors (avoids cascade
  noise), and all our diagnostics are severity error, so emit never runs on a broken model
  (no double-reporting).  Tooling otherwise handles the interface idiom as first-class:
  completion, go-to-def, and hover (with our doc comments) all work inside template-arg model
  expressions; `tsp format` is idempotent on them, preserves comments, rewrites quoted keys to
  backticked identifiers (byte-identical output verified), and explodes inline anonymous
  unions to prettier-style multi-line.
- Scalars extending builtins lower to the plain builtin (use `alias` for Python-`Alias`
  parity).
- An interface extending multiple `Store<...>` instantiations, or extending another store
  interface directly, is not handled (only the first direct `Store` instance is read).
- Port-provenance comments were scrubbed from engine/src/ and emitter-ts/src/ (2026-07-15).
  The parity mapping lives here instead: ir.ts ≙ protos.py's Concrete layer + interning,
  solver.ts ≙ solve_union/remap_and_prune, denter.ts ≙ Denter, lower.ts ≙ _main()'s
  name-harvesting/resolve phases, emitter-ts ≙ gen_ts.py (byte-parity modulo union member
  order, which follows declaration order rather than frozenset order).  Keep this mapping
  current while side-by-side comparison against the Python tooling remains the correctness
  spec.
