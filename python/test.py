import STPyV8

with STPyV8.JSContext() as js:
    print(js.eval("setTimeout(() => 5 + 5)"))
