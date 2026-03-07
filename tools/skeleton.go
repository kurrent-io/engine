//// link //////////////////////////////////////////////////////////////////////////////////////////

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

//// json //////////////////////////////////////////////////////////////////////////////////////////

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

//// framework /////////////////////////////////////////////////////////////////////////////////////

type Ask = func(goja.Value) goja.Value

type QueryContext interface {
	Ask(goja.Value) goja.Value
}

func queryAsk(vm *goja.Runtime, ask Ask, key string, keyargs... interface{}) goja.Value {
	if len(keyargs) > 0 {
		key = fmt.Sprintf(key, keyargs...)
	}
	store := vm.NewObject()
	store.Set(key, true)
	question := vm.NewObject()
	question.Set("store", store)
	answer := ask(question).(*goja.Object).Get("store").(*goja.Object).Get("key").(*goja.Object)
	if err := answer.Get("err"); !goja.IsUndefined(err) {
		panic(err)
	}
	return answer.Get("value")
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

type GoShaper[E any, P any] struct {
	shaper func([]E) ([]E, P)
}

func NewGoShaper[E any, P any](shaper func ([]E) ([]E, P)) Shaper[E, P] {
	return GoShaper[E, P]{shaper}
}

func (s GoShaper[E, P]) ToShaper(vm *goja.Runtime) (goja.Value, error) {
	jsfunc := func(call goja.FunctionCall) goja.Value {
		var eventsIn []E
		err := vm.ExportTo(call.Arguments[0], &eventsIn)
		if err != nil {
			panic(err)
		}
		eventsOut, checkpoint := s.shaper(eventsIn)
		out := vm.NewObject()
		out.Set("events", eventsOut)
		out.Set("checkpoint", checkpoint)
		return out
	}
	return vm.ToValue(jsfunc), nil
}

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

func consoleLog(call goja.FunctionCall) goja.Value {
	var out []string
	for _, arg := range call.Arguments {
		out = append(out, arg.String())
	}
	println(strings.Join(out, " "))
	return nil
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

type Framework[QX QueryContext, PX any, E any, C any, P any] struct {
	vm *goja.Runtime
	fw *goja.Object
	decoder func (events goja.Value) (goja.Value, error)
	run func() error
	newQuery goja.Callable
	recvEvents goja.Callable
	qxFactory func(*goja.Runtime, Ask) QX
}

func NewFramework[QX QueryContext, PX any, E any, C any, P any](
	source Source,
	storage Storage,
	decoder Decoder[E],
	shaper Shaper[E, P],
	projector Projector[PX, E],
	qxFactory func(*goja.Runtime, Ask) QX,
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

func (f *Framework[QX, PX, E, C, P]) VM() *goja.Runtime {
	return f.vm
}

func (f *Framework[QX, PX, E, C, P]) Run() error {
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
	fn func(vm *goja.Runtime, qx QX, prev *T) T,
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
			qx := fw.qxFactory(fw.vm, ask)
			return fn(fw.vm, qx, prev)
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
