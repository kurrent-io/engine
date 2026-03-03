CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa

all: python/relay.js python/library_gen.py python/_quickjs.so go/decider.js

model/library.gen.ts: model/library.py tools/protos.py tools/gen_ts.py tools/skeleton.ts
	python tools/protos.py -i tools -i model gen_ts library > $@

python/relay.js: model/library.gen.ts model/reducers.ts model/relay.ts
	cd model && pnpm rollup -m inline --exports named -p typescript relay.ts -o ../python/relay.js

python/library_gen.py: model/library.py tools/gen_py.py
	python tools/protos.py -i tools -i model gen_py library > $@

python/quickjs/.obj/%.pic.o:
	cd python/quickjs && $(MAKE) .obj/$(notdir $@)

python/_quickjs.so: python/_quickjs.c $(foreach lib,$(QUICKJS_LIBS),python/quickjs/.obj/$(lib).pic.o)
	$(CC) $(CFLAGS) -shared -o $@ $^ $(LDFLAGS)

go/decider.js: model/library.gen.ts model/reducers.ts model/decider.ts
	cd model && pnpm rollup -m inline --exports named -p typescript decider.ts -o ../go/decider.js

clean:
	@rm -f model/library.gen.ts python/relay.js python/_quickjs.so
