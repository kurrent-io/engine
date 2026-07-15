# TypeSpec-based model tooling (experimental)

An experimental replacement for the Python proto DSL (`tools/protos.py` + `tools/gen_*.py`) built
on [TypeSpec](https://typespec.io).  The existing Python tooling is untouched; this lives alongside
it for side-by-side comparison testing.

## Layout

```
engine/       @kurrent/typespec-engine — the definition library apps import.
              lib/main.tsp declares the vocabulary (the Store and Framework interface
              templates); src/ holds everything shared by emitters:
                ir.ts      interned concrete-type IR (port of protos.py's Concrete layer)
                solver.ts  union solver (port of solve_union / remap_and_prune)
                lower.ts   TypeSpec Program -> IR (replaces protos.py's name harvesting/resolve)
                denter.ts  indent-aware printer (port of Denter)
emitter-ts/   @kurrent/typespec-engine-ts — TypeScript emitter (port of gen_ts.py).
emitter-py/   @kurrent/typespec-engine-py — Python emitter (port of gen_py.py).
emitter-go/   @kurrent/typespec-engine-go — Go emitter (port of gen_go.py).
              Each emitter is a package exporting $onEmit; it calls lowerProgram() from the
              engine and walks the lowered IR.  Each ships its target-language runtime skeleton
              as assets/skeleton.{ts,py,go} and prepends it (override via the `skeleton` option).
library/      TypeSpec port of the library demo (main.tsp mirrors model/library.py).
compare.sh    Regenerate all three outputs and diff against the Python tooling's output.
```

## Vocabulary mapping

| protos.py                              | TypeSpec                                        |
|----------------------------------------|-------------------------------------------------|
| `Struct(a=String, b=Maybe(Int))`       | `model X { a: string; b?: int32; }`             |
| `Literal("x")` / `Literal(True)`       | `"x"` / `true` literal types                    |
| `A \| B` (Union)                       | `union X { A, B }` or `A \| B` expressions      |
| `Alias(...)`                           | `alias X = ...;` (erased, same as Python)       |
| `Object(T)`                            | `Record<T>` (`model Setx is Record<true>;` to name one) |
| `Array(T)`                             | `T[]`                                           |
| `Date`                                 | `utcDateTime`                                   |
| `Store({"tpl": T}, dep1, dep2)`        | `interface S extends Store<{"tpl": T}, [dep1, dep2]> {}` |
| `F = Framework(events, cmds, store)`   | `interface F extends Framework<events, cmds, store> {}` |

Stores and frameworks are interfaces (not models) on purpose: interfaces are not data types, so
they cannot leak into the model space.  The Spec model's quoted property names carry the key
templates directly.  Someday the Commands argument may become optional, with commands declared
as ops in the framework interface body instead.

## Build and generate

```
cd tools/typespec
pnpm install
pnpm -r build                          # tsc for engine + all three emitters
cd library && pnpm exec tsp compile .  # runs all three emitters (see tspconfig.yaml)
# outputs under library/tsp-output/@kurrent/{typespec-engine-ts,-py,-go}/
```

or just `./compare.sh`, which builds, emits all three, generates the Python tooling's output
fresh from `model/library.py`, and reports the difference for each.

## Comparison status

All three outputs have the same line count as the Python tooling's, define the same set of
top-level symbols, and (Python/Go) pass a structural parse.  The differences are all one family,
rooted in the Python DSL storing union members in frozensets (hash order) where the TypeSpec
pipeline preserves declaration order:

- union member order, and the switch-case order that follows from it;
- the position of the `DeciderEvents` block (library.py forward-declares it in the storage
  section, so Python resolves its members early);
- which anonymous struct gets which path-derived number when a union has two structurally
  similar members (`{hold} | {checkout}` -> `BookStatus0`/`BookStatus1` bind to opposite
  structs between the two pipelines);
- anonymous slice/record converter numbering in Go.

Measured by `compare.sh` as "changed lines after sorting" — a few lines each (the anon-struct
swaps), confirming the rest is pure reordering.

Semantic checks:

- TypeScript: swap the emitted file into `model/library.gen.ts`, then
  `cd model && pnpm exec tsc --noEmit -p . && pnpm exec jest` (both pass).
- Python: `python -c "import ast; ast.parse(open(...).read())"` parses.
- Go: `gofmt -e` parses.  (A full `go build` needs the module's goja/jscan deps and was not
  run here.)

## Known gaps / first-pass shortcuts

- The Go emitter names slice/record converters after a builtin item type by convention
  (`sliceOfString`), where the Python tooling derives that name from whichever builtins the
  model's Python module happened to `import` — an implementation detail with no TypeSpec analog.
  Output is valid and internally consistent either way; this is one source of the anon-numbering
  differences above.
- The solver's array/tuple-union paths are ported but unexercised by the demos (they were
  actually unreachable in Python: `solve_union_arrays` calls a nonexistent `Union.of` and drops
  one `remap_and_prune` result — both fixed in the port).
- Scalars that extend builtins (`scalar Uuid extends string`) lower to the plain builtin rather
  than emitting a named alias; use `alias Uuid = string;` for Python-`Alias` parity.
