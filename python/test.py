import _quickjs

q = _quickjs.QuickJS()
q.eval("""
    let x = {a: ["zero", "one", "two"], b: 2, c: () => 9, 0: "nine"};
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
