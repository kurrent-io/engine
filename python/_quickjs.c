#define PY_SSIZE_T_CLEAN
#include <Python.h>

#include <stdbool.h>
#include "quickjs/quickjs.h"

typedef struct {
    PyObject_HEAD;
    JSRuntime *rt;
    JSContext *ctx;
} py_quickjs_t;

static PyTypeObject py_quickjs_type;
static PyTypeObject py_cmem_type;
static PyTypeObject py_dc_op_type;


// convert json-like javascript object to python object
/*
function putValue(val) {
  switch(typeof(val)) {
    case "boolean": return glue.putBoolean(val);
    case "string": return glue.putString(val);
    case "number": return glue.putNumber(val);
    case "bigint": return glue.putBigInt(val);
    case "undefined": return glue.putNull();
    case "object":
      if (val === null) return glue.putNull();
      if (Array.isArray(val)) {
        glue.openArray(val.length);
        for (let i = 0; i < val.length; i++){
          console.log('putting', i, val[i])
          putValue(val[i]);
          glue.putItem(i);
        }
        return glue.putArray(val.length);
      }
      const entries = Object.entries(val);
      glue.openObject(entries.length);
      for (const [k, v] of entries) {
        putValue(v);
        glue.putKey(k);
      }
      return glue.putObject(entries.length);
  }
  throw new Error("unrecognized type: " + typeof(val));
}




    return tag == JS_TAG_INT || JS_TAG_IS_FLOAT64(tag);
}

static inline JS_BOOL JS_IsBigInt(JSContext *ctx, JSValueConst v)
{
    int tag = JS_VALUE_GET_TAG(v);
    return tag == JS_TAG_BIG_INT || tag == JS_TAG_SHORT_BIG_INT;


*/
static PyObject *js2py(JSContext *ctx, JSValue val) {
    int tag = JS_VALUE_GET_TAG(v);
    switch(tag){
        case JS_TAG_UNDEFINED:
        case JS_TAG_NULL:
            PY_RETURN_NONE;

        case JS_TAG_BOOL: {
            int is_done = JS_ToBool(ctx, done);
            if(is_done < 0) // XXX ;
            if(is_done){
                PY_RETURN_TRUE;
            } else {
                PY_RETURN_FALSE;
            }
        }

        case JS_TAG_STRING:
        case JS_TAG_STRING_ROPE: {
            size_t len;
            const char *s = JS_ToCStringLen(ctx, &len, val);
            if(!s) // XXX ;
            return PyUnicode_FromStringAndSize(s, (Py_ssize_t)len);
        }

        case JS_TAG_BIG_INT:
        case JS_TAG_INT:
        case JS_TAG_SHORT_BIG_INT: {
            int64_t res;
            int ret = JS_ToInt64Ext(ctx, &res, val);
            if(ret < 0) // XXX ;
            return PyLong_FromInt64(res);
        }

        case JS_TAG_FLOAT64: {
            double res;
            int ret = JS_ToFloat64(ctx, &res, val);
            if(ret < 0) // XXX ;
            return PyFloat_FromDouble(res);
        }

        case JS_TAG_OBJECT:
            // fallthru
            break;

        default:
            // XXX
            return NULL;
    }

    // cleanup becomes necessary for more sophisticated types

    PyObject *out = NULL;
    PyObject *pykey = NULL;
    PyObject *pyval = NULL;
    JSValue length = JS_EXCEPTION;
    JSValue values = JS_EXCEPTION;
    JSValue iter = JS_EXCEPTION;
    JSValue next = JS_EXCEPTION;
    JSValue result = JS_EXCEPTION;
    JSValue done = JS_EXCEPTION;
    JSValue item = JS_EXCEPTION;

    JSPropertyEnum *props = NULL;
    uint32_t nprops = 0;

    int is_array = JS_IsArray(ctx, val);
    if(is_array < 0){
        // XXX exception
        return NULL;
    }
    if(is_array){
        // get the length of the array
        length = JS_GetPropertyStr(ctx, val, "length");
        if(length == JS_EXCEPTION) // XXX ;
        int64_t len;
        int ret = JS_ToInt64Ext(ctx, &len, length);
        if(ret < 0) // XXX ;
        // prepare the python object
        PyObject *out = PyList_New(len);
        if(!out) // XXX ;
        // let iter = arr.values()
        values = JS_GetPropertyStr(ctx, val, "values");
        if(values == JS_EXCEPTION) // XXX ;
        iter = JS_Call(ctx, values, val, 0, NULL);
        if(iter == JS_EXCEPTION) // XXX ;
        // let next = iter.next
        next = JS_GetPropertyStr(ctx, iter, "next");
        if(next == JS_EXCEPTION) // XXX ;
        // call next until it returns done:true
        for(int64_t i = 0; i < len; i++){
            // let result = iter.next()
            result = JS_Call(ctx, next, iter, 0, NULL);
            if(result == JS_EXCEPTION) // XXX ;
            // check if iterator is done
            done = JS_GetPropertyStr(ctx, val, "done");
            if(done == JS_EXCEPTION) // XXX ;
            int is_done = JS_ToBool(ctx, done);
            if(is_done < 0) // XXX ;
            if(is_done) break;
            // recurse on this item
            item = JS_GetPropertyStr(ctx, val, "value");
            if(item == JS_EXCEPTION) // XXX ;
            PyObject *pyitem = js2py(ctx, item);
            if(!pyitem) // XXX ;
            // reference to pyval is stolen, and no return value given
            PyList_SET_ITEM(out, it.i-1, pyitem);
            // reset loop variables
            JS_FreeValue(ctx, result); result = JS_EXCEPTION;
            JS_FreeValue(ctx, done); done = JS_EXCEPTION;
            JS_FreeValue(ctx, item); item = JS_EXCEPTION;
        }
        goto done;
    }

    // object handling: allocate an output dict
    PyObject *out = PyDict_new();
    if(!out) // XXX ;
    // iterate through Object.keys() (enumerable flavor of GetOwnPropertyNames)
    int ret = JS_GetOwnPropertyNames(ctx, &props, &nprops, val, JS_GPN_ENUM_ONLY);
    if(ret < 0) // XXX ;
    for(uint32_t i = 0; i < nprops; i++){
        JSAtom = props[i].atom;
        JSPropertyDescriptor desc;
        ret = JS_GetOwnProperty(ctx, &desc, val, atom);
        if(ret < 0) // XXX ;
        // skip keys with undefined values
        if(JS_VALUE_GET_TAG(desc.value) == JS_TAG_UNDEFINED) continue;
        // get the key as a python object
        size_t len;
        const char *key = JS_AtomToCStringLen(ctx, &len, atom);
        if(!key) // XXX ;
        pykey = PyUnicode_FromStringAndSize(key, (Py_ssize_t)len);
        if(!pykey) // XXX ;
        // recurse for the value
        pyval = js2py(ctx, desc.value);
        if(!pyval) // XXX ;
        ret = PyDict_SetItem(out, pykey, pyval);
        // reset loop variables
        Py_CLEAR(pykey);
        Py_CLEAR(pyval);
    }
    goto done;

fail:
    Py_CLEAR(out);
    // XXX set error?

done:
#define JS_DONE(var) do { if(var != JS_EXCEPTION) JS_FreeValue(ctx, var); } while(0)
    Py_CLEAR(pykey);
    Py_CLEAR(pyval);
    JS_DONE(length);
    JS_DONE(values);
    JS_DONE(iter);
    JS_DONE(next);
    JS_DONE(result);
    JS_DONE(done);
    JS_DONE(item);
    if(props) JS_FreePropertyEnum(ctx, props, nprops);

    return out;
}


static JSValue PyObject *py2js(JSContext *ctx, PyObject *val) {
    PyObject *items = NULL;
    PyObject *fast = NULL;
    PyObject *key = NULL;
    PyObject *val = NULL;

    // is object a singleton?
    if(obj == Py_False){
        lua_pushboolean(L, false);
        goto done;
    }
    if(obj == Py_True){
        lua_pushboolean(L, true);
        goto done;
    }
    if(obj == Py_None){
        lua_pushnil(L);
        goto done;
    }

    // is object a string?
    if(PyObject_IsSubclass(obj, PyUnicode_Type)){
        Py_ssize_t keylen;
        const char *keystr = PyUnicode_AsUTF8AndSize(key, &keylen);
        if(!keystr) ...
        lua_pushlstring(L, keystr, (size_t)keylen);
        goto done;
    }

    // is object a list or a tuple?
    if(
        PyObject_IsSubclass(obj, PyList_Type)
        || PyObject_IsSubclass(obj, PyTuple_Type)
    ){
        PyObject *fast = PySequence_Fast(obj);
        if(!fast) ...
        Py_ssize_t len = PySequence_Fast_GET_SIZE(fast);
        if(len < 0) ...
        // create the lua table
        lua_createtable(L, (int)len, 0);
        // iterate through key/value pairs
        for(Py_ssize_t i = 0; i < len; i++){
            PyObject *item = PySequence_Fast_GET_ITEM(fast, i);
            // convert value (recurse)
            python2lua(L, item);
            // add it to the lua table
            lua_Integer index = i + 1;
            lua_rawseti(L, -2, index);
        }
        goto done;
    }

    // is object a dict?
    if(PyObject_IsSubclass(obj, PyDict_Type)){
        items = PyMapping_Items(obj);
        if(!items) ...
        PyObject *fast = PySequence_Fast(items);
        if(!fast) ...
        Py_ssize_t len = PySequence_Fast_GET_SIZE(fast);
        if(len < 0) ...
        // create the lua table
        lua_createtable(L, 0, (int)len);
        // iterate through key/value pairs
        for(Py_ssize_t i = 0; i < len; i++){
            PyObject *item = PySequence_Fast_GET_ITEM(fast, i);
            key = PySequence_ITEM(item, 0);
            val = PySequence_ITEM(item, 1);
            // extract key
            Py_ssize_t keylen;
            const char *keystr = PyUnicode_AsUTF8AndSize(key, &keylen);
            if(!keystr) ...
            lua_pushlstring(L, keystr, (size_t)keylen);
            // convert value (recurse)
            python2lua(L, val);
            // add it to the lua table
            lua_rawset(L, -3);
            // done with this key/value pair
            Py_DECREF(key);
            Py_DECREF(val);
            key = NULL;
            val = NULL;
        }
        goto done;
    }

    // XXX: throw an unhandled type exception

done:
    Py_XDECREF(items);
    Py_XDECREF(fast);
    Py_XDECREF(key);
    Py_XDECREF(val);
}



static PyObject *quickjs_error;  // XXX use a different error, maybe a builtin one

// QuickJS

static void py_quickjs_dealloc(py_quickjs_t *self){
    if(self->ctx) JS_FreeContext(self->ctx);
    self->ctx = NULL;
    if(self->rt) JS_FreeRuntime(self->rt);
    self->rt = NULL;
    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_quickjs_init(py_quickjs_t *self, PyObject *args, PyObject *kwds){
    char *kwnames[] = {
        NULL,
    };

    int ret = PyArg_ParseTupleAndKeywords(
        args, kwds, "", kwnames,
        &flags,
    );
    if(!ret) return -1;

    self->rt = JS_NewRuntime();
    if(!self->rt) {
        PyErr_SetString(quickjs_error, "JS_NewRuntime() failed");
        return -1;
    }

    self->ctx = JS_NewContext(self->rt);
    if(!self->ctx) {
        JS_FreeRuntime(self->rt);
        self->rt = NULL;
        PyErr_SetString(quickjs_error, "JS_NewContext() failed");
        return -1;
    }

    return 0;
}


static PyObject *handle_exception(JSContext *ctx, JSValue val) {
    JSValue exc = JS_GetException(self->ctx);
    size_t slen = 0;
    const char *str = JS_ToCStringLen2(self->ctx, &slen, exc);
    if (str) {
        PyErr_SetObject(quickjs_error, PyUnicode_FromStrinAndSize(str, slen));
    } else {
        PyErr_SetString(quickjs_error, "unidentified exception raised by quickjs");
    }
    JS_FreeValue(exc);
    return NULL;
}


static char * const py_quickjs_eval =
    "eval(script: string, flags=0) -> Value\n"
    "eval script and return result";
static PyObject *py_quickjs_eval(py_quickjs_t *self){
    const char *script = "";
    Py_ssize_t slen = 0;
    int flags = 0;


    char *kwnames[] = {
        "script",
        "flags",
        NULL,
    };

    int ret = PyArg_ParseTupleAndKeywords(
        args, kwds, "s#|i", kwnames,
        &script,
        &slen
        &flags
    );
    if(!ret) return NULL;

    JSValue val = JS_Eval(self->ctx, script, script_len);
    if(val == JS_EXCEPTION) {
        return handle_exception(self->ctx, val);
    }

    /* XXX: return a quickjs value

       We need to return a value here.  It needs to have some purpose from Python code.

       I suppose we should handle some primitives:
       - primitives are primitives
       - functions get wrapped as python functions
       - objects become dicts
       - arrays become lists

       Where does the generated typed code belong?

       I guess it'd be nice to have a Framework-like wrapper here, maybe with a subset of methods.
    */

    Py_RETURN_NONE;
}

/*
   Ok, you can do Object.keys() in quickjs.  With flags=JS_GPN_ENUM_ONLY it is:

    int JS_GetOwnPropertyNames(
        JSContext *ctx, JSPropertyEnum **ptab, uint32_t *plen, JSValueConst obj, int flags
    );

   So that makes the javascript->host interface simpler; it does not need to involve 3 languages!


*/


static PyMethodDef py_quickjs_methods[] = {
    {
        .ml_name = "eval",
        .ml_meth = (PyCFunction)(void*)py_quickjs_eval,
        .ml_flags = METH_NOARGS,
        .ml_doc = py_quickjs_eval,
    },
    {NULL}, // sentinel
};


static PyTypeObject py_quickj_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_quickjs.QuickJS",
    .tp_doc = "python bindings to quickjs",
    .tp_basicsize = sizeof(py_quickjs_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_quickj_dealloc,
    .tp_methods = py_quickj_methods,
    .tp_init = (initproc)py_quickjs_init,
};

// CMem type, implements buffer protocol and frees memory when no longer used

static void py_cmem_dealloc(py_cmem_t *self){
    if(self->mem) free(self->mem);
    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_cmem_init(py_cmem_t *self, PyObject *args, PyObject *kwds){
    (void)self;
    (void)args;
    (void)kwds;
    PyErr_SetString(quickjs_error, "CMem can only be created in C code");
    return -1;
}

static int py_cmem_getbuffer(PyObject *exporter, Py_buffer *view, int flags){
    #define FAIL(msg) do { \
        PyErr_SetString(PyExc_BufferError, msg); \
        goto fail; \
    }while(0)

    py_cmem_t *cmem = (py_cmem_t*)exporter;
    if(flags & PyBUF_WRITABLE) FAIL("CMem refuses to make writable views");

    if(flags & PyBUF_FORMAT) view->format = "B";

    // view holds a reference to us
    Py_INCREF(exporter);

    *view = (Py_buffer){
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

    #undef FAIL
    return 0;

fail:
    view->obj = NULL;
    return -1;
}

static PyBufferProcs py_cmem_bufferprocs = {
    .bf_getbuffer = py_cmem_getbuffer,
    // memory is freed when the exporter is freed
    .bf_releasebuffer = NULL,
};

static PyMethodDef py_cmem_methods[] = {
    {NULL}, // sentinel
};

static PyTypeObject py_cmem_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_pydctx.CMem",
    .tp_doc = "an distributed communcation operation that can be awaited",
    .tp_basicsize = sizeof(py_cmem_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_cmem_dealloc,
    .tp_methods = py_cmem_methods,
    .tp_init = (initproc)py_cmem_init,
    .tp_as_buffer = &py_cmem_bufferprocs,
};


// Operation type

static void py_dc_op_dealloc(py_dc_op_t *self){
    // release the buffer (PyBuffer_Release is safe against double-frees)
    PyBuffer_Release(&self->view);

    // TODO: need to separate dctx alloc/free from open/close to avoid errors
    // what a n00b error!

    Py_TYPE(self)->tp_free((PyObject*)self);
}

static int py_dc_op_init(py_dc_op_t *self, PyObject *args, PyObject *kwds){
    (void)self;
    (void)args;
    (void)kwds;
    PyErr_SetString(quickjs_error, "Operation can only be created in C code");
    return -1;
}


static PyObject *py_dc_op_wait(py_dc_op_t *self){
    // TODO: any way to support async behavior?
    dc_result_t *r = dc_op_await(self->op);
    if(!dc_result_ok(r)){
        PyErr_SetString(quickjs_error, "operation failed");
        goto fail;
    }

    // done with view
    PyBuffer_Release(&self->view);

    size_t count = dc_result_count(r);
    // empty result case
    if(count == 0) Py_RETURN_NONE;

    // broadcast case (only ever one result)
    if(self->extract){
        char *data = dc_result_take(r, 0);
        Py_ssize_t len = (Py_ssize_t)dc_result_len(r, 0);
        py_cmem_t *cmem = cmem_new(data, len);
        if(!cmem) goto fail_result;
        return (PyObject*)cmem;
    }

    // multi result case
    PyObject *py_list = PyList_New((Py_ssize_t)count);
    if(!py_list) goto fail_result;

    for(size_t i = 0; i < (size_t)count; i++){
        char *data = dc_result_take(r, i);
        Py_ssize_t len = (Py_ssize_t)dc_result_len(r, i);

        // give data to a zero-copy, reference-counted wrapper object
        py_cmem_t *cmem = cmem_new(data, len);
        if(!cmem) goto fail_list;

        // the SET_ITEM macro is only suitable for newly created, empty lists
        // SET_ITEM steals a reference, so no decref is necessary
        PyList_SET_ITEM(py_list, (Py_ssize_t)i, (PyObject*)cmem);
    }

    return py_list;

fail_list:
    Py_DECREF(&py_list);
fail_result:
    dc_result_free2(r);
fail:
    return NULL;
}

static PyMethodDef py_dc_op_methods[] = {
    {
        .ml_name = "wait",
        .ml_meth = (PyCFunction)(void*)py_dc_op_wait,
        .ml_flags = METH_NOARGS,
        .ml_doc = NULL,
    },
    {NULL}, // sentinel
};


static PyTypeObject py_dc_op_type = {
    PyVarObject_HEAD_INIT(NULL, 0)
    // this needs to be dotted to work with pickle and pydoc
    .tp_name = "_pydctx.Operation",
    .tp_doc = "an distributed communcation operation that can be awaited",
    .tp_basicsize = sizeof(py_dc_op_t),
    // 0 means "size is not variable"
    .tp_itemsize = 0,
    .tp_flags = Py_TPFLAGS_DEFAULT,
    .tp_new = PyType_GenericNew,
    .tp_dealloc = (destructor) py_dc_op_dealloc,
    .tp_methods = py_dc_op_methods,
    .tp_init = (initproc)py_dc_op_init,
};

////


#define ARG_KWARG_FN_CAST(fn)\
    (PyCFunction)(void(*)(void))(fn)

static PyMethodDef _quickjs[] = {
    {0},  // sentinel
};

static struct PyModuleDef _quickjs_module = {
    PyModuleDef_HEAD_INIT,
    .m_name = "_quickjs",
    .m_doc = "python bindings to quickjs",
    // XXX we don't have global state...?
    .m_size = -1, /* size of per-interpreter state of the module,
                     or -1 if the module keeps state in global variables. */
    .m_methods = _quickjs,
};

// main entrypoint for python module
PyObject* PyInit__quickjs(void){
    if (PyType_Ready(&py_quickjs_type) < 0) return NULL;
    int ret;

    PyObject *module = PyModule_Create(&_quickjs_module);
    if (module == NULL){
        return NULL;
    }

    Py_INCREF((PyObject*)&py_quickjs_type);
    ret = PyModule_AddObject(module, "QuickJS", (PyObject*)&py_quickjs_type);
    if(ret < 0) goto fail_py_quickjs;

    Py_INCREF((PyObject*)&py_cmem_type);
    ret = PyModule_AddObject(module, "CMem", (PyObject*)&py_cmem_type);
    if(ret < 0) goto fail_cmem;

    Py_INCREF((PyObject*)&py_dc_op_type);
    ret = PyModule_AddObject(module, "Operation", (PyObject*)&py_dc_op_type);
    if(ret < 0) goto fail_dc_op;

    quickjs_error = PyErr_NewException("_pydctx.QuickJSError", NULL, NULL);
    Py_INCREF(quickjs_error);
    ret = PyModule_AddObject(module, "QuickJSError", quickjs_error);
    if(ret < 0) goto fail_pysm_error;

    return module;

fail_pysm_error:
    Py_DECREF((PyObject*)&quickjs_error);
fail_dc_op:
    Py_DECREF((PyObject*)&py_dc_op_type);
fail_cmem:
    Py_DECREF((PyObject*)&py_cmem_type);
fail_py_quickjs:
    Py_DECREF((PyObject*)&py_quickjs_type);
    Py_DECREF(module);
    return NULL;
}
