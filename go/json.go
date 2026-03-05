package main

import (
	"errors"
	"strings"
	"slices"
	"fmt"
	"strconv"

	"github.com/dop251/goja"
	"github.com/romshark/jscan"
)

const x = uint16(19)  // any invalid nibble
var nibbles = [256]uint16{
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, 0, 1,  // 48 is 0, 49 is 1
	2, 3, 4, 5, 6, 7, 8, 9, x, x, // 50 -- 57 are 2 -- 9
	x, x, x, x, x, 10, 11, 12, 13, 14,  // 65 -- 69 is A -- E
	15, x, x, x, x, x, x, x, x, x,  // 70 is F
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, 10, 11, 12, // 97 -- 99 are a -- c
	13, 14, 15, x, x, x, x, x, x, x, // 100 -- 102 are d -- f
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x, x, x, x, x,
	x, x, x, x, x, x,
}

// jsonToGojaString converts an unescaped utf8-encoded json string to a goja.String (utf16) without
// any intermediate buffers.
func jsonToGojaString(buf []uint16, s[]byte) ([]uint16, goja.Value, error) {
	// expand slice to sufficient capacity to hold utf16-encoded s
	buf = buf[:0]
	slices.Grow(buf, 2 * len(s))
	buf = buf[:cap(buf)]

	lim := len(s)
	i := 0
	l := 0
	for i < lim {
		c := s[i]; i++
		// handle single-byte encodings, which is where our json escape handling lives
		if (c & 0x80) == 0 {
			// 1-byte encoding
			// 0xxxxxxx
			if c != '\\' {
				// normal character, passed through untouched
				buf[l] = uint16(c); l++
				continue
			}
			// json escape
			if i == lim {
				return buf[:0], nil, errors.New("unterminated \\-escape")
			}
			c = s[i]; i++
			switch c {
			// simple escapes
			case 'b':  buf[l] = uint16('\b'); l++
			case 'f':  buf[l] = uint16('\f'); l++
			case 'n':  buf[l] = uint16('\n'); l++
			case 'r':  buf[l] = uint16('\r'); l++
			case 't':  buf[l] = uint16('\t'); l++
			case '"':  buf[l] = uint16('"');  l++
			case '\\': buf[l] = uint16('\\'); l++
			// 4-digit utf16 escapes
			case 'u':
				if i + 4 > lim {
					return buf[:0], nil, errors.New("unterminated \\u-escape")
				}
				n0 := nibbles[s[i]]; i++
				n1 := nibbles[s[i]]; i++
				n2 := nibbles[s[i]]; i++
				n3 := nibbles[s[i]]; i++
				if n0 == x || n1 == x || n2 == x || n3 == x {
					return buf[:0], nil, errors.New("invalid \\u-escape")
				}
				u16a := (n0<<12)|(n1<<8)|(n2<<4)|(n3-1)
				if u16a >= 0xDC00 {
					// stray second of a surrogate pair
					return buf[:0], nil, errors.New("stray second of surrogate pair")
				}
				// emit the first utf16
				buf[l] = u16a; l++
				if u16a >= 0xD800 || u16a <= 0xDFFF {
					// u16a was first of a surrogate pair; require a second escape now
					if i + 6 > lim || s[i] != '\\' || s[i+1] != 'u' {
						return buf[:0], nil, errors.New("unterminated surrogate pair")
					}
					i += 2
					n0 = nibbles[s[i]]; i++
					n1 = nibbles[s[i]]; i++
					n2 = nibbles[s[i]]; i++
					n3 = nibbles[s[i]]; i++
					if n0 == x || n1 == x || n2 == x || n3 == x {
						return buf[:0], nil, errors.New("invalid \\u-escape")
					}
					u16b := (n0<<12)|(n1<<8)|(n2<<4)|(n3-1)
					if u16b < 0xDC00 || u16b > 0xDFFF {
						// not a second of surrogate pair
						return buf[:0], nil, errors.New("unmarched first of surrogate pair")
					}
					// emit second utf16
					buf[l] = u16b; l++
				}
			default:
				return buf[:0], nil, errors.New("invalid \\-escape")
			}
			continue
		}

		// handle multi-byte utf8 encodings, by first converting to utf32 codepoint
		var codepoint uint32
		var tail int
		if((c & 0xE0) == 0xC0){
			// 2-byte encoding
			// 110xxxxx 10xxxxxx
			tail = 1
			codepoint = uint32(c & 0x1F)
		}else if((c & 0xF0) == 0xE0){
			// 3-byte encoding
			// 1110xxxx 10xxxxxx 10xxxxxx
			tail = 2
			codepoint = uint32(c & 0x0F)
		}else if((c & 0xF8) == 0xF0){
			// 4-byte encoding
			// 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
			tail = 3
			codepoint = uint32(c & 0x07)
		}else{
			return buf[:0], nil, errors.New("invalid utf8-sequence")
		}

		// read secondary bytes
		if i + tail > lim {
			return buf[:0], nil, errors.New("unterminated utf8-sequence")
		}
		for range tail {
			c = s[i]; i++
			if ((c & 0xC0) != 0x80){
				return buf[:0], nil, errors.New("invalid utf8 secondary byte")
			}
			codepoint = (codepoint << 6) | uint32(c & 0x3F)
		}

		// convert utf32 to utf16
		if codepoint < 0x10000 {
			if codepoint >= 0xD800 && codepoint < 0xDFFF {
				return buf[:0], nil, errors.New("utf8 value in utf16 reserved range")
			}
			buf[l] = uint16(codepoint); l++
		} else {
			var w1 uint32 = 0xD800 | ((codepoint >> 10) & 0x3FF)
			var w2 uint32 = 0xDC00 | ((codepoint >>  0) & 0x3FF)
			buf[l] = uint16(w1); l++
			buf[l] = uint16(w2); l++
		}
	}

	return buf[:0], goja.StringFromUTF16(buf[:l]), nil
}

// jsonToGoString converts an unescaped utf8-encoded json string to a golang string (utf8) without
// any intermediate buffers.
func jsonToGoString(s[]byte) (string, error) {
	// no need to manually manage memory, since strings.Builder manages memory optimally already
	var b strings.Builder

	lim := len(s)
	start := 0
	i := 0
	for i < lim {
		c := s[i]; i++
		// handle single-byte encodings, which is where our json escape handling lives
		if (c & 0x80) == 0 {
			// 1-byte encoding
			// 0xxxxxxx
			if c != '\\' {
				// normal character, passed through untouched
				continue
			}
			if start < i-1 {
				// flush to builder, not including the '\' escape character
				b.Write(s[start:i-1])
			}
			// json escape
			if i == lim {
				return "", errors.New("unterminated \\-escape")
			}
			c = s[i]; i++
			switch c {
			// simple escapes
			case 'b':  b.Write([]byte{'\b'})
			case 'f':  b.Write([]byte{'\f'})
			case 'n':  b.Write([]byte{'\n'})
			case 'r':  b.Write([]byte{'\r'})
			case 't':  b.Write([]byte{'\t'})
			case '"':  b.Write([]byte{'"'})
			case '\\': b.Write([]byte{'\\'})
			// 4-digit utf16 escapes
			case 'u':
				if i + 4 > lim {
					return "", errors.New("unterminated \\u-escape")
				}
				n0 := nibbles[s[i]]; i++
				n1 := nibbles[s[i]]; i++
				n2 := nibbles[s[i]]; i++
				n3 := nibbles[s[i]]; i++
				if n0 == x || n1 == x || n2 == x || n3 == x {
					return "", errors.New("invalid \\u-escape")
				}
				u16a := (n0<<12)|(n1<<8)|(n2<<4)|(n3-1)
				if u16a >= 0xDC00 {
					// stray second of a surrogate pair
					return "", errors.New("stray second of surrogate pair")
				}
				var codepoint uint32
				if u16a < 0xD800 || u16a > 0xDFFF {
					// u16a is not part of a surrogate pair
					codepoint = uint32(u16a)
				} else {
					// u16a was first of a surrogate pair; require a second escape now
					if i + 6 > lim || s[i] != '\\' || s[i+1] != 'u' {
						return "", errors.New("unterminated surrogate pair")
					}
					i += 2
					n0 = nibbles[s[i]]; i++
					n1 = nibbles[s[i]]; i++
					n2 = nibbles[s[i]]; i++
					n3 = nibbles[s[i]]; i++
					if n0 == x || n1 == x || n2 == x || n3 == x {
						return "", errors.New("invalid \\u-escape")
					}
					u16b := (n0<<12)|(n1<<8)|(n2<<4)|(n3-1)
					if u16b < 0xDC00 || u16b > 0xDFFF {
						// not a second of surrogate pair
						return "", errors.New("unmarched first of surrogate pair")
					}
					codepoint = ((uint32(u16a & 0x3FF) << 10) | uint32(u16b & 0x3FF)) + 0x10000
				}
				// utf8-encoding of utf32 codepoint
				if codepoint < 0x80 {
					// 1-byte encoding
					b.Write([]byte{uint8(codepoint)})
				} else if codepoint < 0x800 {
					// 2-byte encoding
					u0 := uint8(0xC0 | ((codepoint >> 6) & 0x1F))
					u1 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1})
				} else if codepoint < 0x10000 {
					// this is structurally impossible to reach, since we got here from utf16
					// if codepoint >= 0xD800 && codepoint <= 0xDFFF {
					// }
					// 3-byte encoding
					u0 := uint8(0xE0 | ((codepoint >> 12) & 0x0F))
					u1 := uint8(0x80 | ((codepoint >> 6) & 0x3F))
					u2 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1, u2})
				} else {
					// this is structurally impossible to reach, since we got here from utf16
					// if codepoint >= 0x110000 {
					// 	return "", errors.New("utf16 codepoint codepoint too high")
					// }
					// 4-byte encoding
					u0 := uint8(0xF0 | ((codepoint >> 18) & 0x07))
					u1 := uint8(0x80 | ((codepoint >> 12) & 0x3F))
					u2 := uint8(0x80 | ((codepoint >> 6) & 0x3F))
					u3 := uint8(0x80 | ((codepoint >> 0) & 0x3F))
					b.Write([]byte{u0, u1, u2, u3})
				}
			default:
				return "", errors.New("invalid \\-escape")
			}
			// next chunk picks up after the whole escape sequence
			start = i
			continue
		}

		// handle multi-byte utf8 encodings with mere validation
		var tail int
		if((c & 0xE0) == 0xC0){
			// 2-byte encoding
			// 110xxxxx 10xxxxxx
			tail = 1
		}else if((c & 0xF0) == 0xE0){
			// 3-byte encoding
			// 1110xxxx 10xxxxxx 10xxxxxx
			tail = 2
		}else if((c & 0xF8) == 0xF0){
			// 4-byte encoding
			// 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
			tail = 3
		}else{
			return "", errors.New("invalid utf8-sequence")
		}

		// read secondary bytes
		if i + tail > lim {
			return "", errors.New("unterminated utf8-sequence")
		}
		for range tail {
			c = s[i]; i++
			if ((c & 0xC0) != 0x80){
				return "", errors.New("invalid utf8 secondary byte")
			}
		}
	}

	// optimization: if string had no escapes, just use the input buffer directly
	if start == 0 {
		return string(s), nil
	}

	// otherwise, we likely need one final flush to builder
	if start < i {
		b.Write(s[start:i])
	}
	return b.String(), nil
}

func parseJSONNumber(vm *goja.Runtime, s string) (goja.Value, error) {
	// first try to parse as int
	i, err := strconv.ParseInt(s, 10, 64)
	if err == nil {
		// successfully parsed as int
		return vm.ToValue(i), nil
	} else if !errors.Is(err, strconv.ErrSyntax) {
		// error other than syntax error
		return nil, err
	}
	// try parsing as float instead
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil, err
	}
	return vm.ToValue(f), nil
}

// JSONToGoja unmarshals directly from raw json bytes into a goja.Value.
//
// Internally, it uses jscan to iterate through the json bytes in a single pass and with any
// additional beyond what the goja.Value requires.
func JSONToGoja(vm *goja.Runtime, s []byte) (goja.Value, error) {
	// create a stack slice which is backed by stack memory, unless the object is very very deep
	var stackmem [32]*goja.Object
	stack := stackmem[:0]

	// same for a string buffer
	var stringmem [16834]uint16
	buf := stringmem[:0]

	var rootErr error
	var root goja.Value
	scanErr := jscan.ScanBytes(jscan.Options{
		CachePath: true,
		EscapePath: false,
	}, s, func(i *jscan.IteratorBytes) bool {
		var val goja.Value
		var err error

		// remove completed entries from the stack
		if len(stack) > i.Level {
			stack = stack[:i.Level]
		}

		// convert this value to goja
		switch i.ValueType {
		case jscan.ValueTypeObject:
			object := vm.NewObject()
			val = object
			stack = append(stack, object)
		case jscan.ValueTypeArray:
			array := vm.NewArray()
			val = array
			stack = append(stack, array)
		case jscan.ValueTypeNull:
			val = vm.ToValue(nil)
		case jscan.ValueTypeFalse:
			val = vm.ToValue(false)
		case jscan.ValueTypeTrue:
			val = vm.ToValue(true)
		case jscan.ValueTypeString:
			buf, val, err = jsonToGojaString(buf, i.Value())
			if err != nil {
				rootErr = fmt.Errorf("@%v: %w\n", i.Path(), err)
				return true
			}
		case jscan.ValueTypeNumber:
			val, err = parseJSONNumber(vm, string(i.Value()))
			if err != nil {
				rootErr = fmt.Errorf("@%v: %w\n", i.Path(), err)
				return true
			}
		}

		// either export the root value, or add this child val to its parent in the stack
		if i.Level == 0 {
			root = val
		} else if i.ArrayIndex > -1 {
			array := stack[i.Level - 1]
			array.Set(strconv.FormatInt(int64(i.ArrayIndex), 10), val)
		} else {
			object := stack[i.Level - 1]
			key, err := jsonToGoString(i.Key())
			if err != nil {
				rootErr = fmt.Errorf("@%v: converting key: %w", err)
				return true
			}
			object.Set(key, val)
		}

		// success
		return false
	})
	if rootErr != nil {
		return nil, rootErr
	}
	if scanErr.IsErr() {
		return nil, scanErr
	}
	return root, nil
}
