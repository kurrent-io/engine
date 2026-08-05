CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa

all: model relay decider ui

# The TypeSpec tooling (engine + emitters); one tsp compile of the library model emits
# all three generated files directly to their destinations (see model/tspconfig.yaml).
TSP_SRCS := $(wildcard tools/engine/src/*.ts tools/engine/lib/*.tsp \
	tools/emitter-ts/src/*.ts tools/emitter-ts/assets/* \
	tools/emitter-py/src/*.ts tools/emitter-py/assets/* \
	tools/emitter-go/src/*.ts tools/emitter-go/assets/*)

.PHONY: typespec-tools
typespec-tools:
	@cd tools && pnpm -s i && pnpm -rs build

model/library.gen.ts relay/model.py decider/model/model.go &: model/library.tsp model/tspconfig.yaml model/node_modules $(TSP_SRCS) | typespec-tools
	cd model && pnpm exec tsp compile library.tsp

.PHONY: model
model: model/library.gen.ts model/node_modules

model/node_modules:
	cd model && pnpm i

.PHONY: model/check
model/check: model
	cd model && pnpm tsc

.PHONY: relay
relay: relay/relay.js relay/model.py relay/_quickjs.so

relay/relay.js: model/node_modules model/library.gen.ts model/relay.ts
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

decider/decider.js: model/node_modules model/library.gen.ts model/decider.ts
	cd model && pnpm esbuild decider.ts --bundle --format=cjs --sourcemap=inline --outfile=../$@

decider/decider: decider/decider.js decider/main.go decider/model/model.go
	cd decider && go build -o decider .

.PHONY: ui
ui: ui/node_modules ui/src/model.js ui/src/model.d.ts

ui/node_modules:
	cd ui && pnpm i

ui/src/model.js:  model/node_modules model/library.gen.ts model/ui.ts
	cd model && pnpm esbuild decider.ts --bundle --format=esm --sourcemap=inline --outfile=../$@

ui/src/model.d.ts: model/node_modules model/library.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: ui/check
ui/check: ui
	cd ui && pnpm tsc

.PHONY: check
check: decider/decider model/check relay/_quickjs.so relay/check ui/check

.PHONY: serve
serve: ui
	cd ui && pnpm serve

clean:
	@rm -f model/library.gen.ts \
		relay/relay.js relay/model.py relay/_quickjs.so \
		decider/decider decider/model/model.go \
		ui/src/model.js ui/src/model.d.ts
