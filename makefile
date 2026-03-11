CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa

all: model python go ui

tools/gen_ts.py: tools/protos.py tools/skeleton.ts
	@touch $@

tools/gen_py.py: tools/protos.py tools/skeleton.py
	@touch $@

tools/gen_go.py: tools/protos.py tools/skeleton.go
	@touch $@

.PHONY: model
model: model/library.gen.ts

model/library.gen.ts: model/library.py tools/gen_ts.py model/reducers.ts model/tsconfig.json
	python tools/protos.py -i tools -i model gen_ts library > $@

.PHONY: python
python: python/relay.js python/library_gen.py python/_quickjs.so

python/relay.js: model/library.gen.ts model/relay.ts
	cd model && pnpm rollup -m inline --exports named -p typescript relay.ts -o ../python/relay.js

python/library_gen.py: model/library.py tools/gen_py.py
	python tools/protos.py -i tools -i model gen_py library > $@

python/quickjs/.obj/%.pic.o:
	cd python/quickjs && $(MAKE) .obj/$(notdir $@)

python/_quickjs.so: python/_quickjs.c $(foreach lib,$(QUICKJS_LIBS),python/quickjs/.obj/$(lib).pic.o)
	$(CC) $(CFLAGS) -shared -o $@ $^ $(LDFLAGS)

.PHONY: go
go: go/decider

go/decider.js: model/library.gen.ts model/decider.ts
	cd model && pnpm rollup -m inline --format=cjs -p typescript decider.ts -o ../go/decider.js

go/model/model.go: model/library.py tools/gen_go.py
	mkdir -p go/model
	python tools/protos.py -i tools -i model gen_go library -- model > $@

go/decider: go/decider.js go/main.go go/model/model.go
	cd go && go build -o decider .

.PHONY: ui
ui: ui/src/model.js ui/src/model.d.ts

ui/src/model.js:
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

ui/src/model.d.ts: model/library.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: ui/tsc
ui/tsc: ui
	cd ui && tsc

clean:
	@rm -f model/library.gen.ts python/relay.js python/_quickjs.so
