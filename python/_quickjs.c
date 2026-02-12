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

static JSClassID js_py_weakref_class_id;

// js_py_weakref is our tiny javascript class that holds a python weakref for caching js2py()
static void js_py_weakref_finalizer(JSRuntime *rt, JSValue val)
{
    (void)rt;
    PyObject *weakref = JS_GetOpaque(val, js_py_weakref_class_id);
    // we just need to release the decref is all
    Py_XDECREF(weakref);
}

static JSClassDef js_py_weakref_class = {
    "PyWeakRf",
    .finalizer = js_py_weakref_finalizer,
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
    PyObject *dict;
    PyObject *cache;
    PyObject *this;  // for functions
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

    // more sophisticated types get more cleanup
    bool success = false;
    PyObject *out = NULL;
    PyObject *pywr = NULL;
    JSValue jswr = JS_UNINITIALIZED;

    // first: check if we have a weakref to a working python object
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
        pywr = JS_GetOpaque(jswr, js_py_weakref_class_id);
        // is the python weakref healthy?
        out = PyWeakref_GetObject(pywr);
        if(out == NULL){
            goto done;
        }
        if (out != Py_None) {
            // python object still healthy
            Py_INCREF(out);
            success = true;
            goto done;
        } else {
            // python object is gone; discard weakref
            Py_CLEAR(pywr);
            Py_CLEAR(out);
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
        jswr = JS_NewObjectClass(ctx, (int)js_py_weakref_class_id);
        if(JS_IsException(jswr)){
            js_exception(ctx);
            goto done;
        }
    }
    JS_SetOpaque(jswr, pywr);
    // pywr reference now owned by jswr
    pywr = NULL;

    // store the py_weakref on the value before returning
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
    JSValue jsout = JS_UNINITIALIZED;

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

    // create a new symbol; seems to only be possible in javascript
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

    // create a new javascript class
    JS_NewClassID(&js_py_weakref_class_id);
    ret = JS_NewClass(self->rt, js_py_weakref_class_id, &js_py_weakref_class);
    if(ret < 0){
        PyErr_SetString(quickjs_error, "failed to create PyWeakref javascript class");
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
    Py_CLEAR(self->dict);
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
    out->dict = NULL;
    out->this = this; Py_INCREF(this);
    out->jsval = JS_UNINITIALIZED;
    // we keep a reference to the QuickJS so we free our data before QuickJS
    // frees the js context
    Py_INCREF((PyObject*)JS_GetContextOpaque(ctx));

    // increment reference count to save our parameter
    JSValue dup = JS_DupValue(ctx, jsval);
    if(JS_IsException(dup)){
        js_exception(ctx);
        goto fail;
    }
    out->jsval = dup;

    out->dict = PyDict_New();
    if(!out->dict){
        py_value_dealloc(out);
        goto fail;
    }

    return (PyObject*)out;

fail:
    py_value_dealloc(out);
    return NULL;
}

static int py_value_init(py_value_t *self, PyObject *args, PyObject *kwds){
    self->ctx = NULL;
    self->jsval = JS_UNINITIALIZED;
    self->weakreflist = NULL;
    self->dict = NULL;
    self->this = NULL;
    Py_CLEAR(args);
    Py_CLEAR(kwds);
    PyErr_SetString(quickjs_error, "Value can only be created in C code");
    return -1;
}

// TODO:
// - objects: add mapping protocol
// - arrays: add sequence protocol
// - functions: add tp_call and call() attribute
//
// OR:
// - add keys(), items(), values()
// - add __dict__ and corresponding stuff to simplify everything...?
//    - or manually add caching
// - make arrays and functions just Objects...?
//    - add .call() and __call__()/.tp_call
//
// I think probably making things more pythonic, which includes adding GC
// support, is probably a more bulletproof solution.
//
// But maybe this is enough, and it's almost done, so maybe we'll finish this
// and see how it goes.
//
// Maybe we just only cache simple attributes?  The complex attributes already have their own form
// of caching.

// static PyObject *py_value_getattro(py_value_t *self, PyObject *attr){
//     (void)self;
//     const char *key = PyUnicode_AsUTF8(attr);
//     if(!key){
//         Py_CLEAR(attr);
//         return NULL;
//     }
//     ...
//     Py_CLEAR(attr);
static char * const py_value_getattr_doc =
    "__getattr__(attr) -> JSAny\n"
    "call a javascript function with explicit `this`";
static PyObject *py_value_getattr(py_value_t *self, PyObject *args){
    (void)self;

    const char *key;
    int ret = PyArg_ParseTuple(args, "s", &key);
    if(!ret) return NULL;

    JSValue jsval = JS_GetPropertyStr(self->ctx, self->jsval, key);
    if(JS_IsException(jsval)){
        return js_exception(self->ctx);
    }

    PyObject *out = NULL;
    bool success = false;

    // check cache
    out = PyDict_GetItemString(self->dict, key);
    if(out){
        // cache hit
        Py_INCREF(out);
        return out;
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
    ret = PyDict_SetItemString(self->dict, key, out);
    if(ret) goto done;

    success = true;

done:
    JS_FreeValue(self->ctx, jsval);
    if(!success) Py_CLEAR(out);

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

static char * const py_value_items_doc =
    "items() -> List[Tuple[str, JSAny]]\n"
    "get all enumerable key/value pairs in the object";
static PyObject *py_value_items(py_value_t *self, PyObject *args){
    (void)self;
    Py_CLEAR(args);
    PyErr_SetString(quickjs_error, ".items() called");
    return NULL;
}

// static PyObject *py_value_mp_subscript(py_value_t *self, PyObject *key){
//     int isinstance;
//     if((isinstance = PyObject_IsInstance(key, (PyObject*)&PyUnicode_Type))){
//         if(isinstance < 0) goto fail;
//     } else {
//         PyErr_SetString(quickjs_error, "only string keys are allowed on dict objects");
//         goto fail;
//     }
//
//     return py_value_getattro(self, key);
//
// fail:
//     Py_CLEAR(key);
//     return NULL;
// }
//
// PyMappingMethods py_value_as_mapping = {
//     .mp_length = (lenfunc)NULL, // no defined length
//     .mp_subscript = (binaryfunc)py_value_mp_subscript,
//     .mp_ass_subscript = (objobjargproc)NULL, // mapping is immutable
// };

// def length(self) -> int: ...
//     """If array, return the length, otherwise the number of enumerable keys."""
//
// def keys(self) -> int: ...
//     """Return all enumerable keys."""
//
// def values(self) -> int: ...
//     """Return all values for enumerable keys."""
//
// def items(self) -> List[]: ...
//     """Return all enumerable (key, value) tuples."""

static PyMethodDef py_value_methods[] = {
    {
        .ml_name = "__getattr__",
        .ml_meth = (PyCFunction)(void*)py_value_getattr,
        .ml_flags = METH_VARARGS,
        .ml_doc = py_value_getattr_doc,
    },
    {
        .ml_name = "call",
        .ml_meth = (PyCFunction)(void*)py_value_call,
        .ml_flags = METH_VARARGS,
        .ml_doc = py_value_call_doc,
    },
    {
        .ml_name = "keys",
        .ml_meth = (PyCFunction)(void*)py_value_items,
        .ml_flags = METH_NOARGS,
        .ml_doc = py_value_items_doc,
    },
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
    // .tp_getattro = (getattrofunc)py_value_getattro,
    .tp_call = (ternaryfunc)py_value_tp_call,
    // .tp_as_mapping = &py_value_as_mapping,
    .tp_dictoffset = offsetof(py_value_t, dict),
};

////

#define ARG_KWARG_FN_CAST(fn)\
    (PyCFunction)(void(*)(void))(fn)

static PyMethodDef _quickjs_methods[] = {
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
