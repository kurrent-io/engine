CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa

all: model relay decider ui

# all generated sources
.PHONY: gen
gen: model/library.gen.ts relay/relay.js relay/model.py decider/decider.js decider/model/model.go ui/src/model.js ui/src/model.d.ts

# The TypeSpec tooling (engine + emitters); one tsp compile of the library model emits
# all three generated files directly to their destinations (see model/tspconfig.yaml).
TSP_SRCS := $(wildcard tools/engine/src/*.ts tools/engine/lib/*.tsp \
	tools/emitter-ts/src/*.ts tools/emitter-ts/assets/* \
	tools/emitter-py/src/*.ts tools/emitter-py/assets/* \
	tools/emitter-go/src/*.ts tools/emitter-go/assets/*)

model/library.gen.ts relay/model.py decider/model/model.go &: model/library.tsp model/tspconfig.yaml $(TSP_SRCS)
	cd model && pnpm exec tsp compile library.tsp

.PHONY: model
model: model/library.gen.ts

.PHONY: model/check
model/check: model
	cd model && pnpm tsc

.PHONY: relay
relay: relay/relay.js relay/model.py relay/_quickjs.so

relay/relay.js: model/library.gen.ts model/relay.ts
	cd model && pnpm esbuild relay.ts --bundle --format=esm --sourcemap=inline --outfile=../$@

relay/quickjs:
	rm -rf quickjs~
	git clone https://github.com/bellard/quickjs $@~
	mv $@~ $@

relay/quickjs/.obj/%.pic.o: relay/quickjs
	cd relay/quickjs && $(MAKE) .obj/$(notdir $@)

relay/_quickjs.so: relay/_quickjs.c $(foreach lib,$(QUICKJS_LIBS),relay/quickjs/.obj/$(lib).pic.o)
	$(CC) $(CFLAGS) -shared -o $@ $^ $(LDFLAGS)

.PHONY: relay/check
relay/check: relay
	cd relay && mypy .

.PHONY: decider
decider: decider/decider

decider/decider.js: model/library.gen.ts model/decider.ts
	cd model && pnpm esbuild decider.ts --bundle --format=cjs --sourcemap=inline --outfile=../$@

decider/decider: decider/decider.js decider/main.go decider/model/model.go
	cd decider && go build -o decider .

.PHONY: ui
ui: ui/src/model.js ui/src/model.d.ts

ui/src/model.js: model/library.gen.ts model/ui.ts
	cd model && pnpm esbuild ui.ts --bundle --format=esm --sourcemap=inline --outfile=../$@

ui/src/model.d.ts: model/library.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: ui/check
ui/check: ui
	cd ui && pnpm tsc

# eslint needs the generated sources present (typed linting + import resolution)
.PHONY: lint
lint: model ui
	pnpm exec eslint .

.PHONY: fmt/check
fmt/check:
	pnpm exec prettier --check "**/*.{ts,tsx}"

.PHONY: fmt
fmt:
	pnpm exec prettier --write "**/*.{ts,tsx}"
	pnpm exec eslint --fix .

.PHONY: check
check: decider/decider model/check relay/_quickjs.so relay/check ui/check lint fmt/check

.PHONY: serve
serve: ui
	cd ui && pnpm serve

clean:
	@rm -f model/library.gen.ts \
		relay/relay.js relay/model.py relay/_quickjs.so \
		decider/decider decider/model/model.go \
		ui/src/model.js ui/src/model.d.ts
