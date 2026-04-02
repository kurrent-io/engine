CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa

all: model relay decider ui

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

.PHONY: model/check
model/check: model
	cd model && tsc

.PHONY: relay
relay: relay/relay.js relay/model.py relay/_quickjs.so

relay/relay.js: model/library.gen.ts model/relay.ts
	cd model && pnpm rollup -m inline --exports named -p typescript relay.ts -o ../relay/relay.js

relay/model.py: model/library.py tools/gen_py.py
	python tools/protos.py -i tools -i model gen_py library > $@

relay/quickjs/.obj/%.pic.o:
	cd relay/quickjs && $(MAKE) .obj/$(notdir $@)

relay/_quickjs.so: relay/_quickjs.c $(foreach lib,$(QUICKJS_LIBS),relay/quickjs/.obj/$(lib).pic.o)
	$(CC) $(CFLAGS) -shared -o $@ $^ $(LDFLAGS)

.PHONY: relay/check
relay/check: relay
	cd relay && mypy .

.PHONY: decider
decider: decider/decider

decider/decider.js: model/library.gen.ts model/decider.ts
	cd model && pnpm rollup -m inline --format=cjs -p typescript decider.ts -o ../decider/decider.js

decider/model/model.go: model/library.py tools/gen_go.py
	mkdir -p decider/model
	python tools/protos.py -i tools -i model gen_go library -- model > $@

decider/decider: decider/decider.js decider/main.go decider/model/model.go
	cd decider && go build -o decider .

.PHONY: ui
ui: ui/src/model.js ui/src/model.d.ts

ui/src/model.js:
	cd model && pnpm rollup -m inline --format=esm -p typescript ui.ts -o ../$@

ui/src/model.d.ts: model/library.gen.ts model/ui.ts
	cd model && pnpm dts-bundle-generator ui.ts -o ../$@

.PHONY: ui/check
ui/check: ui
	cd ui && tsc

.PHONY: check
check: model/check relay/check ui/check

clean:
	@rm -f model/library.gen.ts \
		relay/relay.js relay/_quickjs.so \
		decider/decider decider/model/model.go \
		ui/src/model.js ui/src/model.d.ts
