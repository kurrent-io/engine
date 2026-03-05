package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"runtime"
	_ "embed"
	"errors"
	"iter"

	"github.com/dop251/goja"
)

// func consoleLog(this goja.Value, args... goja.Value) goja.Value {
// 	var out []string
// 	for _, arg := range args {
// 		out = append(out, arg.String())
// 	}
// 	println(strings.Join(out, " "))
// 	return this
// }

//go:embed decider.js
var deciderScript string

func consoleLog(call goja.FunctionCall) goja.Value {
	var out []string
	for _, arg := range call.Arguments {
		out = append(out, arg.String())
	}
	println(strings.Join(out, " "))
	return nil
}

func run() error {
	vm := goja.New()

	console := vm.NewObject()
	console.Set("log", consoleLog)
	vm.GlobalObject().Set("console", console)
	// hack: load exports into the global namespace
	vm.GlobalObject().Set("exports", vm.GlobalObject())

	_, err := vm.RunString("console.log('hello')")
	if err != nil { return err }

	_, err = vm.RunString(deciderScript)
	if err != nil { return err }

	_, err = vm.RunScript("decider.js", "console.log('deciderProjector', deciderProjector);")
	if err != nil { return err }

	for _, name := range vm.GlobalObject().GetOwnPropertyNames() {
		fmt.Printf("global.%v\n", name)
	}

	// event := map[string]any{
	// 	"type": "add-edition",
	// 	"isbn": "my-isbn",
	// 	"title": "cheech-and-chong-learn-event-sourcing",
	// 	"timestamp": "2025-01-24T15:54:32Z",
	// }

	// err = CheckLibraryEvents(event)
	// if err != nil {
	// 	return err
	// }

	// fw := NewDeciderFramework[any](
	// 	"decider.js", deciderScript,
	// 	"InMemStorage",
	// 	func (events []LibraryEvents) ([]LibraryEvents, any) { return events, nil },
	// 	"deciderProjector",
	// )

	// bookList := fw.NewQuery(func(qx DeciderQueryContext) []Book {
	// 	var out []Book
	// 	for _, isbn := qx.Editions() {
	// 		edition := qx.Edition(isbn)
	// 		out = append(out, Book{ edition.Title, len(edition.Books))
	// 	}
	// 	return out
	// })

	// bookList.Subscribe(func(books[]Book) {
	// 	fmt.Printf("have books:\n")
	// 	for _, book := range books {
	// 		fmt.Printf("  - %v (x%v)\n", book.Title, book.Copies)
	// 	}
	// })

	return nil
}

func main() {
	err := run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fail: %v\n", err)
		os.Exit(1)
	}
}

// Example generated types below //////////////////////////////////////

// // struct type: a simple wrapper around a goja.Value
// type Book goja.Value
//
// func (value book) Id() string {
// 	return value.ToObject().Get("id").ToString()
// }
//
// func (value book) Isbn() string {
// 	return value.ToObject().Get("isbn").ToString()
// }
//
// func (value book) Restricted() bool {
// 	return value.ToObject().Get("restricted").ToBool()
// }
//
// func (value book) Status() BookStatus {
// 	var x goja.Value
// 	var t goja.Value
// 	x = value.ToObject().Get("status")
// 	if goja.IsUndefined(x) {
// 		return nil
// 	}
// 	t = x.ToObject().Get("hold")
// 	if !goja.IsUndefined(t) {
// 		x = t
// 		return BookStatusHold(x)
// 	}
// 	t = x.ToObject().Get("checkout")
// 	if !goja.IsUndefined(t) {
// 		x = t
// 		return BookStatusCheckout(x)
// 	}
// 	panic(fmt.Sprintf("unrecognized book status: %v", x))
// }
//
// // struct type
// type BookStatusHold goja.Value
// func (value BookStatusHold) Hold() string {
// 	return value.ToObject().Get("hold").ToString()
// }
//
// // struct type
// type BookStatusCheckout goja.Value
// func (value BookStatusCheckout) Checkout() string {
// 	return value.ToObject().Get("checkout").ToString()
// }
//
// // union type: an interface
// type BookStatus interface {
// 	IsBookStatus()
// }
// func (value BookStatusHold) IsBookStatus() {}
// func (value BookStatusCheckout) IsBookStatus() {}

// Framework wrapper below //////////////////////////////////////

type QueryContext interface {
	Ask(goja.Value) goja.Value
}

//

type Source interface {
	// returns name, script, error
	ToSource() (string, string, error)
}

type StringSource struct {
	name   string
	script string
}

func NewStringSource(name, script string) Source {
	return StringSource{name, script}
}

func (s StringSource) ToSource() (string, string, error) {
	return s.name, s.script, nil
}

//

type Decoder[E any] interface {
	// note: events is goja Array of undecoded events, and it returns an Array of decoded events
	ToDecoder(vm *goja.Runtime) (func (events goja.Value) (goja.Value, error), error)
}

type JSDecoder struct {
	name string
}

func NewJSDecoder[E any](name string) Decoder[E] {
	return JSDecoder{name}
}

func (d JSDecoder) ToDecoder(vm *goja.Runtime) (func(goja.Value) (goja.Value, error), error) {
	jsfn := vm.GlobalObject().Get(d.name)
	if goja.IsUndefined(jsfn) {
		return nil, fmt.Errorf("unable to create decoder: no such symbol: %v", d.name)
	}
	fn, ok := goja.AssertFunction(jsfn)
	if !ok {
		return nil, fmt.Errorf("unable to create decoder: symbol is not a function: %v", d.name)
	}

	return func(events goja.Value) (goja.Value, error) {
		// just provide an empty `this`
		return fn(goja.Undefined(), events)
	}, nil
}

//

type Shaper[E any, P any] interface {
	ToShaper(vm *goja.Runtime) (goja.Value, error)
}

type JSShaper struct {
	name string
}

func NewJSShaper[E any, P any](name string) Shaper[E, P] {
	return JSShaper{name}
}

func (s JSShaper) ToShaper(vm *goja.Runtime) (goja.Value, error) {
	jsfn := vm.GlobalObject().Get(s.name)
	if goja.IsUndefined(jsfn) {
		return nil, fmt.Errorf("unable to create shaper: no such symbol: %v", s.name)
	}
	_, ok := goja.AssertFunction(jsfn)
	if !ok {
		return nil, fmt.Errorf("unable to create shaper: symbol is not a function: %v", s.name)
	}
	return jsfn, nil
}

// type GoShaper struct {
// 	fn func([]E)([]E, P)
// }
//
// func NewGoShaper[E any, P any](fn func([]E)([]E, P)) Shaper {
// 	return GoShaper{fn}
// }
//
// func (s GoShaper) ToShaper[E, P](vm *goja.Runtime) (goja.Value) {
// 	return func(call goja.FunctionCall) goja.Value {
// 		// TODO: figure out what might go here
// 	}
// }

//

type Storage interface {
	ToStorage(vm *goja.Runtime) (goja.Value, error)
}

type InMemStorage struct {}

func NewInMemStorage() Storage {
	return InMemStorage{}
}

func (s InMemStorage) ToStorage(vm *goja.Runtime) (goja.Value, error) {
	return vm.New(vm.GlobalObject().Get("InMemStorage"))
}

//

type Projector[PX any, E any] interface {
	// returns a [PX, projectorFunc]
	ToProjector(vm *goja.Runtime) (goja.Value, goja.Value, error)
}

type JSProjector struct {
	px string
	projector string
}

func NewJSProjector[PX any, E any](px, projector string) Projector[PX, E] {
	return JSProjector{px, projector}
}

func (s JSProjector) ToProjector(vm *goja.Runtime) (goja.Value, goja.Value, error) {
	px := vm.GlobalObject().Get(s.px)
	if goja.IsUndefined(px) {
		return nil, nil, fmt.Errorf("unable to create px: no such symbol: %v", s.px)
	}

	projector := vm.GlobalObject().Get(s.projector)
	if goja.IsUndefined(projector) {
		return nil, nil, fmt.Errorf("unable to create projector: no such symbol: %v", s.projector)
	}
	_, ok := goja.AssertFunction(projector)
	if !ok {
		return nil, nil, fmt.Errorf(
			"unable to create projector: symbol is not a function: %v", s.projector,
		)
	}
	return px, projector, nil
}

//

type Framework[QX QueryContext, PX any, E any, C any, P any] struct {
	vm *goja.Runtime
	fw *goja.Object
	decoder func (events goja.Value) (goja.Value, error)
	run func() error
	newQuery goja.Callable
	recvEvents goja.Callable
	qxFactory func(ask func(goja.Value) goja.Value) QX
}

func makeSetTimeout() (func (goja.FunctionCall) goja.Value, func() error) {
	// set up a circularly-linked list as a queue of callables
	type CallSoon struct {
		Func goja.Callable
		Link Link[CallSoon]
	}
	callSoonFromLink := LinkDerefFunc[CallSoon]("Link")
	var q Head[CallSoon]

	setTimeout := func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) == 0 {
			panic("setTimeout: missing function parameter")
		}
		if len(call.Arguments) > 1 {
			if timeout, ok := call.Arguments[1].Export().(int64); !ok || timeout != 0 {
				panic("setTimeout with nonzero timeout is forbidden")
			}
		}
		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic("setTimeout() requires a callable")
		}
		q.Append(&(&CallSoon{Func: fn}).Link)
		return goja.Undefined()
	}

	run := func() error {
		for {
			next := q.PopFirst(callSoonFromLink)
			if next == nil {
				return nil
			}
			_, err := next.Func(goja.Undefined())
			if err != nil {
				return err
			}
		}
	}

	return setTimeout, run
}

func NewFramework[QX QueryContext, PX any, E any, C any, P any](
	source Source,
	storage Storage,
	decoder Decoder[E],
	shaper Shaper[E, P],
	projector Projector[PX, E],
	qxFactory func(ask func(goja.Value) goja.Value) QX,
) (*Framework[QX, PX, E, C, P], error) {
	vm := goja.New()
	console := vm.NewObject()

	// configure a console.Log()
	console.Set("log", consoleLog)
	vm.GlobalObject().Set("console", console)

	// configure a setTimeout()
	setTimeout, run := makeSetTimeout()
	vm.GlobalObject().Set("setTimeout", setTimeout)

	// hack: load exports into the global namespace
	vm.GlobalObject().Set("exports", vm.GlobalObject())
	name, script, err := source.ToSource()
	if err != nil {
		return nil, fmt.Errorf("source: %w", err)
	}
	_, err = vm.RunScript(name, script)
	if err != nil {
		return nil, fmt.Errorf("loading bundle: %w", err)
	}
	vm.GlobalObject().Delete("exports")

	storageVal, err := storage.ToStorage(vm)
	if err != nil {
		return nil, fmt.Errorf("storage: %w", err)
	}

	decoderFn, err := decoder.ToDecoder(vm)
	if err != nil {
		return nil, fmt.Errorf("decoder: %w", err)
	}

	shaperFn, err := shaper.ToShaper(vm)
	if err != nil {
		return nil, fmt.Errorf("shaper: %w", err)
	}

	px, projectorFn, err := projector.ToProjector(vm)
	if err != nil {
		return nil, fmt.Errorf("projector: %w", err)
	}

	// build callbacks
	callbacks := vm.NewObject()
	callbacks.Set("shaper", shaperFn)
	callbacks.Set("projector", projectorFn)

	// we handle QX entirely in go
	jsqx := goja.Undefined()

	// call `new Framework()`
	fwClass := vm.GlobalObject().Get("Framework")
	if goja.IsUndefined(fwClass) {
		return nil, errors.New("unable to locate Framework symbol")
	}
	fwConstructor, ok := goja.AssertConstructor(fwClass)
	if !ok {
		return nil, errors.New("Framework symbol is not a constructor")
	}
	fw, err := fwConstructor(nil, px, jsqx, storageVal, callbacks)
	if err != nil {
		return nil, fmt.Errorf("new Framework(): %w", err)
	}

	// get methods now
	newQuery, ok := goja.AssertFunction(fw.Get("newQuery"))
	if !ok {
		return nil, errors.New(".newQuery() method not callable")
	}
	recvEvents, ok := goja.AssertFunction(fw.Get("recvEvents"))
	if !ok {
		return nil, errors.New(".recvEvents() method not callable")
	}

	return &Framework[QX, PX, E, C, P]{
		vm,
		fw,
		decoderFn,
		run,
		newQuery,
		recvEvents,
		qxFactory,
	}, nil
}

func (f *Framework[QX, PX, E, C, P]) Run(rawEvents goja.Value) error {
	return f.run()
}

func (f *Framework[QX, PX, E, C, P]) RecvEvents(rawEvents goja.Value) error {
	_, err := f.recvEvents(f.fw, rawEvents)
	return err
}

type Query[T any] struct {
	vm    *goja.Runtime
	query *goja.Object
}

// from within another query function, ask for the result of this query
func (q *Query[T]) Result(qx QueryContext) T {
	// yield {query: {id: true}}
	id := q.query.Get("id").Export().(string)
	query := q.vm.NewObject()
	query.Set(id, true)
	question := q.vm.NewObject()
	question.Set("query", query)
	// receive {query: {id: [result, dirty]}}
	answer := qx.Ask(query)
	return answer.(*goja.Object).
		Get("query").(*goja.Object).
		Get("id").(*goja.Object).
		Get("0").
		Export().(T)
}

// newcoro has three type parameters: "Q"uestion, "A"nswer, and "R"esult.
//
// It starts a coroutine that eventually returns `R` and has with access to an `ask func(Q) A`.
//
// It returns a `next func(A) (Q, R, done)`.
// While done is false, Q is valid.  When done is true, R is valid.
func newcoro[Q any, A any, R any](fn func(ask func(Q) A) R) func(A) (Q, R, bool) {
	var answer A
	var result R

	// It would be nice to use runtime.newcoro directly, but go doesn't allow it; the only way to
	// use it is via go:linkname, and that is forbidden by the linker by all packages except "iter".
	//
	// Afaict, that means the only existing consumer of runtime.newcoro is iter.Pull, so we'll just
	// have to wrap iter.Pull I guess.
	next, _ := iter.Pull[Q](func(yield func(Q) bool) {
		// wrap the unidirectional `yield` in a bidirectional `ask`.  The answer comes by
		// examining the `answer` value, which must be updated after the coro calls `yield`
		// and before calling `next` again.
		ask := func(question Q) A {
			if yield(question) {
				// this should never happen as we don't use stop() ever; we rely on either
				// finishing the coroutine or the go runtime garbage collecting it.
				panic("query was canceled early")
			}
			// return the answer provided by next
			return answer
		}
		// run the provided coroutine function
		result = fn(ask)
	})

	nextfunc := func(val A) (Q, R, bool) {
		// set answer for `ask()` to return inside the coro
		answer = val
		question, ok := next()
		return question, result, !ok
	}

	return nextfunc
}

func (q *Query[T]) Subscribe(fn func(T)) func() {
	jsfn := func(call goja.FunctionCall) goja.Value {
		// only argument is a goja-wrapped `T`
		fn(call.Arguments[0].Export().(T))
		return goja.Undefined()
	}
	sub := q.query.Get("subscribe")
	subFn, ok := goja.AssertFunction(sub)
	if !ok {
		panic("Query.subscribe is not callable??")
	}

	// call Query.subscribe(fn), which never throws
	unsub, err := subFn(q.query, q.vm.ToValue(jsfn))
	if err != nil {
		// should never happen
		panic("Query.subscribe failed??")
	}

	unsubFn, ok := goja.AssertFunction(unsub)
	if !ok {
		panic("Query.subscribe() returns non-callable unsubscribe??")
	}

	return func(){
		_, err := unsubFn(goja.Undefined())
		if err != nil {
			panic("Query unsubscribe failed??")
		}
	}
}

func NewQuery[QX QueryContext, PX any, E any, C any, P any, T any](
	fw *Framework[QX, PX, E, C, P],
	fn func(qx QX, prev *T) T,
) *Query[T] {
	// each time a query is run, we create a new javascript iterator around a new coroutine
	queryfunc := func(call goja.FunctionCall) goja.Value {
		// args are (qx: javascriptQX, prev: T|None, prevIsValid: bool)
		var prev *T
		if call.Arguments[2].ToBoolean() {
			tmp := call.Arguments[1].Export().(T)
			prev = &tmp
		}

		// start query function in a goroutine
		next := newcoro[goja.Value, goja.Value, T](func(ask func(goja.Value) goja.Value) T {
			qx := fw.qxFactory(ask)
			return fn(qx, prev)
		})

		// return something that looks like a javascript iterator
		it := fw.vm.NewObject()
		it.Set("next", func(call goja.FunctionCall) goja.Value {
			question, result, done := next(call.Arguments[0])
			// return {value, done}
			out := fw.vm.NewObject()
			out.Set("done", done)
			if !done {
				out.Set("value", question)
			} else {
				out.Set("value", result)
			}
			return out
		})

		return it
	}

	// call javascript method: Framework.newQuery(), which does not throw
	query, err := fw.newQuery(fw.fw, fw.vm.ToValue(queryfunc))
	if err != nil {
		panic("framework.newQuery failed??")
	}

	return &Query[T]{
		vm:    fw.vm,
		query: query.(*goja.Object),
	}
}

///////////////

// queries are synchronous iterators in the javascript code, but we model them as goroutines here
// for a syntactically pleasant experience.  Effectively, each query active in the graph represents
// a goroutine that is alive until it completes, or we ask it to shut down.
//
// How do we make sure that we don't leak goroutines?  Well I guess there's an upper bound to
// lifetimes, which is on the start of a new run of the graph we know any old goroutines need to get
// killed off.
type QueryManager[QX QueryContext] struct {
	vm   *goja.Runtime
	wg   sync.WaitGroup
	done chan struct{}
	qx   func(Comms) QX
}

type Comms struct {
	qs chan goja.Value
	ans chan goja.Value
	done chan struct{}
}

func NewComms(done chan struct{}) Comms {
	return Comms{make(chan goja.Value), make(chan goja.Value), done}
}

// either returns a value or calls runtime.Goexit
func (c *Comms) Answer() goja.Value {
	select {
	case <-c.done:
		// we were canceled; get out now
		runtime.Goexit()
		panic("unreachable, but the go compiler doesn't seem to know that")
	case ans := <-c.ans:
		// ignore first value like javascript expects of a generator
		return ans
	}
}

// returns (value, done, err)
func (c *Comms) Ask(q goja.Value) goja.Value {
	// send question
	select {
	case <-c.done:
		// we were canceled; get out now
		runtime.Goexit()
	case <-c.ans:
		// different source of cancellation // TODO: is this needed?
		runtime.Goexit()
	case c.qs<-q:
		// sent our question
	}

	// await an answer
	return c.Answer()
}

// define a query generator in javascript, implemented by a goroutine
func WrapQuery[QX QueryContext, T any](m *QueryManager[QX], fn func(QX, *T) T) goja.Value {
	queryfunc := func(call goja.FunctionCall) goja.Value {
		// args are (qx: javascriptQX, prev: T|None, prevIsValid: bool)
		var prev *T
		if call.Arguments[2].ToBoolean() {
			tmp := call.Arguments[1].Export().(T)
			prev = &tmp
		}
		// run the query in the background
		c := NewComms(m.done)
		var result T
		var err error
		m.wg.Add(1)
		go func() {
			defer func(){
				if r := recover(); r != nil {
					err = fmt.Errorf("recovered from panic: %v", r)
				}
				close(c.qs)
				m.wg.Done()
			}()
			// ignore first value, which javascript expects of a generator
			_ = c.Answer()
			result = fn(m.qx(c), prev)
		}()

		// define a nextfunc for javascript to interact with that query
		nextfunc := func(call goja.FunctionCall) goja.Value {
			ans := call.Arguments[0]
			// send answser to goroutine
			select {
			case c.ans<-ans:
				// sent
			case <-c.qs:
				// goroutine is dead
				panic(err) // TODO: probably not the best action to take
			}
			// recv next question from goroutine
			select {
			case q, ok := <-c.qs:
				out := m.vm.NewObject()
				out.Set("done", !ok)
				if ok {
					out.Set("value", q)
				} else if err != nil {
					panic(err) // TODO: probably not the best action to take
				} else {
					out.Set("value", result)
				}
				return out
			}
		}

		out := m.vm.NewObject()
		out.Set("next", nextfunc)
		return out
	}
	return m.vm.ToValue(queryfunc)
}

///////////////////

// what about the query graph?  Is there a good way to run that too?  Hm, well user code could run
// in a goroutine perhaps.  Go iterators aren't very sophisticated or easy to write.

// func getPatrons(qx QX) map[string]Patron {
// 	out := map[string]Patron{}
// 	for patron_uuid := range qx.Patrons() {
// 		out[patron_uuid] = qx.Patron()
// 	}
// 	return out
// }

// a storage type looks like this:

type Patron goja.Object

func NewPatron(value goja.Value) *Patron {
	out := value.(*goja.Object)
	return (*Patron)(out)
}

func (p *Patron) Id() string {
	out, ok := (*goja.Object)(p).Get("id").Export().(string)
	if !ok { panic("invalid patron.id") }
	return out
}

func (p *Patron) Name() string {
	out, ok := (*goja.Object)(p).Get("name").Export().(string)
	if !ok { panic("invalid patron.name") }
	return out
}

func (p *Patron) Researcher() bool {
	out, ok := (*goja.Object)(p).Get("researcher").Export().(bool)
	if !ok { panic("invalid patron.researcher") }
	return out
}

func (p *Patron) Checkouts() *goja.Object {
	out, ok := (*goja.Object)(p).Get("checkouts").(*goja.Object)
	if !ok { panic("invalid patron.checkouts") }
	return out
}

func (p *Patron) Holds() *goja.Object {
	out, ok := (*goja.Object)(p).Get("holds").(*goja.Object)
	if !ok { panic("invalid patron.holds") }
	return out
}

// // the query context looks like this:
//
// type QX struct {
// 	question <-chan map[string]map[string]bool
// 	// answer is closed if the goroutines should shut down
// 	answer chan<- map[string]map[string]goja.Value
// }
//
// func (qx *QX) get(key string) goja.Value {
// 	select {
// 	case question<-map[string]map[string]bool{"store": map[string]bool{key: true}}:
// 	case <-qx.answer:
// 		runtime.Goexit()
// 	}
// 	ans, ok := <-qx.answer:
// 	if !ok {
// 		runtime.Goexit()
// 	}
// 	return ans["store"][key]
// }
//
// func (qx *QX) Patrons() map[string]bool {
// 	return newSet(qx.get("patrons"))
// }
//
// // query function looks like
//
// func (qx *QX) Patron(patron_uuid: string) Patron {
// 	return newPatron(qx.get(fmt.Sprintf("patron.%v", patron_uuid)))
// }
