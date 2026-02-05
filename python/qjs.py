import quickjs

c = quickjs.Context()

c.eval('''
const _todo = [];
function run(fn) {
    fn();
    let f;
    while((f = _todo.shift())){
        f();
    }
}

function setTimeout(fn) {
    _todo.push(fn)
}

const console = {
    log: () => {},
}

print("hi")

''')

print("globals defined!")

c.eval('''
let x = 0
run(() => {
    x += 3;
    setTimeout(() => { x += 4; });
})
''')

print(c.eval("x"))
