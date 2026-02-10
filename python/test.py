import _quickjs

q = _quickjs.QuickJS()
q.eval("let x = {a: [], b: 2}")
a = q.eval('x')
print('a:', a)
b = q.eval('x')
print('b:', b)
print("-----")
print('a.a', a.a)
print('b.a', b.a)
print("-----")
print('a.b', a.b)
print('b.b', b.b)
