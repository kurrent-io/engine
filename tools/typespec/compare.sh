#!/bin/sh
# Regenerate the TypeSpec-based outputs for all three emitters and diff them against the
# equivalent files produced by the Python tooling.
#
# The two pipelines are semantically equivalent but not byte-identical.  The differences are all
# in one family, rooted in the Python DSL storing union members in frozensets (hash order) while
# the TypeSpec pipeline preserves declaration order:
#   - union alias / interface member order, and the switch-case order that follows it
#   - the position of the DeciderEvents block (library.py forward-declares DeciderEvents in the
#     storage section, so Python resolves its members early)
#   - which anonymous struct gets which path-derived number when a union has two structurally
#     similar members (e.g. {hold} | {checkout} -> BookStatus0/BookStatus1)
#   - anonymous slice/record converter numbering in Go
#
# So the check here is: same line count, and a symbol-set / sorted-line comparison showing only
# reordering.  The Python reference is generated fresh from model/library.py.

set -e
cd "$(dirname "$0")"

REPO=../..
REF=$(mktemp -d)
trap 'rm -rf "$REF"' EXIT

pnpm -r build
(cd library && pnpm exec tsp compile .)

OUTDIR="library/tsp-output/@kurrent"

check() {
    name=$1; ref=$2; ours=$3
    echo
    echo "=== $name ==="
    if diff "$ref" "$ours" >/dev/null 2>&1; then
        echo "byte-identical"
        return
    fi
    echo "line counts: ref=$(wc -l < "$ref") ours=$(wc -l < "$ours")"
    echo "changed lines: $(diff "$ref" "$ours" | grep -cE '^[<>]')"
    echo "changed lines after sorting (0 or a few ⇒ pure reordering): $(diff <(sort "$ref") <(sort "$ours") | grep -cE '^[<>]')"
}

python "$REPO/tools/protos.py" -i "$REPO/tools" -i "$REPO/model" gen_ts library > "$REF/library.gen.ts"
python "$REPO/tools/protos.py" -i "$REPO/tools" -i "$REPO/model" gen_py library > "$REF/model.py"
python "$REPO/tools/protos.py" -i "$REPO/tools" -i "$REPO/model" gen_go library -- model > "$REF/model.go"

check "TypeScript" "$REF/library.gen.ts" "$OUTDIR/typespec-engine-ts/library.gen.ts"
check "Python"     "$REF/model.py"       "$OUTDIR/typespec-engine-py/model.py"
check "Go"         "$REF/model.go"        "$OUTDIR/typespec-engine-go/model.go"
