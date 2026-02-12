import _quickjs

q = _quickjs.QuickJS()
q.eval("let x = {a: [], b: 2, c: () => 9}")
a = q.eval('x')

try:
    print("a.__dict__", a.__dict__)
except Exception as e:
    print("a.__dict__ failed:", e)

try:
    print("a.c", a.c)
except:
    print("a.c failed")
try:
    print("a.c.call", a.c.call)
except:
    print("a.c.call failed")
try:
    print("a.c.call()", a.c.call)
except:
    print("a.c.call() failed")

print("a.keys", a.keys)

print(dict(**a).keys())
