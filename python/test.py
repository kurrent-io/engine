import _quickjs

q = _quickjs.QuickJS()
q.eval("""
    let x = {a: [], b: 2, c: () => 9};
    x;
""")
a = q.eval('x')

q.eval("""
    console.log("object.keys(x) =", Object.keys(x));
""")

print("a", a)
print("a.b", a.b)
print("a['b']", a['b'])

print("a.c()", a.c())

print("a.keys()", a.keys())
print("a.items()", a.items())
print('dict(**a)', dict(**a))
