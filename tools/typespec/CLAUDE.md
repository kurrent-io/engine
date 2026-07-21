# TypeSpec DSL exploration — status and design decisions

Context for resuming work on the TypeSpec-based replacement for the Python proto DSL
(`tools/protos.py` + `tools/gen_*.py`).

## Status

A working first pass lives in this directory (see README.md for layout and build commands): the
`@kurrent/typespec-engine` definition library, all three emitters (`-ts`, `-py`, `-go`), and a
TypeSpec port of the library demo.  Each emitter's output matches the Python tooling's — same line
count and top-level symbol set, differences confined to one ordering/naming family (see README
"Comparison status").  `./compare.sh` regenerates all three and diffs against fresh Python output.

The Python tooling stays until side-by-side comparison is complete; both pipelines are kept
byte-for-byte in agreement, so any change to a generator is made in both.  Semantic checks: TS
typechecks and passes the reducer tests swapped into `model/`; Python `ast.parse`s; the generated
Go compiles (`make decider` builds the library's `model.go`).  The behavioral test suites
(`tests/`) execute emitted code in all three runtimes.

## Design decisions

- **Declaration style: interface templates.**
  `interface BookStore extends Store<{"edition.{isbn}": Edition}> {}` and
  `interface RelayFramework extends Framework<LibraryEvents, RelayCommands, RelayStore> {}`.
  Quoted property names carry key templates directly, deps are a tuple template param
  (`Store<Spec, Deps = []>` — templates have no varargs), and interfaces don't pollute the
  data-type space.  Lowering discovers them via `sourceInterfaces` + `templateMapper.args`
  (unwrapping `Indeterminate` entities — model expressions and tuple literals arrive as
  type-or-value).
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
- **Default skeleton:** each emitter ships its runtime skeleton as `assets/skeleton.{ts,py,go}`
  (in the package `files`) and prepends it by default; `$onEmit` resolves it via `import.meta.url`.
  The `skeleton` option overrides with a project-root-relative path; there is no skeleton-less mode
  (generated code requires the skeleton).  Each `assets/skeleton.*` is a copy of the corresponding
  `tools/skeleton.*` — synced manually while the Python tooling coexists; at cutover the asset
  becomes canonical.
- **Naming convention: `K` prefix (for Kurrent) on IR model nouns** — KType and subclasses, KStore,
  KStoreItem, KFramework, plus KTypeRegistry (which creates KTypes).  Machinery stays unprefixed
  (Denter, the solver's Match/Check* classes, LoweredProgram).  Documented in the ktypes.ts header.

## Test suite

`tests/` package.  `pnpm test` (from `tools/typespec`) builds everything, regenerates the fixture,
and runs the vitest suites; `pnpm --filter @kurrent/typespec-engine-tests test:py` / `test:go` run
the Python and Go suites.

Two layers:

- **Behavioral — execute emitted code, one suite per runtime, tested independently** (not a shared
  cross-runtime fixture table: the runtimes expose different surfaces — TS emits **decoders**
  `DecodeX`, Py/Go emit **checkers** `checkX`/`CheckX`).  All three are driven from one shared
  fixture, `tests/fixtures/main.tsp`, emitted into `tests/tsp-output/` (gitignored) by `pnpm gen`;
  it covers identity/date/optional-date/nested/array/tuple/record shapes, discriminated (`type`)
  and sub-discriminated (`[type, v]`) unions, one-of (`HasField`), string/int literal unions, and a
  Store + Framework.  The store spec is inline (`Store<{...}>`) — a named spec model emits broken
  code (see BUGS.md).
  - `tests/src/ts/decode.test.ts` (vitest) — feeds plain JSON to `DecodeX`, checks the typed result
    (dates → Date, union variant selection, nesting, throw paths).
  - `tests/py/test_checkers.py` — stdlib only (`@register_test` + a `__main__` runner, no pytest).
    Feeds native dicts/lists to `checkX` and inspects the problem list.  Installs a PEP-562
    `_quickjs` stub in `sys.modules` before importing the generated `model.py` (that ext is used
    only by the Framework runtime, never the checkers).
  - `tests/go/` — a self-contained module (goja + jscan pinned to the decider's versions); standard
    `go test`.  `test:go` copies the emitted `model.go` in, parses JSON to a `goja.Value` (`vm.Set`
    + `JSON.parse`), and calls `CheckX(vm, value, path)`.  Go's timestamp check uses the strict
    `2006-01-02T15:04:05Z` layout (no fractional seconds), unlike Python which accepts both.
- **Solver / lowering / interning unit tests** (`tests/src/`, vitest, no runtime).  `solver.test.ts`
  asserts solution-tree shape per strategy plus error paths; `interning.test.ts` asserts
  `KTypeRegistry` identity semantics; `lowering.test.ts` compiles TypeSpec in-memory via
  `@typespec/compiler`'s `createTester` (base = tests package root, `libraries:
  ["@kurrent/typespec-engine"]`, `.import().using()`) and asserts `lowerProgram()` output (mapping,
  interning identity, store/framework discovery).  Vitest needs a one-time `pnpm approve-builds`
  (esbuild); tests import the engine's built `dist`, so the root `test` script builds it first.

## Proposed directions (discussed, but Ryan only skimmed — not settled)

- **Custom types (protos.py's `ts_generate_annotation`/`py_generate_checker`/`go_generate_type`
  etc. hooks — designed-in but currently unexercised): map to TypeSpec library packages.**
  The `.tsp` half declares `scalar duration extends string;` (schema stays declarative — the
  containment property is preserved); the JS half registers per-target codegen hooks with a
  registry the engine exports, at import time (same lifecycle protos.py gets from Python imports).
  Lowering produces a `KCustom` IR node (interned by name) instead of flattening the scalar;
  emitters branch on it ahead of the builtin switch, same `(d, annos, visit)`-shaped hook signatures
  as Python.  Improvements over `hasattr` duck-typing: missing-target coverage becomes a clean
  diagnostic, and hook interfaces are typed (they should live in the engine as an open record keyed
  by target name, to avoid custom-type→emitter dependency cycles).  Design the gentler on-ramp
  first: a table-driven scalar-encoding extension (name → annotation / decode-expression /
  check-expression per language, à la `@encode`) covers most realistic cases (duration,
  decimal-as-string, base64, uuid) with data instead of code — `Date` is the archetype and would
  itself fit the table.  Keep the full hook registry as the escape hatch behind it.

## Current behavior notes / gaps

- The py/go emitters also generate the structural *checkers* (`checkUserCommands` etc.) the relays
  use; semantic validation (`validateUserCommands` in model/reducers.ts) is hand-written and
  separate.  The Go emitter names slice/record converters after their builtin item type by
  convention (`sliceOfString`); the Python tooling derived that name from the model module's
  `import` list — no TypeSpec analog, so anonymous numbering differs (see README).  The Go
  generated-file header reads `// Code generated by @kurrent/typespec-engine-go. DO NOT EDIT.`
  (one intended line of divergence from the Python `gen_go.py` header).
- `$onValidate` (`engine/src/validate.ts`) runs `lowerProgram()` (store collisions, not-a-store,
  invalid template args, ...) plus a solver pass over every union, so "union without discriminator"
  is a targeted diagnostic rather than an emitter crash.  It skips validation when the program
  already has checker errors, and all engine diagnostics are severity error, so emit never runs on a
  broken model.  Editor support for the interface idiom is first-class: completion, go-to-def, and
  hover (with the doc comments) work inside template-arg model expressions, and `tsp format` is
  idempotent (rewrites quoted keys to backticked identifiers, explodes inline anonymous unions to
  multi-line).
- Scalars extending builtins lower to the plain builtin (use `alias` for Python-`Alias` parity).
- An interface extending multiple `Store<...>` instantiations, or extending another store interface
  directly, is not handled (only the first direct `Store` instance is read).
- Parity mapping (kept here rather than in code comments): ktypes.ts ≙ protos.py's Concrete layer +
  interning, solver.ts ≙ solve_union/remap_and_prune, denter.ts ≙ Denter, lower.ts ≙ _main()'s
  name-harvesting/resolve phases, emitter-ts ≙ gen_ts.py (byte-parity modulo union member order,
  which follows declaration order rather than frozenset order).  Keep this current while
  side-by-side comparison against the Python tooling remains the correctness spec.
