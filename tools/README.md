# TypeSpec model tooling

The model tooling for PhaseLock, built on [TypeSpec](https://typespec.io).  Demo data models
are written in TypeSpec against the `@kurrent/phaselock-typespec` vocabulary; emitters produce the
typed TypeScript, Python, and Go model code the demos build on.

## Layout

```
engine/       @kurrent/phaselock-typespec — the definition library apps import.
              lib/main.tsp declares the vocabulary (the Store and Engine interface
              templates); src/ holds everything shared by emitters:
                ktypes.ts  interned concrete-type IR
                solver.ts  union solver
                lower.ts   TypeSpec Program -> IR
                denter.ts  indent-aware printer
emitter-ts/   @kurrent/phaselock-typespec-ts — TypeScript emitter.
emitter-py/   @kurrent/phaselock-typespec-py — Python emitter.
emitter-go/   @kurrent/phaselock-typespec-go — Go emitter.
              Each emitter is a package exporting $onEmit; it calls lowerProgram() from the
              engine and walks the lowered IR.  Each ships its target-language runtime skeleton
              as assets/skeleton.{ts,py,go} (the canonical copy) and prepends it (override via
              the `skeleton` option).
tests/        Vitest suite for the tooling (see "Tests" below).
```

## Vocabulary mapping (from the retired Python DSL)

The tooling replaced an in-repo Python DSL (`protos.py`); for readers who knew it, the mapping:

| protos.py (retired)                    | TypeSpec                                        |
|----------------------------------------|-------------------------------------------------|
| `Struct(a=String, b=Maybe(Int))`       | `model X { a: string; b?: int32; }`             |
| `Literal("x")` / `Literal(True)`       | `"x"` / `true` literal types                    |
| `A \| B` (Union)                       | `union X { A, B }` or `A \| B` expressions      |
| `Alias(...)`                           | `alias X = ...;` (erased, same as Python)       |
| `Object(T)`                            | `Record<T>` (`model Setx is Record<true>;` to name one) |
| `Array(T)`                             | `T[]`                                           |
| `Date`                                 | `utcDateTime`                                   |
| `Store({"tpl": T}, dep1, dep2)`        | `interface S extends Store<{"tpl": T}, [dep1, dep2]> {}` |
| `F = Framework(events, cmds, store)`   | `interface F extends Engine<events, cmds, store> {}` |

Stores and engines are interfaces (not models) on purpose: interfaces are not data types, so
they cannot leak into the model space.  The Spec model's quoted property names carry the key
templates directly.  Someday the Commands argument may become optional, with commands declared
as ops in the engine interface body instead.

## Build and generate

```
cd tools
pnpm install
pnpm -r build       # tsc for engine + all three emitters
```

Demo data models live with the demos (`model/model.tsp`, `todo/model/model.tsp`); each demo's
model package depends on the engine and emitters via `link:` entries and declares its outputs in
`tspconfig.yaml`, so `pnpm exec tsp compile <model>.tsp` there emits under `tsp-output/@kurrent/`.
The demo makefiles drive this (build the tooling, compile the demo's model, copy outputs into
place) — `make model` from a demo directory is the normal entry point.

## Tests

```
pnpm test        # from tools: build all packages, regenerate fixtures, run the vitest suite
pnpm --filter @kurrent/phaselock-typespec-tests test:py   # emitted-Python checker suite (stdlib only)
pnpm --filter @kurrent/phaselock-typespec-tests test:go   # emitted-Go checker suite
```

The `tests/` package has two layers.

**Behavioral** — execute emitted code, one suite per runtime, tested independently (the runtimes
expose different surfaces: TS emits decoders, Python/Go emit checkers).  All three are driven from
one shared fixture, `tests/fixtures/main.tsp`, emitted into `tests/tsp-output/` by `pnpm gen`.

- `src/ts/decode.test.ts` — feeds plain JSON to the emitted `decodeX` functions and checks the
  typed result: identity/date/optional-date/nested/tuple decode, discriminated (`type`) and
  sub-discriminated (`[type, v]`) union dispatch, one-of, literal unions, throw paths.
- `py/test_checkers.py` — feeds native dicts/lists to the emitted `checkX` functions and inspects
  the returned problem list.  Stdlib only: tests self-register with `@register_test` and a
  `__main__` runner executes them (no pytest).  Installs a `_quickjs` stub before importing the
  generated `model.py` (the ext is only used by the Engine runtime, never the checkers).
  Run with `pnpm --filter @kurrent/phaselock-typespec-tests test:py` (or `python3 py/test_checkers.py`).
- `go/` — a self-contained Go module (goja + jscan) whose `model_test.go` parses JSON into a
  `goja.Value` and calls the emitted `CheckX(vm, value, path)`.  `test:go` copies the generated
  `model.go` into the package and runs `go test`.  (Go's timestamp check uses the strict
  `2006-01-02T15:04:05Z` layout — no fractional seconds — so its fixtures omit milliseconds.)

**Solver / lowering / interning unit tests** (`tests/src/`) — no runtime:

- `solver.test.ts` — builds interned KTypes directly and asserts the solution-tree shape
  `solveUnion()` produces for each strategy (json-type routing, literal buckets, `type`- and
  `[type, v]`-discriminated structs, one-of `HasField`, tuple length/index discrimination) plus
  the error paths (no discriminator, non-common discriminator, non-unique sole discriminator,
  two possibly-empty arrays, non-struct objects).
- `interning.test.ts` — `KTypeRegistry` identity: primitive singletons, literal-by-value,
  field-order-independent structs, optional-vs-required, collection interning, and union
  flatten/dedup/single-collapse/order-independence.
- `lowering.test.ts` — compiles small TypeSpec programs in-memory (via `@typespec/compiler`'s
  `createTester` with the engine library) and asserts `lowerProgram()` output: scalar/collection
  mapping, enum→literal-union, cross-program interning identity, store discovery (names, key
  templates, dependency inheritance), and engine discovery.

Note: `pnpm approve-builds` (accept `esbuild`) is needed once so vitest's transform can run.

## Known gaps / shortcuts

- The Go emitter names slice/record converters after their builtin item type (`sliceOfString`);
  anonymous non-builtin converters get path-derived numbers.
- The solver's array/tuple-union paths are unexercised by the demos.
- Scalars that extend builtins (`scalar Uuid extends string`) lower to the plain builtin rather
  than emitting a named alias; use `alias Uuid = string;` to name one.
