#ifdef __GNUC__
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Warray-bounds"
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif // __GNUC__

#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include "quickjs/quickjs.h"

#ifdef __GNUC__
#pragma GCC diagnostic pop
#endif // __GNUC__

#include <stdio.h>
#include <stddef.h>

static PyObject *quickjs_error;

// sets a python exception and returns NULL
static PyObject *js_exception(JSContext *ctx) {
    JSValue exc = JS_GetException(ctx);
    size_t slen = 0;
    const char *str = JS_ToCStringLen(ctx, &slen, exc);
    if (str) {
        PyErr_SetObject(quickjs_error, PyUnicode_FromStringAndSize(str, (Py_ssize_t)slen));
    } else {
        PyErr_SetString(quickjs_error, "unidentified exception raised by quickjs");
    }
    JS_FreeValue(ctx, exc);
    return NULL;
}

#define CONTAINER_OF(ptr, structure, member) \
    ((structure*)_container_of(ptr, offsetof(structure, member)))
static inline void *_container_of(const void *ptr, size_t offset){
    return (void*)(((uintptr_t)ptr - offset) * (ptr != 0));
}

// js_pyweakref is our tiny javascript class that holds a python weakref for caching js2py()
static JSClassID js_pyweakref_class_id;

// js_pyref is an opaque wrapper around an arbitrary python object
static JSClassID js_pyref_class_id;

static void js_pyobj(JSRuntime *rt, JSValue val)
{
    (void)rt;
    PyObject *weakref = JS_GetOpaque(val, js_pyweakref_class_id);
    // we just need to release the decref is all
    Py_XDECREF(weakref);
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

// c-only allocator for new _quickjs.Value objects
static PyObject *py_value_new(JSContext *ctx, JSValue jsval, PyObject *this);

static PyTypeObject py_quickjs_type;
static PyTypeObject py_value_type;

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
            return PyUnicode_FromStringAndSize(s, (Py_ssize_t)len);
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
            PyErr_SetString(quickjs_error, "unsupported type");
            return NULL;
    }

    // first: check if object is a pyref, which we can return immediately
    PyObject *out = JS_GetOpaque(val, js_pyref_class_id);
    if(out){
        Py_INCREF(out);
        return out;
    }

    // more sophisticated types get more cleanup
    bool success = false;
    PyObject *pywr = NULL;
    JSValue jswr = JS_UNINITIALIZED;

    // next: check if we have a weakref to a working python object
    py_quickjs_t *q = JS_GetContextOpaque(ctx);
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
        goto embed_weakref;
    }

    // must be a plain object
    out = py_value_new(ctx, val, Py_None);

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
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValue *data,
){
    PyObject *func = NULL;
    PyObject *args = NULL;
    PyObject *retval = NULL;
    JSValue out = JS_EXCEPTION;
    bool success = false;

    // extract closure variables (borrowed)
    PyObject *func = JS_GetOpaque(data[0], js_pyref_class_id);

    // extract args
    args = PyTuple_New((Py_ssize_t)argc);
    if(!out){
        py_exception(ctx);
        goto done;
    }
    for(int i = 0; i < argc; i++){
        PyObject *arg = js2py(argv[i]);
        if(!arg){
            py_exception(ctx);
            goto done;
        }
        PyTuple_SET_ITEM(out, (Py_ssize_t)i, arg);
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
    Py_CLEAR(func);
    Py_CLEAR(args);
    Py_CLEAR(retval);
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
        if(isinstance < 0) goto done;
        Py_ssize_t len;
        const char *str = PyUnicode_AsUTF8AndSize(val, &len);
        return JS_NewStringLen(ctx, str, (size_t)len);
    }

    // is object a _quickjs.Value?
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&py_value_type))){
        if(isinstance < 0) goto done;
        // just return the underlying object
        return JS_DupValue(ctx, ((py_value_t*)val)->jsval);
    }

    PyObject *items = NULL;
    PyObject *fast = NULL;
    JSValue jsout = JS_EXCEPTION;

    bool success = false;

    // is object a list or a tuple?
    if(
        PyObject_IsInstance(val, (PyObject*)&PyList_Type)
        || PyObject_IsInstance(val, (PyObject*)&PyTuple_Type)
    ){
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
            if(ret){
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
        Py_ssize_t len = PyList_GET_SIZE(fast);
        for(Py_ssize_t i = 0; i < len; i++){
            // kv, key, and value are all borrowed
            PyObject *kv = PyList_GET_ITEM(items, i);
            PyObject *pykey = PyTuple_GET_ITEM(kv, 0);
            PyObject *pyval = PyTuple_GET_ITEM(kv, 1);
            // key must be a string
            isinstance = PyObject_IsInstance(val, (PyObject*)&PyUnicode_Type);
            if(isinstance < 0) goto done;
            if(!isinstance){
                PyErr_SetString(quickjs_error, "only string keys are allowed on dict objects");
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
            if(ret){
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

    PyErr_SetString(quickjs_error, "unsupported type in python->javascript conversion");

done:
    Py_CLEAR(items);
    Py_CLEAR(fast);
    if(!success){
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

    JS_SetPropertyStr(ctx, console, "log", log);
    JS_SetPropertyStr(ctx, global, "console", console);
    console = JS_UNINITIALIZED;

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
        if(self->weakref_symbol) JS_FreeAtom(self->ctx, self->weakref_symbol);
        if(self->ctx) JS_FreeContext(self->ctx);
        self->ctx = NULL;
        JS_FreeRuntime(self->rt);
        self->rt = NULL;
    }
    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_quickjs_init(py_quickjs_t *self, PyObject *args, PyObject *kwds){
    self->weakref_symbol = JS_ATOM_NULL;

    char *kwnames[] = { NULL };

    int ret = PyArg_ParseTupleAndKeywords(args, kwds, "", kwnames);
    if(!ret) return -1;

    self->rt = JS_NewRuntime();
    if(!self->rt) {
        PyErr_SetString(quickjs_error, "JS_NewRuntime() failed");
        return -1;
    }

    self->ctx = JS_NewContext(self->rt);
    if(!self->ctx) {
        PyErr_SetString(quickjs_error, "JS_NewContext() failed");
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

    // create a new javascript classes
    JS_NewClassID(&js_pyweakref_class_id);
    ret = JS_NewClass(self->rt, js_pyweakref_class_id, &js_pyweakref_class);
    if(ret < 0){
        PyErr_SetString(quickjs_error, "failed to create PyWeakRef javascript class");
        return -1;
    }

    JS_NewClassID(&js_pyref_class_id);
    ret = JS_NewClass(self->rt, js_pyref_class_id, &js_pyref_class);
    if(ret < 0){
        PyErr_SetString(quickjs_error, "failed to create PyRef javascript class");
        return -1;
    }

    // remember this struct for later
    JS_SetContextOpaque(self->ctx, self);

    return 0;
}

static char * const py_quickjs_eval_doc =
    "eval(script: string, flags=0) -> JSAny\n"
    "eval script and return result";
static PyObject *py_quickjs_eval(py_quickjs_t *self, PyObject *args, PyObject *kwds){
    const char *script;
    int flags = 0;

    char *kwnames[] = {
        "script",
        "flags",
        NULL,
    };

    int ret = PyArg_ParseTupleAndKeywords(
        args, kwds, "s|i", kwnames,
        &script,
        &flags
    );
    if(!ret) return NULL;

    JSValue val = JS_Eval(self->ctx, script, strlen(script), "script", flags);
    if(JS_IsException(val)) return js_exception(self->ctx);

    PyObject *out = js2py(self->ctx, val, Py_None);
    JS_FreeValue(self->ctx, val);
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
    class Value(list):
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
        py_value_dealloc(out);
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
    Py_CLEAR(args);
    Py_CLEAR(kwds);
    PyErr_SetString(quickjs_error, "Value can only be created in C code");
    return -1;
}

static PyObject *py_value_getstr(py_value_t *self, const char *key){
    PyObject *out = NULL;
    JSValue jsval = JS_UNINITIALIZED;
    bool success = false;

    // check cache
    out = PyDict_GetItemString(self->cache, key);
    if(out){
        // cache hit
        Py_INCREF(out); // result was borrowed
        success = true;
        goto done;
    }

    jsval = JS_GetPropertyStr(self->ctx, self->jsval, key);
    if(JS_IsException(jsval)){
        js_exception(self->ctx);
        goto done;
    }

    // did we get something?
    if(JS_IsUndefined(jsval)){
        PyErr_SetString(PyExc_AttributeError, "no such key");
        goto done;
    }

    // convert to python object; functions get an embedded `this` pointing to us
    out = js2py(self->ctx, jsval, (PyObject*)self);

    // Cache all types on self.  If there is a circular reference in javascript, we can create
    // space leaks in python since we haven't enabling GC on this python object.  But that seems
    // unlikely, at least for now.
    Py_INCREF(out);
    int ret = PyDict_SetItemString(self->cache, key, out);
    if(ret) goto done;

    success = true;

done:
    if(!JS_IsUninitialized(jsval)) JS_FreeValue(self->ctx, jsval);
    if(!success) Py_CLEAR(out);

    return out;
}

static PyObject *py_value_getint(py_value_t *self, Py_ssize_t index){
    if(index > UINT32_MAX){
        PyErr_SetString(quickjs_error, "index too large");
        return NULL;
    }
    // array negative index handling
    if(index < 0) {
        PyErr_SetString(quickjs_error, "negative index not allowed");
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
    Py_INCREF(pykey);
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

    // Cache all types on self.  If there is a circular reference in javascript, we can create
    // space leaks in python since we haven't enabling GC on this python object.  But that seems
    // unlikely, at least for now.
    Py_INCREF(pykey);
    Py_INCREF(out);
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

// base implementation; consumes this and args (even if skip is nonzero)
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
    jsargs = malloc(sizeof(*jsargs) * (size_t)(nargs - skip));
    if(!jsargs){
        PyErr_SetString(quickjs_error, "error allocating memory for call");
        goto done;
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
    // mark all args as consumed
    iargs = 0;
    if(JS_IsException(jsret)){
        js_exception(self->ctx);
        goto done;
    }

    // convert return value to python
    out = js2py(self->ctx, jsret, Py_None);

done:
    if(!JS_IsUndefined(jsthis)) JS_FreeValue(self->ctx, jsthis);
    if(!JS_IsUndefined(jsret)) JS_FreeValue(self->ctx, jsret);
    // free any args we converted
    for(Py_ssize_t i = 0; i < iargs; i++) JS_FreeValue(self->ctx, jsargs[i]);
    // free the args array
    if(jsargs) free(jsargs);
    // discard provided values
    Py_CLEAR(args);
    return out;

}

// .__call__(...) handler
static PyObject *py_value_tp_call(py_value_t *self, PyObject *args, PyObject *kwargs){
    // check that args are all positional
    if(kwargs != NULL && PyDict_Size(kwargs) != 0){
        PyErr_SetString(quickjs_error, "javascript functions only support positional args");
        Py_CLEAR(args);
        Py_CLEAR(kwargs);
        return NULL;
    }

    // use built-in this
    Py_INCREF(self->this);
    return call_function(self, self->this, args, 0);
}

static char * const py_value_call_doc =
    "call(this, ...) -> JSAny\n"
    "call a javascript function with explicit `this`";
static PyObject *py_value_call(py_value_t *self, PyObject *args){
    Py_ssize_t nargs = PyTuple_GET_SIZE(args);
    if(nargs < 1){
        Py_CLEAR(args);
        PyErr_SetString(quickjs_error, ".call() requires a `this` parameter");
        return NULL;
    }

    // extract the first parameter and prepare it to be double-freed
    PyObject *this = PyTuple_GetItem(args, 0);
    if(!this){
        Py_CLEAR(args);
        return NULL;
    }
    Py_INCREF(this);

    // let the function args be all the remaining parameters
    return call_function(self, this, args, 1);
}

// mapping methods

typedef PyObject *(*iter_key_fn)(py_value_t *self, JSPropertyEnum *props, uint32_t len);
static PyObject *iter_keys(py_value_t *self, iter_key_fn func){
    PyObject *out = NULL;
    bool success = false;

    JSPropertyEnum *props;
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
    JS_FreePropertyEnum(self->ctx, props, len);
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
        val = desc.value;

        PyObject *pykey = js2py(self->ctx, key, Py_None);
        if(!pykey) goto done;

        PyObject *pyval = js2py(self->ctx, val, Py_None);
        if(!pyval){
            Py_CLEAR(pykey);
            goto done;
        }
        PyObject *pair = PyTuple_Pack(2, pykey, pyval);
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
        val = desc.value;

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

// sq_length takes priority over mp length
static Py_ssize_t py_value_mp_length(py_value_t *self){
    (void)self;
    PyErr_SetString(quickjs_error, "length not implemented");
    return -1;
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
            PyErr_Format(quickjs_error, "slices only supported on arrays");
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

static PyObject *objlenfunc(py_value_t *self, JSPropertyEnum *props, uint32_t len){
    (void)self;
    (void)props;
    (void)len;
    // nothing to do; just needed to trigger an object length check
    Py_RETURN_NONE;
}

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
    PyErr_SetString(quickjs_error, "concat not implemented");
    return NULL;
}

static PyObject *py_value_sq_repeat(py_value_t *self, Py_ssize_t count){
    (void)self; (void)count;
    PyErr_SetString(quickjs_error, "repeat not implemented");
    return NULL;
}

// mp_subscript takes priority
static PyObject *py_value_sq_item(py_value_t *self, Py_ssize_t index){
    (void)self; (void)index;
    PyErr_SetString(quickjs_error, "item not implemented");
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
        return PyObject_Repr(proxy);
    }

    // don't render functions as '{}'
    if(JS_IsFunction(self->ctx, self->jsval)){
        return PyUnicode_FromString("<function>");
    }

    // proxy object shall be a dict(self.items())
    PyObject *arg = py_value_items(self);
    if(!arg) return NULL;
    PyObject *proxy = PyObject_CallOneArg((PyObject*)&PyDict_Type, arg);
    Py_CLEAR(arg);
    if(!proxy) return NULL;
    return PyObject_Repr(proxy);
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

// implements then .next() function of a generator, so:
// (val: any) => {value: any, done: boolean}
static JSValue _js_querynext(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValue *data,
){
    PyObject *val = NULL;
    PyObject *args = NULL;
    PyObject *result = NULL;
    JSValue jsdone = JS_UNINITIALIZED;
    JSValue jsret = JS_UNINITIALIZED;
    JSValue out = JS_EXCEPTION;
    bool success = false;

    // extract closure variable (borrowed)
    PyObject *pynext = JS_GetOpaque(data[0], js_pyref_class_id);

    // extract arg
    val = js2py(argv[0]);
    if(!val){
        py_exception(ctx);
        goto done;
    }

    // call python next(val) -> (done, retval)
    args = Py_BuildValue("(O)", val);
    if(!args){
        py_exception(ctx);
        goto done;
    }
    PyObject *result = PyObject_Call(pynext, args, NULL);
    if(!result){
        py_exception(ctx);
        goto done;
    }

    // extract result = (done, retval) (borrowed)
    PyObject *done_borrowed = Py_Tuple_GET_ITEM(result, 0);
    PyObject *retval_borrowed = Py_Tuple_GET_ITEM(result, 1);

    // convert result to javascript
    jsdone = py2js(ctx, done_borrowed);
    if(JS_IsException(jsdone)) goto done;
    if(done != Py_True){
        // yielded values get py2js treatement
        jsret = py2js(ctx, retval_borrowed);
    }else{
        // final values are opaque references
        Py_INCREF(retval_borrowed);
        jsret = py2js(retval_borrowed);
    }
    if(JS_IsException(jsret)) goto done;

    // return suitable javascript object ({done, value})
    out = JS_NewObject(ctx);
    if(JS_IsException(out)) goto done;
    int ret = JS_DefinePropertyValueStr(ctx, out, "done", jsdone, JS_PROP_C_W_E);
    if(ret < 0) goto done;
    ret = JS_DefinePropertyValueStr(ctx, out, "value", jsret, JS_PROP_C_W_E);
    if(ret < 0) goto done;

    success = true;

done:
    Py_CLEAR(val);
    Py_CLEAR(args);
    Py_CLEAR(result);
    if(!JS_IsUninitialized(jsdone)) JS_FreeValue(jsdone);
    if(!JS_IsUninitialized(jsret)) JS_FreeValue(jsret);
    if(!success && !JS_IsException(out)){
        JS_FreeValue(out);
        out = JS_EXCEPTION;
    }
    return out;
}

// implements a QueryFunction,
// where QueryFunction = (qx, prev, prevIsValid) => QueryGenerator
// where QueryGenerator = Generator<QueryQuestion, T, QueryAnswer>;
static JSValue _js_queryfunc(
    JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic, JSValue *data,
){
    PyObject *prev = NULL;
    PyObject *is_valid = NULL;
    PyObject *args = NULL;
    PyObject *pynext = NULL;
    JSValue nextref = JS_UNINITIALIZED;
    JSValue jsnext = JS_UNINITIALIZED;
    JSValue out = JS_EXCEPTION;
    bool success = false;

    // extract closure variables (borrowed)
    PyObject *pyqx = JS_GetOpaque(data[0], js_pyref_class_id);
    PyObject *pyqueryfunc = JS_GetOpaque(data[1], js_pyref_class_id);

    // extract args
    prev = js2py(argv[1]);
    if(!prev){
        py_exception(ctx);
        goto done;
    }

    is_valid = js2py(argv[1]);
    if(!prev){
        py_exception(ctx);
        goto done;
    }

    // invoke python call() to get a python next()
    args = Py_BuildValue("(OOO)", pyqx, prev, is_valid);
    if(!args){
        py_exception(ctx);
        goto done;
    }
    PyObject *pynext = PyObject_Call(pyqueryfunc, args, NULL);

    // prepare closure variables
    Py_INCREF(pynext);
    nextref = new_pyref(ctx, pynext);
    if(JS_IsException(nextref)) goto done;

    // create a javascript nextfunc in C
    JSValue jsnext = JS_NewCFunctionData(ctx, _js_querynext, 1, 0, 1, &nextref);
    if(JS_IsException(jsnext)) goto done;

    // create javascript iterator object ({next})
    out = JS_NewObject(ctx);
    if(JS_IsException(out)) goto done;
    int ret = JS_DefinePropertyValueStr(ctx, out, "next", jsnext, JS_PROP_C_W_E);
    if(ret < 0) goto done;

    success = true;

done:
    Py_CLEAR(prev);
    Py_CLEAR(is_valid);
    Py_CLEAR(args);
    Py_CLEAR(pynext);
    if(!JS_IsUninitialized(jsnext)) JS_FreeValue(ctx, jsnext);
    if(!success && !JS_IsException(out)){
        JS_FreeValue(out);
        out = JS_EXCEPTION;
    }
    return out;
}

static PyObject *py_new_query(PyObject *self, PyObject *const *args, Py_ssize_t nargs){
    JSValue newQuery = JS_UNINITIALIZED;
    JSValue _query = JS_UNINITIALIZED;
    PyObject *out = NULL;

    // validate inputs
    if(nargs != 3){
        PyErr_SetString(PyExc_TypeError, "_new_query() requires exactly 3 args");
        goto done;
    }
    int isinstance;
    if((isinstance = PyObject_IsInstance(val, (PyObject*)&py_value_type))){
        if(isinstance < 0) goto done;
    }else {
        PyErr_SetString(PyExc_TypeError, "_new_query() first arg must be a framework value");
        goto done;
    }

    const py_value_t *framework = (const py_value_t*)args[0];
    const PyObject *pyqx = args[1];
    const PyObject *pyqueryfunc = args[2];

    JSContext *ctx = framework->ctx;

    // prepare closure values
    Py_INCREF(pyqx);
    JSValue qxref = new_pyref(ctx, pyqx);
    if(JS_IsException(qxref)) goto done;

    Py_INCREF(pyqueryfunc);
    JSValue callref = new_pyref(ctx, pyqueryfunc);
    if(JS_IsException(callref)) goto done;

    // create a javascript queryfunc in C
    JSValue data[] = {qxref, callref};
    JSValue queryfunc = JS_NewCFunctionData(ctx, _js_queryfunc, 3, 0, 2, &data);
    if(JS_IsException(queryfunc)){
        js_exception(ctx);
        goto done;
    }

    // get .newQuery method of framework
    newQuery = JS_GetProperty(ctx, framework->jsval, "newQuery");
    if(JS_IsException(newQuery)){
        js_exception(ctx);
        goto done;
    }

    // call _query = framework.newQuery(queryfunc)
    _query = JS_Call(ctx, newQuery, framework->jsval, 1, &queryfunc);
    if(JS_IsException(_query)){
        js_exception(ctx);
        goto done;
    }

    // return _query
    out = js2py(ctx, _query);
    if(out == NULL) goto done;

done:
    if(!JS_IsUninitialized(newQuery)) JS_FreeValue(newQuery);
    if(!JS_IsUninitialized(_query)) JS_FreeValue(_query);
    return out;
}

////

#define ARG_KWARG_FN_CAST(fn)\
    (PyCFunction)(void(*)(void))(fn)

static PyMethodDef _quickjs_methods[] = {
    {
        .ml_name = "eval",
        .ml_meth = (PyCFunction)(void*)py_quickjs_eval,
        .ml_flags = METH_FASTCALL,
        .ml_doc = py_quickjs_eval_doc,
    },
    {0},  // sentinel
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
    if (PyType_Ready(&py_quickjs_type) < 0) return NULL;
    if (PyType_Ready(&py_value_type) < 0) return NULL;
    int ret;

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

    quickjs_error = PyErr_NewException("_quickjs.QuickJSError", NULL, NULL);
    Py_INCREF(quickjs_error);
    ret = PyModule_AddObject(module, "QuickJSError", quickjs_error);
    if(ret < 0) goto fail;

    return module;

fail:
    Py_XDECREF((PyObject*)&quickjs_error);
    Py_XDECREF((PyObject*)&py_value_type);
    Py_XDECREF((PyObject*)&py_quickjs_type);
    Py_XDECREF(module);
    return NULL;
}
