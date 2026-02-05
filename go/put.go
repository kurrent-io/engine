package main

// #include <stdint.h>
import "C"

import (
	"unsafe"
)

var stack []interface{}

//export putNull
func putNull() {
	stack = append(stack, nil)
}

//export putUndefined
func putUndefined() {
	stack = append(stack, nil)
}

//export putBoolean
func putBoolean(s C.int) {
	stack = append(stack, s != 0)
}

//export putString
func putString(s C.uintptr_t, l C.size_t) {
	str := unsafe.String((*byte)(unsafe.Pointer(uintptr(s))), l)
	println("put string", str)
	stack = append(stack, str)
}

//export putInt
func putInt(n C.int32_t) {
	stack = append(stack, int32(n))
}

//export putBigInt
func putBigInt(n C.int64_t) {
	stack = append(stack, int64(n))
}

//export putFloat
func putFloat(f C.double) {
	stack = append(stack, float64(f))
}


//export openArray
func openArray(n C.size_t) {
	stack = append(stack, make([]any, n))
}

//export putItem
func putItem(i C.int) {
	var arr, item any
	n := len(stack)
	stack, arr, item = stack[:n - 1], stack[n - 2], stack[n - 1]
	arr.([]any)[i] = item
}

//export putArray
func putArray(C.size_t) {
	// noop for us
}


//export openObject
func openObject(n C.size_t) {
	stack = append(stack, make(map[string]any, n))
}

//export putKey
func putKey(s C.uintptr_t, l C.size_t) {
	key := unsafe.String((*byte)(unsafe.Pointer(uintptr(s))), l)
	var obj, val any
	n := len(stack)
	stack, obj, val = stack[:n - 1], stack[n - 2], stack[n - 1]
	obj.(map[string]any)[key] = val
}

//export putObject
func putObject(C.size_t) {
	// noop for us
}
