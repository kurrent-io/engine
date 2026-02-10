CC=gcc
CFLAGS=-fPIC -Werror -Wall -Wextra -Wswitch-enum -Wstrict-overflow -Wconversion -Wstrict-prototypes \
	-Wmissing-prototypes -Wno-missing-field-initializers -Wvla -fdiagnostics-color=always \
	-Wno-strict-aliasing -I$(shell dirname /usr/include/*/Python.h) -Wno-deprecated-declarations
LDFLAGS=-lpython3

QUICKJS_LIBS=quickjs quickjs-libc libregexp libunicode cutils dtoa


# all: _quickjs.so
#
# _quickjs.o: _quickjs.c
#
# _quickjs.a: _quickjs.o quickjs/.obj/quickjs.pic.o
# 	ar rcs $@ $^
#
# _quickjs.so: _quickjs.a
# 	$(CC) -shared -o $@ -Wl,--whole-archive $^ -Wl,--no-whole-archive $(LDFLAGS)
#
# clean:
# 	rm _quickjs.{a,o,so}

all: _quickjs.so

# _quickjs.o: _quickjs.c

quickjs/.obj/%.pic.o:
	cd quickjs && $(MAKE) .obj/$(notdir $@)

_quickjs.so: _quickjs.c $(foreach lib,$(QUICKJS_LIBS),quickjs/.obj/$(lib).pic.o)
	$(CC) $(CFLAGS) -shared -o $@ $^ $(LDFLAGS)

clean:
	rm -f _quickjs.{a,o,so}
