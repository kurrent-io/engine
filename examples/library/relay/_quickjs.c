#ifdef __GNUC__
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Warray-bounds"
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif // __GNUC__

#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <datetime.h>

#include "quickjs/quickjs.h"

#ifdef __GNUC__
#pragma GCC diagnostic pop
#endif // __GNUC__

#include <stdio.h>
#include <stddef.h>

// js_pyweakref is our tiny javascript class that holds a python weakref for caching js2py()
static JSClassID js_pyweakref_class_id;

// js_pyref is an opaque wrapper around an arbitrary python object
static JSClassID js_pyref_class_id;

static PyObject *quickjs_error;

static JSValue new_pyref(JSContext *ctx, PyObject *val);
static JSValue py2js(JSContext *ctx, PyObject *val);

static JSValue js_console_log(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv
);

static void js_pyobj(JSRuntime *rt, JSValue val)
{
    (void)rt;
    PyObject *obj = JS_GetOpaque(val, js_pyweakref_class_id);
    Py_XDECREF(obj);
}

static JSClassDef js_pyweakref_class = {
    "PyWeakRef",
    .finalizer = js_pyobj,
};

static JSClassDef js_pyref_class = {
    "PyRef",
    .finalizer = js_pyobj,
};

// a wrapper around the JSContext
typedef struct {
    PyObject_HEAD;
    JSRuntime *rt;
    JSContext *ctx;
    // for embedding weak refs
    JSAtom weakref_symbol;
    // js function for extracting a js stack
    JSValue add_source_map;
    JSValue show_stack;
    JSClassID date_class_id;
} py_quickjs_t;

// a wrapper around a JSValue
typedef struct {
    PyObject_HEAD;
    JSContext *ctx;
    JSValue jsval;
    PyObject *weakreflist;
    PyObject *cache;
    PyObject *this;  // for functions
    Py_ssize_t objlen;
    Py_ssize_t arrlen;  // -1 if not an array
} py_value_t;

// a marker to tell py2js to create a pyref instead
typedef struct {
    PyObject_HEAD;
    PyObject *ref;
} py_opaque_t;

// a wrapper around allocated C memory implementing python buffer api
typedef struct {
    PyObject_HEAD;
    char *mem;
    Py_ssize_t len; // reusued as shape[0]
    Py_ssize_t stride; // always 1
    Py_ssize_t suboffset; // always -1
} py_cmem_t;

// c-only allocator for new _quickjs.Value objects
static PyObject *py_value_new(JSContext *ctx, JSValue jsval, PyObject *this);

static PyTypeObject py_quickjs_type;
static PyTypeObject py_value_type;
static PyTypeObject py_opaque_type;
static PyTypeObject py_cmem_type;

// weakref to copy.copy
static PyObject *copy_copy_weakref;

static PyObject *copy_copy(PyObject *obj) {
    PyObject *copy_func = PyWeakref_GetObject(copy_copy_weakref);
    return PyObject_CallOneArg(copy_func, obj);
}

// weakref to uuid.uuid4
static PyObject *uuid_uuid4_weakref;

static PyObject *uuid_uuid4() {
    PyObject *uuid4_func = PyWeakref_GetObject(uuid_uuid4_weakref);
    return PyObject_CallNoArgs(uuid4_func);
}

// sets a python exception and returns NULL
static PyObject *js_exception(JSContext *ctx) {
    PyObject *pywrapper = NULL;
    PyObject *pyexc = NULL;
    JSValue jsvalue = JS_UNINITIALIZED;
    JSValue exc = JS_GetException(ctx);

    // represent the javascript stacktrace as a quickjs_error
    pywrapper = py_value_new(ctx, exc, Py_None);
    if(!pywrapper) goto done;
    pyexc = PyObject_CallOneArg(quickjs_error, pywrapper);
    if(!pyexc) goto done;

    // check if the javascript error is wrapping a python error
    PyObject *pyvalue;
    if(
        JS_IsError(ctx, exc)
        && !JS_IsUndefined((jsvalue = JS_GetPropertyStr(ctx, exc, "pyvalue")))
        && (pyvalue = JS_GetOpaque(jsvalue, js_pyref_class_id))
    ){
        // load wrapped python exception
        // note: we don't presently have a need for the type or traceback
        Py_INCREF(pyvalue); // because SetCause steals a reference
        PyException_SetCause(pyexc, pyvalue);

        // If the old exception was something other than a QuickJSError, we raise a shallow copy of
        // it.  Effectively, this means our outermost exception matches the type of the innermost
        // exception, if and only if the original exception occured in python
        if(!PyErr_GivenExceptionMatches(pyvalue, quickjs_error)){
            PyObject *copy = copy_copy(pyvalue);
            if(!copy){
                PyErr_Clear();
                fprintf(stderr, "WARNING: failed to copy.copy() an exception of type %s\n",
                    Py_TYPE(pyvalue)->tp_name
                );
            }else{
                PyException_SetCause(copy, pyexc);  // steals pyexc
                pyexc = copy;
            }
        }
    }

    PyObject *type = (PyObject*)Py_TYPE(pyexc);
    Py_INCREF(type);
    Py_INCREF(pyexc);
    PyErr_Restore(type, pyexc, NULL);

done:
    Py_CLEAR(pywrapper);
    Py_CLEAR(pyexc);
    JS_FreeValue(ctx, jsvalue);
    JS_FreeValue(ctx, exc);
    return NULL;
}

// converts a python exception to a javascript exception and returns JS_EXCEPTION
static JSValue py_exception(JSContext *ctx) {
    PyObject *exc = PyErr_Occurred();
    if(!exc){
        // no exception was raised
        fprintf(stderr, "py_exception() called without an exception!\n");
        abort();
    }

    // save exception
    PyObject *pytype;
    PyObject *pyvalue;
    PyObject *pytraceback;
    PyErr_Fetch(&pytype, &pyvalue, &pytraceback);

    // create a new javascript Error and embed our python exception behind it
    JSValue err = JS_NewError(ctx);
    if(JS_IsException(err)) goto die;
    JSValue jstype = new_pyref(ctx, pytype);
    if(JS_IsException(jstype)) goto die;
    JSValue jsvalue = new_pyref(ctx, pyvalue);
    if(JS_IsException(jsvalue)) goto die;
    JSValue jstraceback = new_pyref(ctx, pytraceback);
    if(JS_IsException(jstraceback)) goto die;


    JSValue message = JS_NewString(ctx, "exception from python");
    if(JS_IsException(message)) goto die;
    int ret = JS_DefinePropertyValueStr(ctx, err, "message", message, JS_PROP_C_W_E);
    if(ret < 0) goto die;
    ret = JS_DefinePropertyValueStr(ctx, err, "pytype", jstype, JS_PROP_C_W_E);
    if(ret < 0) goto die;
    ret = JS_DefinePropertyValueStr(ctx, err, "pyvalue", jsvalue, JS_PROP_C_W_E);
    if(ret < 0) goto die;
    ret = JS_DefinePropertyValueStr(ctx, err, "pytraceback", jstraceback, JS_PROP_C_W_E);
    if(ret < 0) goto die;

    return JS_Throw(ctx, err);

die:
    fprintf(stdout, "failed to convert python exception: ");
    JSValue jsexc = JS_GetException(ctx);
    js_console_log(ctx, JS_UNDEFINED, 1, &jsexc);
    JS_FreeValue(ctx, jsexc);
    abort();
}


static PyObject *js2py_date(JSContext *ctx, JSValueConst val) {
    JSValue valueOf = JS_UNINITIALIZED;
    JSValue ms = JS_UNINITIALIZED;
    PyObject *args = NULL;
    PyObject *out = NULL;

    // ms = val.valueOf()
    valueOf = JS_GetPropertyStr(ctx, val, "valueOf");
    if(JS_IsException(valueOf)) {
        js_exception(ctx);
        goto done;
    }
    ms = JS_Call(ctx, valueOf, val, 0, NULL);
    if(JS_IsException(ms)) {
        js_exception(ctx);
        goto done;
    }

    // timestamp = double(ms) / 1000;
    double timestamp;
    int ret = JS_ToFloat64(ctx, &timestamp, ms);
    if(ret){
        js_exception(ctx);
        goto done;
    }
    timestamp /= 1000;

    // return datetime.datetime.fromtimestamp(timestamp, datetime.UTC)
    args = Py_BuildValue("(dO)", timestamp, PyDateTime_TimeZone_UTC);
    if(!args) goto done;
    out = PyDateTime_FromTimestamp(args);

done:
    JS_FreeValue(ctx, valueOf);
    JS_FreeValue(ctx, ms);
    Py_CLEAR(args);
    return out;
}

// borrows val, this
static PyObject *js2py(JSContext *ctx, JSValueConst val, PyObject *this) {
    int tag = JS_VALUE_GET_TAG(val);
    switch(tag){
        case JS_TAG_UNDEFINED:
        case JS_TAG_NULL:
            Py_RETURN_NONE;

        case JS_TAG_BOOL: {
            int is_done = JS_ToBool(ctx, val);
            if(is_done < 0) return js_exception(ctx);
            if(is_done){
                Py_RETURN_TRUE;
            } else {
                Py_RETURN_FALSE;
            }
        }

        case JS_TAG_STRING:
        case JS_TAG_STRING_ROPE: {
            size_t len;
            const char *s = JS_ToCStringLen(ctx, &len, val);
            if(!s) return js_exception(ctx);
            PyObject *out = PyUnicode_FromStringAndSize(s, (Py_ssize_t)len);
            JS_FreeCString(ctx, s);
            return out;
        }

        case JS_TAG_BIG_INT:
        case JS_TAG_INT:
        case JS_TAG_SHORT_BIG_INT: {
            int64_t res;
            int ret = JS_ToInt64Ext(ctx, &res, val);
            if(ret < 0) return js_exception(ctx);
            return PyLong_FromInt64(res);
        }

        case JS_TAG_FLOAT64: {
            double res;
            int ret = JS_ToFloat64(ctx, &res, val);
            if(ret < 0) return js_exception(ctx);
            return PyFloat_FromDouble(res);
        }

        case JS_TAG_OBJECT:
            // fallthru
            break;

        default:
            PyErr_Format(PyExc_TypeError, "unsupported type: tag=%d", JS_VALUE_GET_TAG(val));
            return NULL;
    }

    // first: check if object is a pyref, which we can return immediately
    PyObject *out = JS_GetOpaque(val, js_pyref_class_id);
    if(out){
        Py_INCREF(out);
        return out;
    }

    // then check for a Date object, since datetime.datetime can't be made into a weakref
    py_quickjs_t *q = JS_GetContextOpaque(ctx);
    if (JS_GetClassID(val) == q->date_class_id) {
        return js2py_date(ctx, val);
    }

    // more sophisticated types get more cleanup
    bool success = false;
    PyObject *pywr = NULL;
    JSValue jswr = JS_UNINITIALIZED;

    // next: check if we have a weakref to a working python object
    jswr = JS_GetProperty(ctx, val, q->weakref_symbol);
    if(JS_IsException(jswr)){
        js_exception(ctx);
        goto done;
    } else if(JS_IsUndefined(jswr)){
        JS_FreeValue(ctx, jswr);
        jswr = JS_UNINITIALIZED;
    } else {
        // we have a python weakref already
        PyObject *pywr_borrowed = JS_GetOpaque(jswr, js_pyweakref_class_id);
        // is the python weakref healthy?
        PyObject *out_borrowed = PyWeakref_GetObject(pywr_borrowed);
        if(out_borrowed == NULL) goto done;
        if (out_borrowed != Py_None) {
            // python object still healthy
            out = out_borrowed;
            Py_INCREF(out);
            success = true;
            goto done;
        } else {
            // python object is gone; discard weakref
            Py_CLEAR(pywr_borrowed);
            JS_SetOpaque(jswr, NULL);
        }
    }

    if(JS_IsFunction(ctx, val)){
        // wrap value in Function
        out = py_value_new(ctx, val, this);
        if(!out) goto done;
        goto embed_weakref;
    }

    int is_array = JS_IsArray(ctx, val);
    if(is_array < 0){
        js_exception(ctx);
        goto done;
    }
    if(is_array){
        // wrap value in Array
        out = py_value_new(ctx, val, Py_None);
        if(!out) goto done;
        goto embed_weakref;
    }

    // must be a plain object
    out = py_value_new(ctx, val, Py_None);
    if(!out) goto done;

embed_weakref:
    // embed a weakref to this python object in the javascript object.
    pywr = PyWeakref_NewRef(out, NULL);
    if(!pywr) goto done;

    // we might have a working val after cache check, or we might need a new one
    if(JS_IsUninitialized(jswr)){
        jswr = JS_NewObjectClass(ctx, (int)js_pyweakref_class_id);
        if(JS_IsException(jswr)){
            js_exception(ctx);
            goto done;
        }
    }
    JS_SetOpaque(jswr, pywr);
    // pywr reference now owned by jswr
    pywr = NULL;

    // store the pyweakref on the value before returning
    int ret = JS_DefinePropertyValue(
        ctx,
        val,               // object
        q->weakref_symbol, // key
        jswr,              // value
        0                  // flags (not JS_PROP_ENUMERABLE is what we care about)
    );
    if(ret < 0){
        js_exception(ctx);
        goto done;
    }
    // jswr now owned by value
    jswr = JS_UNINITIALIZED;

    success = true;

done:
    if(!JS_IsUninitialized(jswr)) JS_FreeValue(ctx, jswr);
    Py_CLEAR(pywr);
    if(!success) Py_CLEAR(out);
    return out;
}

// wrap an arbitrary python callback
static JSValue _js_call_python(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValue *data
){
    (void)this_val;
    (void)magic;

    PyObject *args = NULL;
    PyObject *retval = NULL;
    JSValue out = JS_EXCEPTION;

    // extract closure variables (borrowed)
    PyObject *func = JS_GetOpaque(data[0], js_pyref_class_id);

    // extract args
    args = PyTuple_New((Py_ssize_t)argc);
    if(!args){
        py_exception(ctx);
        goto done;
    }
    for(int i = 0; i < argc; i++){
        PyObject *arg = js2py(ctx, argv[i], Py_None);
        if(!arg){
            py_exception(ctx);
            goto done;
        }
        PyTuple_SET_ITEM(args, (Py_ssize_t)i, arg);
    }

    // call python function
    retval = PyObject_Call(func, args, NULL);
    if(!retval){
        py_exception(ctx);
        goto done;
    }

    // convert result to javascript
    out = py2js(ctx, retval);

done:
    Py_CLEAR(args);
    Py_CLEAR(retval);
    return out;
}

static JSValue py2js_date(JSContext *ctx, PyObject *val) {
    PyObject *method = NULL;
    PyObject *timestamp = NULL;
    JSValue out = JS_EXCEPTION;

    // timestamp = val.timestamp()
    method = PyObject_GetAttrString(val, "timestamp");
    if(!method){
        py_exception(ctx);
        goto done;
    }
    timestamp = PyObject_CallNoArgs(method);
    if(!timestamp){
        py_exception(ctx);
        goto done;
    }

    // ms = timestamp * 1000;
    double ms = PyFloat_AsDouble(timestamp);
    if(ms == -1 && PyErr_Occurred()){
        py_exception(ctx);
        goto done;
    }
    ms *= 1000;

    // return new Date(ms)
    out = JS_NewDate(ctx, ms);

done:
    Py_CLEAR(method);
    Py_CLEAR(timestamp);
    return out;
}

// borrows val
static JSValue py2js(JSContext *ctx, PyObject *val) {
    // is object a singleton?
    if(val == Py_False){
        return JS_FALSE;
    }
    if(val == Py_True){
        return JS_TRUE;
    }
    if(val == Py_None){
        return JS_NULL;
    }

    // is object a string?
    int isinstance;
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&PyUnicode_Type))){
        if(isinstance < 0) return py_exception(ctx);
        Py_ssize_t len;
        const char *str = PyUnicode_AsUTF8AndSize(val, &len);
        if(!str) return py_exception(ctx);
        return JS_NewStringLen(ctx, str, (size_t)len);
    }

    // is object an integer?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&PyLong_Type))){
        if(isinstance < 0) return py_exception(ctx);
        int64_t i = PyLong_AsLongLong(val);
        if(i == -1 && PyErr_Occurred()){
            return py_exception(ctx);
        }
        return JS_NewInt64(ctx, i);
    }

    // is object an float?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&PyFloat_Type))){
        if(isinstance < 0) return py_exception(ctx);
        double d = PyFloat_AsDouble(val);
        if(d == -1.0 && PyErr_Occurred()){
            return py_exception(ctx);
        }
        return JS_NewFloat64(ctx, d);
    }

    // is object a datetime.datetime?
    if(PyDateTime_Check(val)){
        // make sure the caller remembers to provide utc timezone; that's all we support
        if(PyDateTime_DATE_GET_TZINFO(val) != PyDateTime_TimeZone_UTC) {
            PyErr_Format(PyExc_ValueError, "non-utc datetime not supported");
            return py_exception(ctx);
        }
        return py2js_date(ctx, val);
    }

    // is object a _quickjs.Value?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&py_value_type))){
        if(isinstance < 0) return py_exception(ctx);
        // just return the underlying object
        return JS_DupValue(ctx, ((py_value_t*)val)->jsval);
    }

    // is object a _quickjs.Opaque?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&py_opaque_type))){
        if(isinstance < 0) return py_exception(ctx);
        // return an opaque pyref
        PyObject *ref = ((py_opaque_t*)val)->ref;
        Py_INCREF(ref);
        return new_pyref(ctx, ref);
    }

    PyObject *items = NULL;
    PyObject *fast = NULL;
    JSValue jsout = JS_EXCEPTION;

    bool success = false;

    // is object a list or a tuple?
    if(PyList_Check(val) || PyTuple_Check(val)){
        // create array output
        jsout = JS_NewArray(ctx);
        if(JS_IsException(jsout)){
            js_exception(ctx);
            goto done;
        }
        // iterate through items
        fast = PySequence_Fast(val, "found sequence which is neither tuple nor list");
        if(!fast) goto done;
        Py_ssize_t len = PySequence_Fast_GET_SIZE(fast);
        if(len < 0) goto done;
        for(Py_ssize_t i = 0; i < len; i++){
            PyObject *borrowed = PySequence_Fast_GET_ITEM(fast, i);
            // convert value (recurse)
            JSValue jsitem = py2js(ctx, borrowed);
            if(JS_IsException(jsitem)){
                js_exception(ctx);
                goto done;
            }
            int ret = JS_DefinePropertyValueUint32(ctx, jsout, (uint32_t)i, jsitem, JS_PROP_C_W_E);
            if(ret < 0){
                js_exception(ctx);
                goto done;
            }
        }

        success = true;
        goto done;
    }

    // is object a dict?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&PyDict_Type))){
        if(isinstance < 0) goto done;
        // create plain object output
        jsout = JS_NewObject(ctx);
        if(JS_IsException(jsout)){
            js_exception(ctx);
            goto done;
        }

        // iterate through key/value pairs
        items = PyMapping_Items(val);
        if(!items) goto done;
        Py_ssize_t len = PyList_GET_SIZE(items);
        for(Py_ssize_t i = 0; i < len; i++){
            // kv, key, and value are all borrowed
            PyObject *kv = PyList_GET_ITEM(items, i);
            PyObject *pykey = PyTuple_GET_ITEM(kv, 0);
            PyObject *pyval = PyTuple_GET_ITEM(kv, 1);
            // key must be a string
            isinstance = PyObject_IsInstance(pykey, (PyObject*)&PyUnicode_Type);
            if(isinstance < 0) goto done;
            if(!isinstance){
                PyErr_SetString(PyExc_TypeError, "only string keys are allowed on dict objects");
                goto done;
            }
            const char *key = PyUnicode_AsUTF8(pykey);
            if(!key) goto done;
            // recurse for the value
            JSValue jsval = py2js(ctx, pyval);
            if(JS_IsException(jsval)){
                js_exception(ctx);
                goto done;
            }
            // set value on ouptut
            int ret = JS_DefinePropertyValueStr(ctx, jsout, key, jsval, JS_PROP_C_W_E);
            if(ret < 0){
                js_exception(ctx);
                goto done;
            }
        }

        success = true;
        goto done;
    }

    // is object a function?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&PyFunction_Type))){
        if(isinstance < 0) goto done;

        Py_INCREF(val);
        JSValue valref = new_pyref(ctx, val);
        if(JS_IsException(valref)){
            js_exception(ctx);
            goto done;
        }
        jsout = JS_NewCFunctionData(ctx, _js_call_python, 0, 0, 1, &valref);
        JS_FreeValue(ctx, valref);
        if(JS_IsException(jsout)) goto done;

        success = true;
        goto done;
    }

    PyErr_Format(PyExc_TypeError, "unexpected type in py2js (%s)", Py_TYPE(val)->tp_name);

done:
    Py_CLEAR(items);
    Py_CLEAR(fast);
    if(!success){
        if(PyErr_Occurred()) py_exception(ctx);
        if(!JS_IsUninitialized(jsout)) JS_FreeValue(ctx, jsout);
        jsout = JS_EXCEPTION;
    }
    return jsout;
}

// steals ref to val
static JSValue new_pyref(JSContext *ctx, PyObject *val) {
    JSValue pyref = JS_NewObjectClass(ctx, (int)js_pyref_class_id);
    if(JS_IsException(pyref)){
        js_exception(ctx);
        Py_CLEAR(val);
        return pyref;
    }
    JS_SetOpaque(pyref, val);
    return pyref;
}

// quickjs environment helpers

static void js_print_value_write(void *opaque, const char *buf, size_t len)
{
    FILE *fo = opaque;
    fwrite(buf, 1, len, fo);
}

static JSValue js_console_log(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv
) {
    (void)this_val;
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

static JSValue js_generate_uuid(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv
) {
    (void)this_val;
    (void)argc;
    (void)argv;
    PyObject *uuid = NULL;
    PyObject *pystr = NULL;
    JSValue out = JS_UNINITIALIZED;

    // generate a uuid
    uuid = uuid_uuid4();
    if(!uuid) {
        py_exception(ctx);
        goto done;
    }

    // call str() on it
    pystr = PyObject_Str(uuid);
    if(!pystr) {
        py_exception(ctx);
        goto done;
    }

    // convert to js string
    Py_ssize_t len;
    const char *cstr = PyUnicode_AsUTF8AndSize(pystr, &len);
    out = JS_NewStringLen(ctx, cstr, (size_t)len);

done:
    Py_XDECREF(uuid);
    Py_XDECREF(pystr);
    return out;
}

static int prep_env(JSContext *ctx){
    JSValue global = JS_UNINITIALIZED;
    JSValue console = JS_UNINITIALIZED;
    int retval = -1;

    global = JS_GetGlobalObject(ctx);
    if(JS_IsException(global)){
        js_exception(ctx);
        goto done;
    }

    console = JS_NewObject(ctx);
    if(JS_IsException(console)){
        js_exception(ctx);
        goto done;
    }

    JSValue log = JS_NewCFunction(ctx, js_console_log, "log", 1);
    if(JS_IsException(log)){
        js_exception(ctx);
        goto done;
    }

    // inject console.log
    JS_SetPropertyStr(ctx, console, "log", log);
    log = JS_UNINITIALIZED;
    JS_SetPropertyStr(ctx, global, "console", console);
    console = JS_UNINITIALIZED;

    // inject generateUuid
    JSValue generateUuid = JS_NewCFunction(ctx, js_generate_uuid, "generateUuid", 0);
    if (JS_IsException(generateUuid)) {
        js_exception(ctx);
        goto done;
    }
    JS_SetPropertyStr(ctx, global, "generateUuid", generateUuid);
    generateUuid = JS_UNINITIALIZED;

    retval = 0;

done:
    if(!JS_IsUninitialized(console)) JS_FreeValue(ctx, console);
    if(!JS_IsUninitialized(global)) JS_FreeValue(ctx, global);
    return retval;
}


/*
    JSAny = None | str | int | float | Array | Object | Function | Method
    JSArg = JSAny | Dict[str, JSArg] | List[JSArg] | Tuple[JSArg...]

    class QuickJS:
        def __init__(self): ...
        def eval(script: str, flags=0) -> JSAny: ...
*/

static void py_quickjs_dealloc(py_quickjs_t *self){
    if(self->rt){
        JS_FreeValue(self->ctx, self->show_stack);
        JS_FreeValue(self->ctx, self->add_source_map);
        if(self->weakref_symbol) JS_FreeAtom(self->ctx, self->weakref_symbol);
        if(self->ctx) JS_FreeContext(self->ctx);
        self->ctx = NULL;
        JS_FreeRuntime(self->rt);
        self->rt = NULL;
    }
    Py_TYPE(self)->tp_free((PyObject*)self);
}

const char *show_stack =
"(() => {\n"
"  // from https://dev.to/yne/quickjs-handle-typescript-sourcemap-3b00 //\n"
"  const VLQ_BASE = 5;\n"
"  const VLQ_CONT = 1 << VLQ_BASE;  // 100000\n"
"  const VLQ_MASK = VLQ_CONT - 1;   // 011111\n"
"  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';\n"
"  function vlq(segment) {\n"
"      const fields = [];\n"
"      for (let segIdx = 0; segIdx < segment.length;) {\n"
"          let result = 0;\n"
"          for (let shift = 0; ; shift += VLQ_BASE) {\n"
"              const digit = b64.indexOf(segment.charAt(segIdx++));\n"
"              result += ((digit & VLQ_MASK) << shift);\n"
"              if (!(digit & VLQ_CONT)) break;\n"
"          };\n"
"          fields.push(result & 1 ? -(result >> 1) : result >> 1)\n"
"      }\n"
"      return fields; // col,srcIdx,lineSrc,colSrc,nameIdx\n"
"  };\n"
"  //////////////////////////////////////////////////////////////////////\n"
"\n"
"  // sourcemap spec: https://tc39.es/ecma426/\n"
"  // sourcemap explanation: https://github.com/Rich-Harris/vlq/blob/master/sourcemaps/README.md\n"
"\n"
"  function tsLine(sourceMap, jsLine, jsCol) {\n"
"    const fields = sourceMap.mappings.split(';').map(g=>g.split(',').map(vlq));\n"
"    // these fields accumulate across the whole of mappings\n"
"    let source = 0;\n"
"    let line = 0;\n"
"    let col = 0;\n"
"\n"
"    // accumulate previous lines\n"
"    for (let i = 0; i < jsLine - 1; i++) {\n"
"      const segments = fields[i];\n"
"      for (const segment of segments) {\n"
"        source += segment[1] ?? 0;\n"
"        line += segment[2] ?? 0;\n"
"        col += segment[3] ?? 0;\n"
"      }\n"
"    }\n"
"\n"
"    // locate the right segment of the current line\n"
"    let pos = 0;\n"
"    for (const segment of fields[jsLine - 1]) {\n"
"      pos += segment[0];\n"
"      if (pos > jsCol) break;\n"
"      source += segment[1] ?? 0;\n"
"      line += segment[2] ?? 0;\n"
"      col += segment[3] ?? 0;\n"
"    }\n"
"    return `${sourceMap.sources[source]}:${line+1}:${col+1}`;\n"
"  }\n"
"\n"
"  const sourceMaps = {};\n"
"  function addSourceMap(name, map){\n"
"    sourceMaps[name] = map;\n"
"  }\n"
"\n"
"  function showStack(e){\n"
"    if (e.message === undefined || e.stack === undefined) {\n"
"      return `${e}`\n"
"    }\n"
"    let stack = `${e.message}\n`;\n"
"    // example: `at run (bundle.js:266:46)`\n"
"    const re = /at (?<func>[^ ]+) \\((?<file>[^:\\n]+):(?<lineStr>[0-9]+):(?<colStr>[0-9]+)\\)/g;\n"
"    for (const match of e.stack.matchAll(re)) {\n"
"      const {func, file, lineStr, colStr} = match.groups;\n"
"      const line = Number(lineStr);\n"
"      const col = Number(colStr);\n"
"      const map = sourceMaps[file];\n"
"      if (map !== undefined) {\n"
"        let out = tsLine(map, line, col);\n"
"        while (out.substring(0, 3) === '../') {\n"
"          out = out.substring(3);\n"
"        }\n"
"        stack += `    at ${func} (${out})\\n`;\n"
"      } else {\n"
"        stack += `    at ${func} (${file}:${line}:${col}))\\n`;\n"
"        continue;\n"
"      }\n"
"    }\n"
"    return stack;\n"
"  }\n"
"\n"
"  return {addSourceMap, showStack};\n"
"})();\n";

static int py_quickjs_init(py_quickjs_t *self, PyObject *args, PyObject *kwds){
    self->weakref_symbol = JS_ATOM_NULL;
    self->show_stack = JS_UNINITIALIZED;
    self->add_source_map = JS_UNINITIALIZED;

    char *kwnames[] = { NULL };

    int ret = PyArg_ParseTupleAndKeywords(args, kwds, "", kwnames);
    if(!ret) return -1;

    self->rt = JS_NewRuntime();
    if(!self->rt) {
        PyErr_SetString(PyExc_RuntimeError, "JS_NewRuntime() failed");
        return -1;
    }

    self->ctx = JS_NewContext(self->rt);
    if(!self->ctx) {
        PyErr_SetString(PyExc_RuntimeError, "JS_NewContext() failed");
        return -1;
    }

    ret = prep_env(self->ctx);
    if(ret) return -1;


    // create new symbol; seems to only be possible in javascript
    JSValue val = JS_Eval(self->ctx, "Symbol()", 8, "symbol", 0);
    if(JS_IsException(val)){
        (void)js_exception(self->ctx);
        return -1;
    }
    self->weakref_symbol = JS_ValueToAtom(self->ctx, val);
    JS_FreeValue(self->ctx, val);
    if(!self->weakref_symbol){
        (void)js_exception(self->ctx);
        return -1;
    }

    // create a show_stack function
    val = JS_Eval(self->ctx, show_stack, strlen(show_stack), "QuickJS.show_stack", 0);
    if(JS_IsException(val)){
        (void)js_exception(self->ctx);
        return -1;
    }
    self->add_source_map = JS_GetPropertyStr(self->ctx, val, "addSourceMap");
    if(JS_IsException(self->add_source_map)){
        JS_FreeValue(self->ctx, val);
        (void)js_exception(self->ctx);
        return -1;
    }
    self->show_stack = JS_GetPropertyStr(self->ctx, val, "showStack");
    JS_FreeValue(self->ctx, val);
    if(JS_IsException(self->show_stack)){
        (void)js_exception(self->ctx);
        return -1;
    }

    // create a new javascript classes
    JS_NewClassID(&js_pyweakref_class_id);
    ret = JS_NewClass(self->rt, js_pyweakref_class_id, &js_pyweakref_class);
    if(ret < 0){
        PyErr_SetString(PyExc_RuntimeError, "failed to create PyWeakRef javascript class");
        return -1;
    }

    JS_NewClassID(&js_pyref_class_id);
    ret = JS_NewClass(self->rt, js_pyref_class_id, &js_pyref_class);
    if(ret < 0){
        PyErr_SetString(PyExc_RuntimeError, "failed to create PyRef javascript class");
        return -1;
    }

    // get the class_id of Date
    JSValue date = JS_NewDate(self->ctx, 0);
    if(JS_IsException(date)){
        (void)js_exception(self->ctx);
        return -1;
    }
    self->date_class_id = JS_GetClassID(date);
    JS_FreeValue(self->ctx, date);

    // remember this struct for later
    JS_SetContextOpaque(self->ctx, self);

    return 0;
}

static char * const py_quickjs_eval_doc =
    "eval(script: str, file:str, sourcemap: Dict[str, Any], flags=0) -> JSAny\n"
    "eval script and return result";
static PyObject *py_quickjs_eval(py_quickjs_t *self, PyObject *args, PyObject *kwds){
    const char *script;
    const char *file = "script";
    PyObject *sourcemap = NULL;
    int flags = 0;

    char *kwnames[] = {
        "script",
        "file",
        "sourcemap",
        "flags",
        NULL,
    };

    int ret = PyArg_ParseTupleAndKeywords(
        args, kwds, "s|sOi", kwnames,
        &script,
        &file,
        &sourcemap,
        &flags
    );
    if(!ret) return NULL;

    PyObject *out = NULL;

    if(sourcemap){
        JSValue jsfile = JS_NewString(self->ctx, file);
        if(JS_IsException(jsfile)){
            js_exception(self->ctx);
            goto done;
        }
        JSValue jssourcemap = py2js(self->ctx, sourcemap);
        if(JS_IsException(jssourcemap)){
            JS_FreeValue(self->ctx, jsfile);
            js_exception(self->ctx);
            goto done;
        }
        JSValueConst args[] = {jsfile, jssourcemap};
        JSValue jsret = JS_Call(self->ctx, self->add_source_map, JS_NULL, 2, args);
        JS_FreeValue(self->ctx, jsfile);
        JS_FreeValue(self->ctx, jssourcemap);
        if(JS_IsException(jsret)){
            js_exception(self->ctx);
            goto done;
        }
        JS_FreeValue(self->ctx, jsret);
    }

    JSValue val = JS_Eval(self->ctx, script, strlen(script), file, flags);
    if(JS_IsException(val)) {
        js_exception(self->ctx);
        goto done;
    }

    if(flags == (JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY)){
        // JS_EvalFunction(module) will evaluate the module and return an already-resolved promise
        // or an exception.  Or at least, I don't know when the promise might not be
        // already-resolved.  But we don't care about the promise, only the module, which was the
        // `val` originally returned by JS_Eval().
        JSValue promise = JS_EvalFunction(self->ctx, JS_DupValue(self->ctx, val));
        if(JS_IsException(promise)){
            JS_FreeValue(self->ctx, val);
            goto done;
        }
        JS_FreeValue(self->ctx, promise);

        // return the exported namespace of the module
        JSValue ns = JS_GetModuleNamespace(self->ctx, (JSModuleDef*)(JS_VALUE_GET_PTR(val)));
        JS_FreeValue(self->ctx, val);
        val = ns;
    }

    out = js2py(self->ctx, val, Py_None);
    JS_FreeValue(self->ctx, val);

done:
    return out;
}

static PyMethodDef py_quickjs_methods[] = {
    {
        .ml_name = "eval",
        .ml_meth = (PyCFunction)(void*)py_quickjs_eval,
        .ml_flags = METH_VARARGS | METH_KEYWORDS,
        .ml_doc = py_quickjs_eval_doc,
    },
    {NULL}, // sentinel
};


static PyTypeObject py_quickjs_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_quickjs.QuickJS",
    .tp_doc = "python bindings to quickjs",
    .tp_basicsize = sizeof(py_quickjs_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_quickjs_dealloc,
    .tp_methods = py_quickjs_methods,
    .tp_init = (initproc)py_quickjs_init,
};

// _quickjs.Value
/*
    class Value:
        """
        A lazily-populated wrapper around a quickjs javascript object.

        Attributes are converted once and then cached.
        """
        def __getattr__(self, name) -> JSAny: ...

        def __call__(self, *args) -> JSAny: ...
            """Call a function with automatic `this`."""

        def call(self, this, *args) -> JSAny: ...
            """Call a function with explicit `this`."""

        def length(self) -> int: ...
            """If array, return the length, otherwise the number of enumerable keys."""

        def keys(self) -> int: ...
            """Return all enumerable keys."""

        def values(self) -> int: ...
            """Return all values for enumerable keys."""

        def items(self) -> List[]: ...
            """Return all enumerable (key, value) tuples."""
*/

static void py_value_dealloc(py_value_t *self){
    JSContext *ctx = self->ctx;
    if(ctx && !JS_IsUninitialized(self->jsval)){
        JS_FreeValue(ctx, self->jsval);
        self->jsval = JS_UNINITIALIZED;
    }
    if(self->weakreflist != NULL) PyObject_ClearWeakRefs((PyObject*)self);
    Py_CLEAR(self->cache);
    Py_CLEAR(self->this);
    Py_TYPE(self)->tp_free((PyObject*)self);
    // also decrement the QuickJS object
    if(ctx) Py_DECREF((PyObject*)JS_GetContextOpaque(ctx));
}

// jsval and this are both borrowed
static PyObject *py_value_new(JSContext *ctx, JSValue jsval, PyObject *this){
    py_value_t *out = PyObject_New(py_value_t, (PyTypeObject*)&py_value_type);
    if(!out) return NULL;

    // no-fail setup to make dealloc safe

    out->ctx = ctx;
    out->weakreflist = NULL;
    out->cache = NULL;
    out->this = this; Py_INCREF(this);
    out->jsval = JS_UNINITIALIZED;
    out->objlen = -1;
    out->arrlen = -1;
    // we keep a reference to the QuickJS so we free our data before QuickJS
    // frees the js context
    Py_INCREF((PyObject*)JS_GetContextOpaque(ctx));

    // check if we're an array
    int is_array = JS_IsArray(ctx, jsval);
    if(is_array < 0){
        js_exception(ctx);
        goto fail;
    }else if(is_array){
        // get length of the array once
        JSValue length = JS_GetPropertyStr(ctx, jsval, "length");
        if(JS_IsException(length)){
            js_exception(ctx);
            goto fail;
        }
        int64_t arrlen;
        int ret = JS_ToInt64Ext(ctx, &arrlen, length);
        JS_FreeValue(ctx, length);
        if(ret < 0){
            js_exception(ctx);
            goto fail;
        }
        out->arrlen = (Py_ssize_t)arrlen;
    }

    // increment reference count to save our parameter
    JSValue dup = JS_DupValue(ctx, jsval);
    if(JS_IsException(dup)){
        js_exception(ctx);
        goto fail;
    }
    out->jsval = dup;

    out->cache = PyDict_New();
    if(!out->cache){
        goto fail;
    }

    return (PyObject*)out;

fail:
    Py_CLEAR(out);
    return NULL;
}

static int py_value_init(py_value_t *self, PyObject *args, PyObject *kwds){
    self->ctx = NULL;
    self->jsval = JS_UNINITIALIZED;
    self->weakreflist = NULL;
    self->cache = NULL;
    self->this = NULL;
    (void)args;
    (void)kwds;
    PyErr_SetString(PyExc_TypeError, "Value can only be created in C code");
    return -1;
}

static PyObject *py_value_getstr(py_value_t *self, const char *key){
    PyObject *out = NULL;
    JSValue jsval = JS_UNINITIALIZED;
    JSAtom atom = JS_ATOM_NULL;
    bool success = false;

    // check cache
    out = PyDict_GetItemString(self->cache, key);
    if(out){
        // cache hit
        Py_INCREF(out); // result was borrowed
        success = true;
        goto done;
    }

    atom = JS_NewAtom(self->ctx, key);
    if(!atom){
        js_exception(self->ctx);
        goto done;
    }

    jsval = JS_GetProperty(self->ctx, self->jsval, atom);
    if(JS_IsException(jsval)){
        js_exception(self->ctx);
        goto done;
    }

    // did we get something?
    if(JS_IsUndefined(jsval)){
        // must use HasProperty to distinguish literal undefined from missing key
        int hasprop = JS_HasProperty(self->ctx, self->jsval, atom);
        if(hasprop < 0){
            js_exception(self->ctx);
            goto done;
        }
        if(!hasprop){
            PyErr_Format(PyExc_AttributeError, "no such key: %s", key);
            goto done;
        }
    }

    // convert to python object; functions get an embedded `this` pointing to us
    out = js2py(self->ctx, jsval, (PyObject*)self);
    if(!out) goto done;

    // Cache all types on self.  If there is a circular reference in javascript, we can create
    // space leaks in python since we haven't enabling GC on this python object.  But that seems
    // unlikely, at least for now.
    int ret = PyDict_SetItemString(self->cache, key, out);
    if(ret) goto done;

    success = true;

done:
    if(atom) JS_FreeAtom(self->ctx, atom);
    JS_FreeValue(self->ctx, jsval);
    if(!success) Py_CLEAR(out);

    return out;
}

static PyObject *py_value_getint(py_value_t *self, Py_ssize_t index){
    if(index > UINT32_MAX){
        PyErr_SetString(PyExc_ValueError, "index too large");
        return NULL;
    }
    // array negative index handling
    if(index < 0) {
        PyErr_SetString(PyExc_ValueError, "negative index not allowed");
        return NULL;
    }

    PyObject *out = NULL;
    PyObject *pykey = NULL;
    JSValue jsval = JS_UNINITIALIZED;
    bool success = false;

    // construct key object
    pykey = PyLong_FromSsize_t(index);
    if(!pykey) goto done;

    // check cache
    out = PyDict_GetItem(self->cache, pykey);
    if(out){
        // cache hit
        Py_INCREF(out);
        success = true;
        goto done;
    }

    jsval = JS_GetPropertyUint32(self->ctx, self->jsval, (uint32_t)index);
    if(JS_IsException(jsval)){
        js_exception(self->ctx);
        goto done;
    }
    // did we get something?
    if(JS_IsUndefined(jsval)){
        PyErr_SetString(PyExc_AttributeError, "no such key");
        goto done;
    }

    // convert to python object; functions must be standalone
    out = js2py(self->ctx, jsval, Py_None);
    if(!out) goto done;

    // Cache all types on self.  If there is a circular reference in javascript, we can create
    // space leaks in python since we haven't enabling GC on this python object.  But that seems
    // unlikely, at least for now.
    int ret = PyDict_SetItem(self->cache, pykey, out);
    if(ret) goto done;

    success = true;

done:
    if(!JS_IsUninitialized(jsval)) JS_FreeValue(self->ctx, jsval);
    if(!success) Py_CLEAR(out);
    Py_CLEAR(pykey);

    return out;
}

static PyObject *py_value_getattro(py_value_t *self, PyObject *attr){
    // first try the default lookup, for pre-defined methods and attributes
    Py_INCREF(attr);
    PyObject *out = PyObject_GenericGetAttr((PyObject*)self, attr);
    if(out != NULL) goto done;

    // TODO: make sure it was an attribute error first
    PyErr_Clear();

    // attributes are always strings
    const char *key = PyUnicode_AsUTF8(attr);
    if(!key) goto done;

    out = py_value_getstr(self, key);

done:
    Py_CLEAR(attr);
    return out;
}

// base implementation; borrows this and args
static PyObject *call_function(py_value_t *self, PyObject *this, PyObject *args, Py_ssize_t skip){
    PyObject *out = NULL;
    JSValue *jsargs = NULL;
    int iargs = 0;
    JSValue jsret = JS_UNINITIALIZED;
    JSValue jsthis = JS_UNINITIALIZED;

    // convert this
    jsthis = py2js(self->ctx, this);
    if(JS_IsException(jsthis)){
        js_exception(self->ctx);
        goto done;
    }

    // convert args
    Py_ssize_t nargs = PyTuple_GET_SIZE(args);
    if(skip != nargs){
        jsargs = malloc(sizeof(*jsargs) * (size_t)(nargs - skip));
        if(!jsargs){
            PyErr_SetString(PyExc_RuntimeError, "error allocating memory for call");
            goto done;
        }
    }
    for(Py_ssize_t i = skip; i < nargs; i++){
        // get arg (borrowed)
        PyObject *borrowed = PyTuple_GetItem(args, i);
        if(!borrowed) goto done;
        // construct js value
        jsret = py2js(self->ctx, borrowed);
        if(JS_IsException(jsret)){
            js_exception(self->ctx);
            goto done;
        }
        // place in array
        jsargs[iargs++] = jsret;
        jsret = JS_UNINITIALIZED;
    }

    // make the call
    jsret = JS_Call(self->ctx, self->jsval, jsthis, iargs, jsargs);
    if(JS_IsException(jsret)){
        js_exception(self->ctx);
        goto done;
    }

    // convert return value to python
    out = js2py(self->ctx, jsret, Py_None);

done:
    if(!JS_IsUninitialized(jsthis)) JS_FreeValue(self->ctx, jsthis);
    if(!JS_IsUninitialized(jsret)) JS_FreeValue(self->ctx, jsret);
    // free any args we converted
    for(Py_ssize_t i = 0; i < iargs; i++) JS_FreeValue(self->ctx, jsargs[i]);
    // free the args array
    if(jsargs) free(jsargs);
    return out;

}

// .__call__(...) handler
static PyObject *py_value_tp_call(py_value_t *self, PyObject *args, PyObject *kwargs){
    // check that args are all positional
    if(kwargs != NULL && PyDict_Size(kwargs) != 0){
        PyErr_SetString(PyExc_TypeError, "javascript functions only support positional args");
        return NULL;
    }

    // use built-in this
    return call_function(self, self->this, args, 0);
}

static char * const py_value_call_doc =
    "call(this, ...) -> JSAny\n"
    "call a javascript function with explicit `this`";
static PyObject *py_value_call(py_value_t *self, PyObject *args){
    Py_ssize_t nargs = PyTuple_GET_SIZE(args);
    if(nargs < 1){
        PyErr_SetString(PyExc_TypeError, ".call() requires a `this` parameter");
        return NULL;
    }

    PyObject *this = PyTuple_GetItem(args, 0);
    if(!this){
        return NULL;
    }

    // let the function args be all the remaining parameters
    return call_function(self, this, args, 1);
}

// mapping methods

typedef PyObject *(*iter_key_fn)(py_value_t *self, JSPropertyEnum *props, uint32_t len);
static PyObject *iter_keys(py_value_t *self, iter_key_fn func){
    PyObject *out = NULL;
    bool success = false;

    JSPropertyEnum *props = NULL;
    uint32_t len;
    int flags = JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY;
    int ret = JS_GetOwnPropertyNames(self->ctx, &props, &len, self->jsval, flags);
    if(ret < 0){
        js_exception(self->ctx);
        goto done;
    }
    if(self->objlen == -1) self->objlen = len;

    out = func(self, props, len);
    if(!out) goto done;

    success = true;

done:
    if(props) JS_FreePropertyEnum(self->ctx, props, len);
    if(!success) Py_CLEAR(out);
    return out;
}

static PyObject *itemsfunc(py_value_t *self, JSPropertyEnum *props, uint32_t len){
    PyObject *out = NULL;
    JSValue key = JS_UNINITIALIZED;
    JSValue val = JS_UNINITIALIZED;
    bool success = false;

    out = PyList_New((Py_ssize_t)len);
    if(!out) goto done;

    for(uint32_t i = 0; i < len; i++){
        key = JS_AtomToString(self->ctx, props[i].atom);
        if(JS_IsException(key)){
            js_exception(self->ctx);
            goto done;
        }

        JSPropertyDescriptor desc;
        int ret = JS_GetOwnProperty(self->ctx, &desc, self->jsval, props[i].atom);
        if(ret < 0){
            js_exception(self->ctx);
            goto done;
        }
        if(!ret){
            // somehow somebody mutated the object since we listed keys
            val = JS_UNDEFINED;
        }else{
            val = desc.value;
            JS_FreeValue(self->ctx, desc.getter);
            JS_FreeValue(self->ctx, desc.setter);
        }

        PyObject *pykey = js2py(self->ctx, key, Py_None);
        if(!pykey) goto done;

        PyObject *pyval = js2py(self->ctx, val, Py_None);
        if(!pyval){
            Py_CLEAR(pykey);
            goto done;
        }
        PyObject *pair = PyTuple_Pack(2, pykey, pyval);
        Py_CLEAR(pykey);
        Py_CLEAR(pyval);
        if(!pair) goto done;

        PyList_SET_ITEM(out, (Py_ssize_t)i, pair);

        JS_FreeValue(self->ctx, key);
        JS_FreeValue(self->ctx, val);
        key = JS_UNINITIALIZED;
        val = JS_UNINITIALIZED;
    }

    success = true;

done:
    if(!JS_IsUninitialized(key)) JS_FreeValue(self->ctx, key);
    if(!JS_IsUninitialized(val)) JS_FreeValue(self->ctx, val);
    if(!success) Py_CLEAR(out);
    return out;
}

static PyObject *keysfunc(py_value_t *self, JSPropertyEnum *props, uint32_t len){
    PyObject *out = NULL;
    JSValue key = JS_UNINITIALIZED;
    bool success = false;

    out = PyList_New((Py_ssize_t)len);
    if(!out) goto done;

    for(uint32_t i = 0; i < len; i++){
        key = JS_AtomToString(self->ctx, props[i].atom);
        if(JS_IsException(key)){
            js_exception(self->ctx);
            goto done;
        }

        PyObject *pykey = js2py(self->ctx, key, Py_None);
        if(!pykey) goto done;

        PyList_SET_ITEM(out, (Py_ssize_t)i, pykey);

        JS_FreeValue(self->ctx, key);
        key = JS_UNINITIALIZED;
    }

    success = true;

done:
    if(!JS_IsUninitialized(key)) JS_FreeValue(self->ctx, key);
    if(!success) Py_CLEAR(out);
    return out;
}

static PyObject *valuesfunc(py_value_t *self, JSPropertyEnum *props, uint32_t len){
    PyObject *out = NULL;
    JSValue val = JS_UNINITIALIZED;
    bool success = false;

    out = PyList_New((Py_ssize_t)len);
    if(!out) goto done;

    for(uint32_t i = 0; i < len; i++){
        JSPropertyDescriptor desc;
        int ret = JS_GetOwnProperty(self->ctx, &desc, self->jsval, props[i].atom);
        if(ret < 0){
            js_exception(self->ctx);
            goto done;
        }
        if(!ret){
            // somehow somebody mutated the object since we listed keys
            val = JS_UNDEFINED;
        }else{
            val = desc.value;
            JS_FreeValue(self->ctx, desc.getter);
            JS_FreeValue(self->ctx, desc.setter);
        }

        PyObject *pyval = js2py(self->ctx, val, Py_None);
        if(!pyval) goto done;

        PyList_SET_ITEM(out, (Py_ssize_t)i, pyval);

        JS_FreeValue(self->ctx, val);
        val = JS_UNINITIALIZED;
    }

    success = true;

done:
    if(!JS_IsUninitialized(val)) JS_FreeValue(self->ctx, val);
    if(!success) Py_CLEAR(out);
    return out;
}

static char * const py_value_items_doc =
    "items() -> List[Tuple[str, JSAny]]\n"
    "get all enumerable key/value pairs in the object";
static PyObject *py_value_items(py_value_t *self){
    return iter_keys(self, itemsfunc);
}

static char * const py_value_keys_doc =
    "keys() -> List[str]\n"
    "get all enumerable keys in the object";
static PyObject *py_value_keys(py_value_t *self){
    return iter_keys(self, keysfunc);
}

static char * const py_value_values_doc =
    "values() -> List[JSAny]\n"
    "get all enumerable values pairs in the object";
static PyObject *py_value_values(py_value_t *self){
    return iter_keys(self, valuesfunc);
}

static PyObject *objlenfunc(py_value_t *self, JSPropertyEnum *props, uint32_t len){
    (void)self;
    (void)props;
    (void)len;
    // nothing to do; just needed to trigger an object length check
    Py_RETURN_NONE;
}

// sq_length takes priority over mp length, but sometimes somebody asks specifically for mp_length
static Py_ssize_t py_value_mp_length(py_value_t *self){
    // (same as sq_length)
    if(self->arrlen > -1) return self->arrlen;
    if(self->objlen == -1){
        PyObject *obj = iter_keys(self, objlenfunc);
        if(!obj) return -1;
        Py_CLEAR(obj);
    }
    return self->objlen;
}

static PyObject *py_value_array_to_list(
    py_value_t *self, Py_ssize_t start, Py_ssize_t stop, Py_ssize_t step
){
    PyObject *out = NULL;

    Py_ssize_t slicelen = PySlice_AdjustIndices(self->arrlen, &start, &stop, step);

    out = PyList_New(slicelen);
    if(!out) goto fail;
    Py_ssize_t j = 0;
    int sign = 1 - 2 * (step < 0);
    for(Py_ssize_t i = start; sign * i < sign * stop; i += step){
        PyObject *item = py_value_getint(self, i);
        if(!item) goto fail;
        PyList_SET_ITEM(out, j++, item);
    }

    // success
    return out;

fail:
    Py_CLEAR(out);
    return NULL;
}

static PyObject *py_value_mp_subscript(py_value_t *self, PyObject *key){
    PyObject *out = NULL;
    bool success = false;

    // handle string keys
    if(PyUnicode_Check(key)){
        const char *strkey = PyUnicode_AsUTF8(key);
        if(!strkey){
            goto done;
        }
        out = py_value_getstr(self, strkey);
        success = !!out;
        goto done;
    }

    // handle integer keys
    int isinstance;
    if((isinstance = PyObject_IsInstance(key, (PyObject*)&PyLong_Type))){
        if(isinstance < 0) goto done;
        Py_ssize_t index = PyLong_AsSsize_t(key);
        (void)index;
        if(index == -1 && PyErr_Occurred()) goto done;
        out = py_value_getint(self, index);
        success = !!out;
        goto done;
    }

    // handle slice keys
    if((isinstance = PyObject_IsInstance(key, (PyObject*)&PySlice_Type))){
        if(isinstance < 0) goto done;
        if(self->arrlen < 0){
            PyErr_SetString(PyExc_TypeError, "slices only supported on arrays");
            goto done;
        }
        Py_ssize_t start, stop, step;
        int ret = PySlice_Unpack(key, &start, &stop, &step);
        if(ret) goto done;
        out = py_value_array_to_list(self, start, stop, step);
        success = !!out;
        goto done;
    }

    (void)py_value_getint;
    PyErr_Format(PyExc_TypeError, "unexpected key type (%s)", Py_TYPE(key)->tp_name);

done:
    // It seems that you must not consume key
    // Py_CLEAR(key);
    if(!success) Py_CLEAR(out);
    return out;
}

PyMappingMethods py_value_as_mapping = {
    .mp_length = (lenfunc)py_value_mp_length,
    .mp_subscript = (binaryfunc)py_value_mp_subscript,
    .mp_ass_subscript = (objobjargproc)NULL, // mapping is immutable
};

// sequence methods

// sq_length takes priority over mp length
static Py_ssize_t py_value_sq_length(py_value_t *self){
    if(self->arrlen > -1) return self->arrlen;
    if(self->objlen == -1){
        PyObject *obj = iter_keys(self, objlenfunc);
        if(!obj) return -1;
        Py_CLEAR(obj);
    }
    return self->objlen;
}

static PyObject *py_value_sq_concat(py_value_t *self, PyObject *other){
    (void)self; (void)other;
    PyErr_SetString(PyExc_NotImplementedError, "concat not implemented");
    return NULL;
}

static PyObject *py_value_sq_repeat(py_value_t *self, Py_ssize_t count){
    (void)self; (void)count;
    PyErr_SetString(PyExc_NotImplementedError, "repeat not implemented");
    return NULL;
}

// mp_subscript takes priority
static PyObject *py_value_sq_item(py_value_t *self, Py_ssize_t index){
    (void)self; (void)index;
    PyErr_SetString(PyExc_NotImplementedError, "item not implemented");
    return NULL;
}


PySequenceMethods py_value_as_sequence = {
    .sq_length = (lenfunc)py_value_sq_length,
    .sq_concat = (binaryfunc)py_value_sq_concat,
    .sq_repeat = (ssizeargfunc)py_value_sq_repeat,
    .sq_item = (ssizeargfunc)py_value_sq_item,
};

// .__iter__() handler
static PyObject *py_value_tp_iter(py_value_t *self){
    PyObject *iterable = NULL;
    PyObject *out = NULL;

    if(self->arrlen < 0){
        // objects iterate over keys
        iterable = py_value_keys(self);
        if(!iterable) goto done;
    } else {
        // arrays iterate over values
        iterable = py_value_array_to_list(self, 0, self->arrlen, 1);
        if(!iterable) goto done;
    }

    out = PyObject_GetIter(iterable);

done:
    Py_CLEAR(iterable);
    return out;
}

// .__repr__() handler
static PyObject *py_value_tp_repr(py_value_t *self){
    if(self->arrlen > -1){
        // proxy object shall be a list
        PyObject *proxy = py_value_array_to_list(self, 0, self->arrlen, 1);
        if(!proxy) return NULL;
        PyObject *out = PyObject_Repr(proxy);
        Py_CLEAR(proxy);
        return out;
    }

    // don't render functions as '{}'
    if(JS_IsFunction(self->ctx, self->jsval)){
        return PyUnicode_FromString("<quickjs_function>");
    }

    // proxy object shall be a dict(self.items())
    PyObject *arg = py_value_items(self);
    if(!arg) return NULL;
    PyObject *proxy = PyObject_CallOneArg((PyObject*)&PyDict_Type, arg);
    Py_CLEAR(arg);
    if(!proxy) return NULL;
    PyObject *out = PyObject_Repr(proxy);
    Py_CLEAR(proxy);
    return out;
}

static PyMethodDef py_value_methods[] = {
    {
        .ml_name = "call",
        .ml_meth = (PyCFunction)(void*)py_value_call,
        .ml_flags = METH_VARARGS,
        .ml_doc = py_value_call_doc,
    },
    {
        .ml_name = "items",
        .ml_meth = (PyCFunction)(void*)py_value_items,
        .ml_flags = METH_NOARGS,
        .ml_doc = py_value_items_doc,
    },
    {
        .ml_name = "keys",
        .ml_meth = (PyCFunction)(void*)py_value_keys,
        .ml_flags = METH_NOARGS,
        .ml_doc = py_value_keys_doc,
    },
    {
        .ml_name = "values",
        .ml_meth = (PyCFunction)(void*)py_value_values,
        .ml_flags = METH_NOARGS,
        .ml_doc = py_value_values_doc,
    },
    {NULL}, // sentinel
};

static PyMemberDef py_value_members[] = {
    // {
    //     .name = "__dict__",
    //     .type = Py_T_OBJECT_EX,
    //     .offset = offsetof(py_value_t, dict),
    //     .flags = Py_READONLY,
    //     .doc = NULL,
    // },
    {NULL}, // sentinel
};

static PyTypeObject py_value_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_quickjs.Value",
    .tp_doc = "python wrapper around javascript object",
    .tp_basicsize = sizeof(py_value_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    /* note: when I use tp_flags |= Py_TPFLAGS_MANAGED_WEAKREF I always get a
       segfault, so we use the legacy weakref system here: */
    .tp_weaklistoffset = offsetof(py_value_t, weakreflist),

    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_value_dealloc,
    .tp_methods = py_value_methods,
    .tp_init = (initproc)py_value_init,
    .tp_getattro = (getattrofunc)py_value_getattro,
    .tp_call = (ternaryfunc)py_value_tp_call,
    .tp_as_mapping = &py_value_as_mapping,
    .tp_as_sequence = &py_value_as_sequence,
    .tp_members = py_value_members,
    .tp_iter = (getiterfunc)py_value_tp_iter,
    .tp_repr = (getiterfunc)py_value_tp_repr,
};

////

static void py_opaque_dealloc(py_opaque_t *self){
    Py_CLEAR(self->ref);
    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_opaque_init(py_opaque_t *self, PyObject *args, PyObject *kwds){
    self->ref = NULL;

    PyObject *ref;
    char *kwnames[] = { "ref", NULL };

    int ret = PyArg_ParseTupleAndKeywords(args, kwds, "O", kwnames, &ref);
    if(!ret) return -1;

    // we're keeping this
    Py_INCREF(ref);
    self->ref = ref;

    return 0;
}

static PyTypeObject py_opaque_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_quickjs.Opaque",
    .tp_doc = "mark a python object as opaque to javascript, avoiding any conversions",
    .tp_basicsize = sizeof(py_opaque_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_opaque_dealloc,
.tp_init = (initproc)py_opaque_init,
};

////

static py_cmem_t *new_cmem(char *mem, Py_ssize_t len){
    py_cmem_t *cmem = PyObject_New(py_cmem_t, &py_cmem_type);
    if(!cmem){
        free(mem);
        return NULL;
    }
    cmem->mem = mem;
    cmem->len = len;
    cmem->stride = 1;
    cmem->suboffset = -1;
    return cmem;
}

static void py_cmem_dealloc(py_cmem_t *self){
    if(self->mem) free(self->mem);
    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_cmem_init(py_cmem_t *self, PyObject *args, PyObject *kwds){
    (void)self;
    (void)args;
    (void)kwds;
    PyErr_SetString(PyExc_TypeError, "CMem can only be created in C code");
    return -1;
}

static int py_cmem_getbuffer(PyObject *exporter, Py_buffer *buf, int flags){
    py_cmem_t *cmem = (py_cmem_t*)exporter;
    if(flags & PyBUF_WRITABLE){
        PyErr_SetString(PyExc_BufferError, "CMem refuses to make writable views");
        goto fail;
    }

    if(flags & PyBUF_FORMAT) buf->format = "B";

    // we are returning a new reference as buf->obj
    Py_INCREF(exporter);

    *buf = (Py_buffer){
        .buf = cmem->mem,
        .obj = exporter,
        .len = cmem->len,
        .itemsize = 1,
        .readonly = 1,
        .ndim = 1,
        .format = flags & PyBUF_FORMAT ? "B" : NULL,
        .shape = &cmem->len,
        .strides = &cmem->stride,
        .suboffsets = &cmem->suboffset,
        .internal = NULL,
    };

    return 0;

fail:
    *buf = (Py_buffer){0};
    return -1;
}

static PyBufferProcs py_cmem_bufferprocs = {
    .bf_getbuffer = py_cmem_getbuffer,
    // memory is freed when the exporter is freed
    .bf_releasebuffer = NULL,
};

static PyTypeObject py_cmem_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    .tp_name = "_quickjs.CMem",
    .tp_doc = "a python buffer around preallocated C memory",
    .tp_basicsize = sizeof(py_cmem_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_cmem_dealloc,
    .tp_init = (initproc)py_cmem_init,
    .tp_as_buffer = &py_cmem_bufferprocs,
};

////

// pass a value or an exception to the store callback
static JSValue make_store_callback(JSContext *ctx, JSValueConst cb, JSValue value){
    JSValue out = JS_EXCEPTION;
    JSValue exc = JS_UNINITIALIZED;
    JSValue arg = JS_UNINITIALIZED;

    const char *key = "value";
    if(JS_IsException(value)){
        key = "err";
        // promote a python exception to a javascript one
        if(PyErr_Occurred()){
            py_exception(ctx);
        }
        // catch the javascript exception
        exc = JS_GetException(ctx);
        // we'll use this as the value
        value = JS_DupValue(ctx, exc);
    }

    // construct a StoreValue arg
    arg = JS_NewObject(ctx);
    if(JS_IsException(arg)) goto done;

    int ret = JS_DefinePropertyValueStr(ctx, arg, key, JS_DupValue(ctx, value), JS_PROP_C_W_E);
    if(ret < 0) goto done;

    // call the callback
    out = JS_Call(ctx, cb, JS_NULL, 1, &arg);

done:
    if(!JS_IsUninitialized(arg)) JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, value);
    if(!JS_IsUninitialized(exc)){
        // deal with the old exception
        if(JS_IsException(out)){
            // failed to pass the exception to the callback; re-throw it now
            JS_Throw(ctx, exc);
        }else{
            // we passed it along, we're done with it now
            JS_FreeValue(ctx, exc);
        }
    }
    return out;
}

// txn: (writable: boolean, cb: (result: StoreValue) => void) => unknown;
static JSValue store_txn(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValue *data
){
    (void)this_val;
    (void)argc;
    (void)magic;
    JSValueConst jswritable = argv[0];
    JSValueConst jscb = argv[1];
    // get closure variable
    PyObject *factory = JS_GetOpaque(data[0], js_pyref_class_id);

    PyObject *writable = NULL;
    PyObject *txn = NULL;
    JSValue out = JS_EXCEPTION;

    writable = js2py(ctx, jswritable, Py_None);
    if(!writable) goto done;

    // call txn factory
    txn = PyObject_CallFunctionObjArgs(factory, writable, NULL);
    if(!txn) goto done;

    // wrap in js
    Py_INCREF(txn);
    out = new_pyref(ctx, txn);
    if(JS_IsException(out)) goto done;

done:
    Py_XDECREF(writable);
    Py_XDECREF(txn);
    return make_store_callback(ctx, jscb, out);
}

// commit: (txn: unknown, cb: (result: StoreDone) => void) => void;
static JSValue store_commit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv){
    (void)this_val;
    (void)argc;
    PyObject *txn = JS_GetOpaque(argv[0], js_pyref_class_id);
    JSValueConst jscb = argv[1];

    PyObject *ret = NULL;
    JSValue out = JS_EXCEPTION;

    // just call txn.commit()
    ret = PyObject_CallMethod(txn, "commit", "()");
    if(!ret) goto done;

    out = JS_TRUE;

done:
    Py_XDECREF(ret);
    return make_store_callback(ctx, jscb, out);
}

// abort: (txn: unknown, cb: () => void) => void;
static JSValue store_abort(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv){
    (void)this_val;
    (void)argc;
    PyObject *txn = JS_GetOpaque(argv[0], js_pyref_class_id);
    JSValueConst jscb = argv[1];

    PyObject *ret = NULL;
    JSValue out = JS_EXCEPTION;

    // call txn.abort(); no error is allowed, no return value is accepted
    ret = PyObject_CallMethod(txn, "abort", "()");
    if(!ret){
        py_exception(ctx);
        goto done;
    }

    // call the callback with no arg
    out = JS_Call(ctx, jscb, JS_NULL, 0, NULL);

done:
    Py_XDECREF(ret);
    return out;
}

// get: (txn: unknown, key: string, cb: (result: StoreValue) => void) => void;
static JSValue store_get(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv){
    (void)this_val;
    (void)argc;
    PyObject *txn = JS_GetOpaque(argv[0], js_pyref_class_id);
    JSValueConst jskey = argv[1];
    JSValueConst jscb = argv[2];

    PyObject *key = NULL;
    PyObject *ret = NULL;
    Py_buffer buf;
    bool have_buf = false;
    JSValue out = JS_EXCEPTION;

    key = js2py(ctx, jskey, Py_None);
    if(!key) goto done;

    // call txn.get(key)
    ret = PyObject_CallMethod(txn, "get", "(O)", key);
    if(!ret){
        if(PyErr_ExceptionMatches((PyObject*)&PyExc_KeyError)){
            // convert KeyError to javascript undefined
            PyErr_Clear();
            // return `undefined`
            out = JS_UNDEFINED;
            goto done;
        }else{
            // any other error
            goto done;
        }
    }

    // get succeeded; convert bytes -> javascript
    int iret = PyObject_GetBuffer(ret, &buf, PyBUF_SIMPLE);
    if(iret) goto done;
    out = JS_ReadObject(ctx, buf.buf, (size_t)buf.len, JS_READ_OBJ_REFERENCE);
    if(JS_IsException(out)) goto done;

done:
    Py_XDECREF(key);
    Py_XDECREF(ret);
    if(have_buf) PyBuffer_Release(&buf);
    return make_store_callback(ctx, jscb, out);
}

// set: (txn: unknown, key: string, value: unknown, cb: (result: StoreDone) => void) => void;
static JSValue store_set(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv){
    (void)this_val;
    (void)argc;
    PyObject *txn = JS_GetOpaque(argv[0], js_pyref_class_id);
    JSValueConst jskey = argv[1];
    JSValueConst jsval = argv[2];
    JSValueConst jscb = argv[3];

    PyObject *key = NULL;
    PyObject *ret = NULL;
    PyObject *val = NULL;
    JSValue out = JS_EXCEPTION;

    key = js2py(ctx, jskey, Py_None);
    if(!key) goto done;

    // convert jsval to bytes
    size_t len;
    uint8_t *mem = JS_WriteObject(ctx, &len, jsval, JS_WRITE_OBJ_REFERENCE);
    if(!mem) goto done;

    // create python buffer wrapper around allocated memory
    val = (PyObject*)new_cmem((char*)mem, (Py_ssize_t)len);
    if(!val) goto done;

    // call txn.set(key, val)
    ret = PyObject_CallMethod(txn, "set", "(OO)", key, val);
    if(!ret) goto done;

    out = JS_TRUE;

done:
    Py_XDECREF(key);
    Py_XDECREF(val);
    Py_XDECREF(ret);
    return make_store_callback(ctx, jscb, out);
}

// del: (txn: unknown, key: string, cb: (result: StoreDone) => void) => void;
static JSValue store_del(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv){
    (void)this_val;
    (void)argc;
    PyObject *txn = JS_GetOpaque(argv[0], js_pyref_class_id);
    JSValueConst jskey = argv[1];
    JSValueConst jscb = argv[2];

    PyObject *key = NULL;
    PyObject *ret = NULL;
    JSValue out = JS_EXCEPTION;

    key = js2py(ctx, jskey, Py_None);
    if(!key) goto done;

    // call txn.del(key)
    ret = PyObject_CallMethod(txn, "del", "(O)", key);
    if(!ret) goto done;

    out = JS_TRUE;

done:
    Py_XDECREF(key);
    Py_XDECREF(ret);
    return make_store_callback(ctx, jscb, out);
}

static char * const py_make_store_doc =
    "make_store(txn_factory: Callable[[bool], Txn]) -> Store\n"
    "create a Store object from a txn factory";
static PyObject *py_make_store(PyObject *self, PyObject *args, PyObject *kwds) {
    (void)self;
    PyObject *qjs;
    PyObject *factory;
    char *kwnames[] = { "qjs", "txn_factory", NULL };
    int ret = PyArg_ParseTupleAndKeywords(args, kwds, "OO", kwnames, &qjs, &factory);
    if(!ret) return NULL;

    int isinstance;
    if((isinstance = PyObject_IsInstance(qjs, (PyObject*)&py_quickjs_type))){
        if(isinstance < 0) return NULL;
    } else {
        PyErr_SetString(PyExc_TypeError, "first parameter must be QuickJS object");
        return NULL;
    }
    JSContext *ctx = ((py_quickjs_t*)qjs)->ctx;

    // construct an javascript ExternalCallbackStore class from callbacks defined in python
    JSValue global = JS_UNINITIALIZED;
    JSValue cls = JS_UNINITIALIZED;
    JSValue jsargs[6];
    JSValue jsfactory = JS_UNINITIALIZED;
    int nargs = 0;
    JSValue jsout = JS_UNINITIALIZED;
    PyObject *out = NULL;

    // get the constructor from the context
    global = JS_GetGlobalObject(ctx);
    if(JS_IsException(global)) goto jsfail;
    cls = JS_GetPropertyStr(ctx, global, "ExternalCallbackStore");
    if(JS_IsException(cls)) goto jsfail;

    // txn arg is a closure defined in C
    Py_INCREF(factory);
    jsfactory = new_pyref(ctx, factory);
    if(JS_IsException(jsfactory)) goto jsfail;
    JSValue jsfunc = JS_NewCFunctionData(ctx, store_txn, 2, 0, 1, &jsfactory);
    if(JS_IsException(jsfunc)) goto jsfail;
    jsargs[nargs++] = jsfunc;

    // remaining args are plain wrappers around C functions
    #define WRAP_SIMPLE(func, name, nparams) do { \
        JSValue jsfunc = JS_NewCFunction(ctx, func, name, nparams); \
        if(JS_IsException(jsfunc)) goto jsfail; \
        jsargs[nargs++] = jsfunc; \
    } while(0)
    WRAP_SIMPLE(store_commit, "commit", 2);
    WRAP_SIMPLE(store_abort, "abort", 2);
    WRAP_SIMPLE(store_get, "get", 3);
    WRAP_SIMPLE(store_set, "set", 4);
    WRAP_SIMPLE(store_del, "delete", 3);
    #undef WRAP_SIMPLE

    // call constructor and return result
    jsout = JS_CallConstructor(ctx, cls, nargs, jsargs);
    if(JS_IsException(jsout)) goto jsfail;

    out = py_value_new(ctx, jsout, Py_None);
    goto done;

jsfail:
    js_exception(ctx);

done:
    for(int i = 0; i < nargs; i++) JS_FreeValue(ctx, jsargs[i]);
    if(!JS_IsUninitialized(jsfactory)) JS_FreeValue(ctx, jsfactory);
    if(!JS_IsUninitialized(cls)) JS_FreeValue(ctx, cls);
    if(!JS_IsUninitialized(global)) JS_FreeValue(ctx, global);
    if(!JS_IsUninitialized(jsout)) JS_FreeValue(ctx, jsout);
    return out;
}

#define ARG_KWARG_FN_CAST(fn)\
    (PyCFunction)(void(*)(void))(fn)

static PyMethodDef _quickjs_methods[] = {
    {
        .ml_name = "make_store",
        .ml_meth = ARG_KWARG_FN_CAST(py_make_store),
        .ml_flags = METH_VARARGS | METH_KEYWORDS,
        .ml_doc = py_make_store_doc,
    },
    {0},  // sentinel
};

// anonymous c function for injecting custom __str__ into QuickJSError

static char * const py_quickjs_error_str_doc = "_quickjs_error_str(self) -> str";
static PyObject *py_quickjs_error_str(PyObject *junk, PyObject *args) {
    (void)junk;

    PyObject *self;
    int ret = PyArg_ParseTuple(args, "O", &self);
    if(!ret) return NULL;

    PyObject *etuple = PyObject_GetAttrString(self, "args");
    if(!etuple){
        PyErr_Clear();
        return PyObject_Repr(Py_None);
    }

    if(PyTuple_GET_SIZE(etuple) < 1){
        Py_XDECREF(etuple);
        return PyObject_Repr(Py_None);
    }
    py_value_t *borrowed = (py_value_t*)PyTuple_GetItem(etuple, 0);
    Py_XDECREF(etuple);

    // call show_stack function to render javascript stack
    JSContext *ctx = borrowed->ctx;
    py_quickjs_t *q = JS_GetContextOpaque(ctx);
    JSValue result = JS_Call(ctx, q->show_stack, JS_NULL, 1, &borrowed->jsval);
    if(JS_IsException(result)){
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        return PyUnicode_FromString("<exception when formatting javascript stack>");
    }

    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, result);
    if(!str){
        JSValue exc = JS_GetException(ctx);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, result);
        return PyUnicode_FromString("<exception when extracting formatted javascript stack>");
    }
    PyObject *out = PyUnicode_FromStringAndSize(str, (Py_ssize_t)len);
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, result);
    return out;
}

static PyMethodDef py_quickjs_error_str_def = {
    .ml_name = "_quickjs_error_str",
    .ml_meth = ARG_KWARG_FN_CAST(py_quickjs_error_str),
    .ml_flags = METH_VARARGS,
    .ml_doc = py_quickjs_error_str_doc,
};

static struct PyModuleDef _quickjs_module = {
    PyModuleDef_HEAD_INIT,
    .m_name = "_quickjs",
    .m_doc = "python bindings to quickjs",
    // XXX we don't have global state...?
    .m_size = -1, /* size of per-interpreter state of the module,
                     or -1 if the module keeps state in global variables. */
    .m_methods = _quickjs_methods,
};

// main entrypoint for python module
PyObject* PyInit__quickjs(void);
PyObject* PyInit__quickjs(void){
    // import datetime (C api)
    PyDateTime_IMPORT;
    if (PyErr_Occurred()) return NULL;

    if (PyType_Ready(&py_quickjs_type) < 0) return NULL;
    if (PyType_Ready(&py_value_type) < 0) return NULL;
    if (PyType_Ready(&py_opaque_type) < 0) return NULL;
    if (PyType_Ready(&py_cmem_type) < 0) return NULL;
    int ret;

    PyObject *func = NULL;
    PyObject *meth = NULL;
    PyObject *dict = NULL;
    PyObject *copymodule = NULL;
    PyObject *copyfunc = NULL;
    PyObject *uuidmodule = NULL;
    PyObject *uuid4func = NULL;

    PyObject *module = PyModule_Create(&_quickjs_module);
    if (module == NULL){
        return NULL;
    }

    Py_INCREF((PyObject*)&py_quickjs_type);
    ret = PyModule_AddObject(module, "QuickJS", (PyObject*)&py_quickjs_type);
    if(ret < 0) goto fail;

    Py_INCREF((PyObject*)&py_value_type);
    ret = PyModule_AddObject(module, "Value", (PyObject*)&py_value_type);
    if(ret < 0) goto fail;

    Py_INCREF((PyObject*)&py_opaque_type);
    ret = PyModule_AddObject(module, "Opaque", (PyObject*)&py_opaque_type);
    if(ret < 0) goto fail;

    Py_INCREF((PyObject*)&py_cmem_type);
    ret = PyModule_AddObject(module, "CMem", (PyObject*)&py_cmem_type);
    if(ret < 0) goto fail;

    // configure a custom __str__ for our exception class
    func = PyCFunction_New(&py_quickjs_error_str_def, Py_None);
    if(!func) goto fail;
    meth = PyInstanceMethod_New(func);
    Py_CLEAR(func);
    if(!meth) goto fail;
    dict = PyDict_New();
    if(!dict) goto fail;
    ret = PyDict_SetItemString(dict, "__str__", meth);
    Py_CLEAR(meth);
    if(ret < 0) goto fail;

    quickjs_error = PyErr_NewException("_quickjs.QuickJSError", NULL, dict);
    Py_CLEAR(dict);
    if(!quickjs_error) goto fail;
    Py_INCREF(quickjs_error);
    ret = PyModule_AddObject(module, "QuickJSError", quickjs_error);
    if(ret < 0) goto fail;

    // also import a the copy module and grab its .copy function
    copymodule = PyImport_ImportModule("copy");
    if(!copymodule) goto fail;
    copyfunc = PyObject_GetAttrString(copymodule, "copy");
    if(!copyfunc) goto fail;
    copy_copy_weakref = PyWeakref_NewRef(copyfunc, NULL);
    Py_CLEAR(copyfunc);
    if(!copy_copy_weakref) goto fail;

    // and import a the uuid module and grab its .uuid4 function
    uuidmodule = PyImport_ImportModule("uuid");
    if(!uuidmodule) goto fail;
    uuid4func = PyObject_GetAttrString(uuidmodule, "uuid4");
    Py_CLEAR(uuidmodule);
    if(!uuid4func) goto fail;
    uuid_uuid4_weakref = PyWeakref_NewRef(uuid4func, NULL);
    Py_CLEAR(uuid4func);
    if(!uuid_uuid4_weakref) goto fail;

    return module;

fail:
    Py_XDECREF(uuid4func);
    Py_XDECREF(uuidmodule);
    Py_XDECREF(copyfunc);
    Py_XDECREF(copymodule);
    Py_XDECREF(dict);
    Py_XDECREF(meth);
    Py_XDECREF(func);
    Py_XDECREF(quickjs_error);
    Py_XDECREF((PyObject*)&py_cmem_type);
    Py_XDECREF((PyObject*)&py_opaque_type);
    Py_XDECREF((PyObject*)&py_value_type);
    Py_XDECREF((PyObject*)&py_quickjs_type);
    Py_XDECREF(module);
    return NULL;
}
