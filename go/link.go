// Link is the basis for a circularly-linked list
//
// Example Usage:
//
// 		type Value struct {
// 			Value int
// 			Link  Link[Value]
// 		}
//
// 		func NewValue(n int) *Value {
// 			return &Value{Value: n}
// 		}
//
// 		var ValueFromLink = LinkDerefFunc[Value]("Link")
//
// 		func linkDemo() {
// 			head := Head[Value]{}
//
// 			head.Append(&NewValue(1).Link)
// 			head.Append(&NewValue(2).Link)
// 			head.Append(&NewValue(3).Link)
// 			head.Append(&NewValue(4).Link)
//
// 			println("list:")
// 			for v := range head.Iter(ValueFromLink) {
// 				println("  -", v.Value)
// 				if v.Value > 2 {
// 					v.Link.Remove()
// 				}
// 			}
//
// 			println("again:")
// 			for v := range head.Iter(ValueFromLink) {
// 				println("  -", v.Value)
// 			}
// 		}
//
// Result:
//
//		list:
//		  - 1
//		  - 2
//		  - 3
//		  - 4
//		again:
//		  - 1
//		  - 2

package main

import (
	"fmt"
	"iter"
	"reflect"
	"unsafe"
)

type Link[T any] struct {
	Next *Link[T]
	Prev *Link[T]
}

// use reflect to create a function which hides the unsafe code from the calling code
func LinkDerefFunc[T any](field string) func(*Link[T]) *T {
	var zero T
	typ := reflect.TypeOf(zero)
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		if f.Name != field {
			continue
		}
		// make sure it's the right type
		var exp Link[T]
		if f.Type != reflect.TypeOf(exp) {
			panic(
				fmt.Sprintf(
					"expected %T.%v to be of type %T but found %v",
					zero,
					field,
					exp,
					f.Type,
				),
			)
		}
		return func(l *Link[T]) *T {
			return (*T)(unsafe.Pointer(uintptr(unsafe.Pointer(l)) - f.Offset))
		}
	}
	panic(fmt.Sprintf("struct %T has no field %v", zero, field))
}

// Head is just a special use of a Link
type Head[T any] Link[T]

func (h *Head[T]) IsEmpty() bool {
	return h.Next == nil || h.Next == (*Link[T])(h)
}

// head.Iter() will yield each link of the list, ensuring that it is safe to .Remove() the link
// that has been currently yielded.
func (h *Head[T]) Iter(deref func(*Link[T]) *T) iter.Seq[*T] {
	return func(yield func(*T) bool) {
		next := h.Next
		if h.Next == nil {
			return
		}
		// capture one node ahead of what we will emit, so it safe to remove a node as we iterate
		nextnext := next.Next
		for next != (*Link[T])(h) {
			if !yield(deref(next)) {
				return
			}
			next = nextnext
			nextnext = nextnext.Next
		}
	}
}

// head.Append inserts before `head`, which is the end of a circularly-linked list
func (h *Head[T]) Append(l *Link[T]) {
	if h.Next == nil {
		// initialize
		h.Next = (*Link[T])(h)
		h.Prev = (*Link[T])(h)
	}
	l.Next = (*Link[T])(h)
	l.Prev = h.Prev
	h.Prev.Next = l
	h.Prev = l
}

// head.Prepend inserts after `head`, which is the beginning of a circularly-linked list
func (h *Head[T]) Prepend(l *Link[T]) {
	if h.Next == nil {
		// initialize
		h.Next = (*Link[T])(h)
		h.Prev = (*Link[T])(h)
	}
	l.Prev = (*Link[T])(h)
	l.Next = h.Next
	h.Next.Prev = l
	h.Next = l
}

func (h *Head[T]) PeekFirst(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Next)
}

func (h *Head[T]) PeekLast(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Prev)
}

func (h *Head[T]) PopFirst(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Next.Remove())
}

func (h *Head[T]) PopLast(deref func(*Link[T]) *T) *T {
	if h.IsEmpty() {
		return nil
	}
	return deref(h.Prev.Remove())
}

// Remove a link from the list
func (l *Link[T]) Remove() *Link[T] {
	if l.Next == nil {
		// initialize
		l.Next = l
		l.Prev = l
	}
	l.Prev.Next = l.Next
	l.Next.Prev = l.Prev
	l.Prev = l
	l.Next = l
	return l
}
