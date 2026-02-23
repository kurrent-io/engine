package main

/*
#cgo CFLAGS: -I quickjs
#cgo LDFLAGS: -L quickjs -lquickjs -lm

#include <stdio.h>
#include <quickjs.h>

JSValue js_eval(JSContext *ctx, void *input, size_t len) {
	return JS_Eval(ctx, input, len, "script", JS_EVAL_FLAG_STRICT);
}

static void js_print_value_write(void *opaque, const char *buf, size_t len)
{
    FILE *fo = opaque;
    fwrite(buf, 1, len, fo);
}

static JSValue js_console_log(
	JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv
) {
    int i;
    JSValueConst v;

    for(i = 0; i < argc; i++) {
        if (i != 0)
            putchar(' ');
        v = argv[i];
        if (JS_IsString(v)) {
            const char *str;
            size_t len;
            str = JS_ToCStringLen(ctx, &len, v);
            if (!str)
                return JS_EXCEPTION;
            fwrite(str, 1, len, stdout);
            JS_FreeCString(ctx, str);
        } else {
            JS_PrintValue(ctx, js_print_value_write, stdout, v, NULL);
        }
    }
    putchar('\n');
    return JS_UNDEFINED;
}

extern void putNull();
extern void putUndefined();
extern void putBoolean(int);
extern void putInt(int32_t);
extern void putBigInt(int64_t);
extern void putFloat(double);
extern void putString(uintptr_t, size_t);
extern void openArray(int64_t);
extern void putItem(int64_t);
extern void putArray(int64_t);
extern void openObject(int64_t);
extern void putKey(uintptr_t, size_t);
extern void putObject(int64_t);

#define DEF_PUT(name) \
	JSValue c_##name(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
DEF_PUT(putNull) {
	putNull();
	return JS_UNDEFINED;
}
DEF_PUT(putUndefined) {
	putUndefined();
	return JS_UNDEFINED;
}
DEF_PUT(putBoolean) {
	putBoolean(JS_ToBool(ctx, *argv));
	return JS_UNDEFINED;
}
DEF_PUT(putNumber) {
	int tag = JS_VALUE_GET_TAG(*argv);
	if(tag == JS_TAG_INT) {
		int32_t i;
		JS_ToInt32(ctx, &i, *argv);
		putInt(i);
	} else {
		double f;
		JS_ToFloat64(ctx, &f, *argv);
		putFloat(f);
	}
	return JS_UNDEFINED;
}
DEF_PUT(putBigInt) {
	int64_t bi;
	JS_ToBigInt64(ctx, &bi, *argv);
	putBigInt(bi);
	return JS_UNDEFINED;
}
DEF_PUT(putString) {
	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
	putString((uintptr_t)s, len);
	return JS_UNDEFINED;
}

DEF_PUT(openArray) {
	int64_t len;
	JS_ToInt64Ext(ctx, &len, *argv);
	openArray(len);
	return JS_UNDEFINED;
}
DEF_PUT(putItem) {
	int64_t len;
	JS_ToInt64Ext(ctx, &len, *argv);
	putItem(len);
	return JS_UNDEFINED;
}
DEF_PUT(putArray) {
	int64_t len;
	JS_ToInt64Ext(ctx, &len, *argv);
	putArray(len);
	return JS_UNDEFINED;
}

DEF_PUT(openObject) {
	int64_t len;
	JS_ToInt64Ext(ctx, &len, *argv);
	openObject(len);
	return JS_UNDEFINED;
}
DEF_PUT(putKey) {
	size_t len;
	const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
	putKey((uintptr_t)s, len);
	return JS_UNDEFINED;
}
DEF_PUT(putObject) {
	int64_t len;
	JS_ToInt64Ext(ctx, &len, *argv);
	putObject(len);
	return JS_UNDEFINED;
}

void prep_ctx(JSContext *ctx) {

    JSValue global_obj, console, glue;
    int i;

    global_obj = JS_GetGlobalObject(ctx);

    console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, js_console_log, "log", 1));
    JS_SetPropertyStr(ctx, global_obj, "console", console);

    glue = JS_NewObject(ctx);

    #define USE_PUT(name) \
        JS_SetPropertyStr(ctx, glue, #name, JS_NewCFunction(ctx, c_##name, #name, 1));
    USE_PUT(putNull);
    USE_PUT(putUndefined);
    USE_PUT(putBoolean);
    USE_PUT(putNumber);
    USE_PUT(putBigInt);
    USE_PUT(putString);
    USE_PUT(openArray);
    USE_PUT(putItem);
    USE_PUT(putArray);
    USE_PUT(openObject);
    USE_PUT(putKey);
    USE_PUT(putObject);

    JS_SetPropertyStr(ctx, global_obj, "glue", glue);

    JS_FreeValue(ctx, global_obj);
}

*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/dop251/goja"
)

// func consoleLog(this goja.Value, args... goja.Value) goja.Value {
// 	var out []string
// 	for _, arg := range args {
// 		out = append(out, arg.String())
// 	}
// 	println(strings.Join(out, " "))
// 	return this
// }

func consoleLog(call goja.FunctionCall) goja.Value {
	var out []string
	for _, arg := range call.Arguments {
		out = append(out, arg.String())
	}
	println(strings.Join(out, " "))
	return nil
}

func run(file string) error {
	text, err := os.ReadFile(file)
	if err != nil { return err }

	// vm := goja.New()

	// console := vm.NewObject()
	// console.Set("log", consoleLog)
	// vm.GlobalObject().Set("console", console)

	// _, err = vm.RunString("console.log('hello')")
	// if err != nil { return err }

	// val, err := vm.RunString(string(text))
	// if err != nil { return err }

	// _, err = vm.RunString("console.log('yo');")
	// if err != nil { return err }

	// fmt.Printf("val = %v (%T)\n", val, val)

	return runquickjs(text)
}

func runquickjs(text []byte) error {
	rt := C.JS_NewRuntime();
	if rt == nil {
		return errors.New("failed to create runtime");
	}
	defer C.JS_FreeRuntime(rt)

	js := C.JS_NewContext(rt)
	if rt == nil {
		return errors.New("failed to create context");
	}
	defer C.JS_FreeContext(js)

	C.prep_ctx(js)

	text = append(text, 0)
	val := C.js_eval(js, C.CBytes(text), C.size_t(len(text) - 1))
	defer C.JS_FreeValue(js, val)

	fmt.Printf("quickjsval = %v (%T)\n", val, val)
	switch true {
	case C.JS_IsString(val) != 0: println("string")
	case C.JS_IsObject(val) != 0: println("object")
	}

	// expect stack to be populated
	fmt.Printf("stack is: %v\n", stack)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: %v FILE.JS\n", os.Args[0])
		os.Exit(1)
	}
	err := run(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

// what if we tried to do something akin to the Protocols structural sub-typing we can do in python?

type BookStatus interface {
	IsBookStatus()
}

type BookStatusString string;
func (*BookStatusString) IsBookStatus() {}

type BookStatusHold interface {
	BookStatus
	Hold(): string
}

type BookStatusCheckout interface {
	BookStatus
	Checkout(): string
}

type Book interface {
	Id() string
	Isbn() string
	Restricted() bool
	Status:   // nil | {hold: string} | {checkout: string}
}


// well eventually we still need a concrete type, so not sure the interface is useful at all
type BookStatusCheckoutImpl struct {
	value goja.Value
}

func (x *BookStatusCheckoutImpl) IsBookStatus() {}
func (x *BookStatusCheckoutImpl) Checkout() string { return x.value.Get("checkout") }

// I guess we'd just need to bite the bullet and walk the whole data almost no matter what.  At best
// we could do it lazily.


///////////////////

// what about the query graph?  Is there a good way to run that too?  Hm, well user code could run
// in a goroutine perhaps.  Go iterators aren't very sophisticated or easy to write.

func getPatrons(qx QX) map[string]Patron {
	out := map[string]Patron{}
	for patron_uuid := range qx.Patrons() {
		out[patron_uuid] = qx.Patron()
	}
	return out
}

// a storage type looks like this:

type Patron struct {
	val goja.Value
}

func (x *Patron) Id() string {
	return val.ToObject().Get("id").Export().(string)
}

func (x *Patron) Name() string {
	return val.ToObject().Get("name").Export().(string)
}

func (x *Patron) Researcher() string {
	return val.ToObject().Get("researcher").Export().(bool)
}

func (x *Patron) Name() string {
	return val.ToObject().Get("name").Export().(string)
}

func (x *Patron) Checkouts() map[string]bool {
	return newSet(val.ToObject().Get("checkouts"))
}

func (x *Patron) Holds() map[string]bool {
	return newSet(val.ToObject().Get("holds"))
}

// the query context looks like this:

type QX struct {
	question <-chan map[string]map[string]bool
	// answer is closed if the goroutines should shut down
	answer chan<- map[string]map[string]goja.Value
}

func (qx *QX) get(key string) goja.Value {
	select {
	case question<-map[string]map[string]bool{"store": map[string]bool{key: true}}:
	case <-qx.answer:
		runtime.Goexit()
	}
	ans, ok := <-qx.answer:
	if !ok {
		runtime.Goexit()
	}
	return ans["store"][key]
}

func (qx *QX) Patrons() map[string]bool {
	return newSet(qx.get("patrons"))
}

// query function looks like

func (qx *QX) Patron(patron_uuid: string) Patron {
	return newPatron(qx.get(fmt.Sprintf("patron.%v", patron_uuid)))
}
