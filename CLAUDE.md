# Kurrent PhaseLock — repo guide

PhaseLock is an event-sourcing sync engine: events live in KurrentDB,
TypeScript reducers derive state everywhere (browser, Node, Python, Go),
and live queries serve it. Positioning and concepts: README.md. Status
and planned work: ROADMAP.md. Pending renames and chores: FOLLOWUPS.md.

Two kinds of work happen here; orient first:

- **Building on PhaseLock** (examples, demo apps, anything app-shaped):
  follow the `phaselock` skill at `agents/skills/phaselock/SKILL.md` and
  its reference files. That skill is the product documentation for
  agents; it also ships to end users, so keep it repo-agnostic when
  editing it.
- **Changing PhaseLock itself** (`tools/` — the TypeSpec vocabulary,
  emitters, and runtime skeletons): read `tools/CLAUDE.md` for settled
  design decisions before touching anything there.

## Rename in progress (docs vs code)

README, ROADMAP, and the skill are written against the decided names.
The code has not been renamed yet. Mapping (docs name ← current code):

| Docs / skill say | Code currently says |
|------------------|---------------------|
| `Engine`, `<Name>Engine` | `Framework`, `<Name>Framework` |
| `Store` (interface), `InMemStore`, `IndexedDBStore`, `OverlayStore`, `ExternalStore` | `Storage`, `InMemStorage`, `IndexedDBStorage`, `OverlayStorage`, `ExternalStorage` |
| `Identified<T>` / `Committed<T>` | `Event<T>` / `RealEvent<T>` |
| `usePhaseLock` | `useFramework` |
| `useLocalQuery` | `useQuery` (the function-taking hook; todo-thin's keyof-based `useQuery` keeps its name) |
| `@kurrent/phaselock-typespec{,-ts,-py,-go}` | `@kurrent/typespec-engine{,-ts,-py,-go}` |
| `using PhaseLock;` | `using KurrentEngine;` |
| `kurrent.phaselock._quickjs` | `_quickjs` (in-tree C extension) |

When working in code, use the current names; do not partially rename.
The full rename is tracked in FOLLOWUPS.md.

## Repo layout

```
tools/            The product: TypeSpec vocabulary (engine/), emitters
                  (emitter-{ts,py,go}/ with runtime skeletons in assets/),
                  and their tests. See tools/CLAUDE.md and tools/README.md.
examples/
  todo-basic/     Smallest loop: browser engine + minimal TS relay server.
  todo-thin/      Same app, engine in the server, clients get query results.
  library/        Full architecture: Python relay, Go decider, forecasts,
                  per-audience stores. Root also has populate.py seed data.
agents/           The "phaselock" agent plugin; canonical skill at
                  agents/skills/phaselock/ (symlinked from .claude/skills/).
.claude-plugin/   marketplace.json cataloging the plugin.
```

The runtime skeletons (`tools/emitter-*/assets/skeleton.{ts,py,go}`) are
the canonical framework runtime — generated files embed a copy. Edit
skeletons in `tools/`, never in generated output.

## Build and check

Tools (`cd tools`):

- `pnpm install && pnpm -r build` — build vocabulary + emitters
- `pnpm test` — regenerate fixtures, run the vitest suite
- `pnpm --filter @kurrent/typespec-engine-tests test:py` / `test:go` —
  emitted-Python / emitted-Go checker suites

Todo examples (`cd examples/todo-basic` or `todo-thin`):

- `pnpm i` then `pnpm gen` — install, regenerate from the `.tsp` model
- `pnpm check` — tsc + eslint + prettier across model/server/ui
- `pnpm dev` — run the stack (docker KurrentDB + server + vite UI)

Library example (`cd examples/library`):

- `make gen` — regenerate all generated sources from library.tsp
- `make` / `make check` — build everything / typecheck + lint + format
- `cd model && pnpm test` — reducer tests (jest, via ReducerTester)
- `./devstack.mts` — run the stack (KurrentDB + decider + relay + UI)

After changing any `.tsp` model or any codegen in `tools/`, regenerate
and read the regenerated files rather than assuming their shape.

## Conventions

- Generated files (`*.gen.ts`, generated `model.py`, `model.go`,
  `ui/src/model.*`) are never hand-edited; change the `.tsp` or the
  emitter and regenerate.
- Demo code is meant to be read: high quality, simple, and it
  intentionally omits things (auth, users, subscription sharing).
  Don't "fix" an omission without asking; the omissions are the design.
- The generic query hooks (`useQuery.ts`; the function-taking variant
  becomes `useLocalQuery.ts`) are library-quality; `usePhaseLock.ts`
  (currently `useFramework.ts`) is app-specific by design — clarity over
  generality.
- Wrap new documentation files at 80 columns.
- If a result contradicts your model of the system, stop and ask rather
  than iterating on guesses; this codebase has few but sharp invariants,
  and the user usually spots the mismatch immediately.
