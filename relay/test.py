import traceback

import _quickjs

q = _quickjs.QuickJS()
q.eval("""
    let x = new Proxy({a: ["zero", "one", "two"], b: 2, c: () => 9, 0: "nine"}, {});
    x;
""")
a = q.eval('x')

q.eval("""
    console.log("object.keys(x) =", Object.keys(x));
""")

print("a", a)
print("a.b", a.b)
print("a['b']", a.__getitem__('b'))

print("a.c", a.c)
print("a.c()", a.c())

print("a.keys()", a.keys())
print("a.items()", a.items())

print('dict(**a)', dict(**a))

print('a.a[1:3]', a.a[3:1])
print('len(a)', len(a))
print('len(a.a)', len(a.a))

print('for v in a:')
for v in a:
    print('  -', v)

print('for v in a.a:')
for v in a.a:
    print('  -', v)

# test opaque objects and function calls
class X:
    pass

x1 = X()
fn = q.eval("""
function x2(fn) { return fn(); }
function x1(fn) { return x2(fn); }
(fn) => x1(fn);
""")
x2 = fn(lambda: _quickjs.Opaque(x1))
assert x1 == x2, (x1, x2)

# test exceptions
class XErr(Exception):
    pass

def inner() -> None:
    raise XErr(x1)

try:
    fn(inner)
except XErr as xe:
    print("###############")
    traceback.print_exc()
    print("###############")
    assert xe.args[0] == x2, (xe.args, x2)


# import lmdb
#
# env = lmdb.Environment("lmdb")
#
# class LmdbTxn:
#     UNDEFINED = object()
#
#     def __init__(self, txn):
#         self.txn = txn
#
#     def commit(self):
#         self.txn.commit()
#
#     def abort(self):
#         self.txn.abort()
#
#     def get(key: str):
#         value = self.txn.get(key=key, default=self.UNDEFINED)
#         if value is self.UNDEFINED:
#             raise KeyError(key)
#         return value
#
#     def set(key: str, value: memoryview):
#         self.txn.put(key, value, overwrite=True)
#
#     def delete(key: str):
#         self.txn.delete(key)
#
# storage = _quickjs.make_storage(q, lambda write: LmdbTxn(env.begin(write=True, buffer=True)))
