// Proof: pretokenized, schema-derived decoding for a Go host.
//
// Pipeline: transport bytes -> one tokenization pass filling a reusable
// token array (plus an arena for strings that needed decoding) -> generated
// recursive-descent decoders indexing the array -> real values.  Native
// decoders return the generated rich native types (the same family used to
// author commands); JS decoders build rich values directly in the goja heap.
//
// The token contract is fully decoded: strings are UTF-8 spans (into the
// source where possible, into the arena where unescaping copied), numbers
// are parsed scalars.  Transports own all format knowledge; the walks are
// transport-blind.
//
// The index pre-pass patches each container token with its element count
// and the token index past its end, so everything that used to need
// buffering is O(1): skip is a jump, tuple-length dispatch reads a count
// (identical cost for JSON and msgpack), discriminator scans walk a
// cache-hot array without consuming anything.
//
// Demonstrated:
//   - typed native output: sealed-interface unions, struct fields, real
//     time.Time and set types; decoders declare what they emit
//   - path-based errors collected across the whole value; encoding errors
//     surface as an immediate fatal at construction; check = decode+discard
//   - union dispatch per solver Solution: CheckJsonType (token kind),
//     GetField+CheckLiteral (non-consuming discriminator scan), HasField
//     (oneof), CheckLength (patched element counts)
//   - scalar lifting during the walk: RFC3339 -> time.Time / JS Date,
//     string arrays -> map[string]struct{} / JS Set
//   - two transports producing one token representation: JSON (stock,
//     hand-rolled, full escape/surrogate handling) and msgpack (user code)
package main

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/vmihailenco/msgpack/v5"
)

// ============================== //skeleton =================================
// Written once per host language.

// --- tokens ---

type Kind uint8

const (
	KInvalid Kind = iota
	KBeginObj
	KEndObj
	KBeginArr
	KEndArr
	KKey
	KString
	KInt
	KFloat
	KBool
	KNull
)

var kindNames = [...]string{
	"invalid", "object", "end-object", "array", "end-array",
	"key", "string", "int", "float", "bool", "null",
}

func (k Kind) String() string { return kindNames[k] }

const flagArena = 1 << 0 // string span points into the arena, not the source

// Tok is one decoded token.  Strings carry a UTF-8 span (Off/Num into the
// source or the arena); containers carry their element count in Num and the
// token index just past their matching end in End; numbers and bools are
// parsed into I/F.
type Tok struct {
	Kind  Kind
	Flags uint8
	Off   uint32
	Num   uint32
	End   uint32
	I     int64
	F     float64
}

// --- decode state ---

type DecodeError struct {
	Path string
	Msg  string
}

func (e DecodeError) Error() string { return e.Path + ": " + e.Msg }

// D is the state threaded through one decode: the tokenized message, a read
// position, the current path, and the error accumulator.  An encoding error
// sets fatal (usually at construction) and every helper short-circuits.
type D struct {
	src   []byte
	arena []byte
	toks  []Tok
	pos   int
	path  []string
	errs  []DecodeError
	fatal error
}

// NewD wraps a pretokenized message.  Transports produce the token array
// (and the arena, when decoding required copies) however they like.
func NewD(src, arena []byte, toks []Tok) *D {
	return &D{src: src, arena: arena, toks: toks}
}

// NewJSONDecoder returns a decoder over the stock JSON transport.
func NewJSONDecoder(r io.Reader) *D {
	src, err := io.ReadAll(r)
	if err != nil {
		return &D{fatal: err}
	}
	toks, arena, err := tokenizeJSON(src, nil, nil)
	d := NewD(src, arena, toks)
	d.fatal = err
	return d
}

// finish reports one entry point's results.  Errors report per call, so a
// decoder can be reused for successive values on one stream; a transport
// error poisons it for good.
func (d *D) finish() ([]DecodeError, error) {
	errs := d.errs
	d.errs = nil
	return errs, d.fatal
}

func (d *D) ok() bool        { return d.fatal == nil }
func (d *D) push(seg string) { d.path = append(d.path, seg) }
func (d *D) pop()            { d.path = d.path[:len(d.path)-1] }

func (d *D) errf(format string, args ...any) {
	if d.fatal != nil {
		return
	}
	d.errs = append(d.errs, DecodeError{
		Path: "$" + strings.Join(d.path, ""),
		Msg:  fmt.Sprintf(format, args...),
	})
}

func (d *D) next() Tok {
	if d.fatal != nil {
		return Tok{}
	}
	if d.pos >= len(d.toks) {
		d.fatal = io.ErrUnexpectedEOF
		return Tok{}
	}
	t := d.toks[d.pos]
	d.pos++
	return t
}

// peek returns the next token without consuming it.
func (d *D) peek() Tok {
	if d.fatal != nil || d.pos >= len(d.toks) {
		return Tok{}
	}
	return d.toks[d.pos]
}

// span returns a string token's decoded UTF-8 bytes.
func (d *D) span(t Tok) []byte {
	b := d.src
	if t.Flags&flagArena != 0 {
		b = d.arena
	}
	return b[t.Off : t.Off+t.Num]
}

// skipFrom consumes the remainder of a value whose first token was t.
func (d *D) skipFrom(t Tok) {
	if t.Kind == KBeginObj || t.Kind == KBeginArr {
		d.pos = int(t.End)
	}
}

// skipValue consumes one complete value.
func (d *D) skipValue() { d.skipFrom(d.next()) }

func (d *D) mismatch(want string, got Tok) {
	d.errf("expected %s, got %s", want, got.Kind)
	d.skipFrom(got)
}

// requireFields reports every required field whose bit (by position in
// names) is absent from seen.
func (d *D) requireFields(seen uint32, names ...string) {
	for i, n := range names {
		if seen&(1<<uint(i)) == 0 {
			d.push("." + n)
			d.errf("missing required field")
			d.pop()
		}
	}
}

// --- scalar readers: consume one value, record a path error on mismatch ---

func (d *D) readStr() (string, bool) {
	t := d.next()
	if t.Kind != KString {
		d.mismatch("string", t)
		return "", false
	}
	return string(d.span(t)), true
}

func (d *D) readStrLit(want string) {
	t := d.next()
	if t.Kind != KString {
		d.mismatch("string", t)
		return
	}
	if string(d.span(t)) != want {
		d.errf("expected literal %q, got %q", want, d.span(t))
	}
}

func (d *D) readBool() (bool, bool) {
	t := d.next()
	if t.Kind != KBool {
		d.mismatch("bool", t)
		return false, false
	}
	return t.I != 0, true
}

func (d *D) readInt() (int64, bool) {
	t := d.next()
	if t.Kind != KInt {
		d.mismatch("int", t)
		return 0, false
	}
	return t.I, true
}

func (d *D) readFloat() (float64, bool) {
	t := d.next()
	switch t.Kind {
	case KFloat:
		return t.F, true
	case KInt:
		return float64(t.I), true
	}
	d.mismatch("number", t)
	return 0, false
}

func (d *D) readDate() (time.Time, bool) {
	t := d.next()
	if t.Kind != KString {
		d.mismatch("date string", t)
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339, string(d.span(t)))
	if err != nil {
		d.errf("invalid date %q", d.span(t))
		return time.Time{}, false
	}
	return ts, true
}

func (d *D) readStrList() ([]string, bool) {
	t := d.next()
	if t.Kind != KBeginArr {
		d.mismatch("array", t)
		return nil, false
	}
	var items []string
	for i := 0; d.ok(); i++ {
		et := d.next()
		if et.Kind == KEndArr {
			break
		}
		if et.Kind != KString {
			d.push(fmt.Sprintf("[%d]", i))
			d.errf("expected string, got %s", et.Kind)
			d.pop()
			d.skipFrom(et)
			continue
		}
		items = append(items, string(d.span(et)))
	}
	return items, true
}

// --- field helpers: constant path segment around one read ---

func (d *D) fieldStr(seg string) (string, bool) {
	d.push(seg)
	s, ok := d.readStr()
	d.pop()
	return s, ok
}

func (d *D) fieldLit(seg, want string) {
	d.push(seg)
	d.readStrLit(want)
	d.pop()
}

func (d *D) fieldBool(seg string) (bool, bool) {
	d.push(seg)
	b, ok := d.readBool()
	d.pop()
	return b, ok
}

func (d *D) fieldInt(seg string) (int64, bool) {
	d.push(seg)
	i, ok := d.readInt()
	d.pop()
	return i, ok
}

func (d *D) fieldDate(seg string) (time.Time, bool) {
	d.push(seg)
	ts, ok := d.readDate()
	d.pop()
	return ts, ok
}

func (d *D) fieldStrList(seg string) ([]string, bool) {
	d.push(seg)
	ss, ok := d.readStrList()
	d.pop()
	return ss, ok
}

// --- discrimination helpers (non-consuming index walks) ---

// discriminant returns the value token of the named field of the object at
// the current position.  The caller has verified the current token is
// KBeginObj; nothing is consumed.
func (d *D) discriminant(key string) (Tok, bool) {
	pos := d.pos + 1
	for {
		kt := d.toks[pos]
		if kt.Kind != KKey {
			return Tok{}, false // KEndObj
		}
		vt := d.toks[pos+1]
		if string(d.span(kt)) == key {
			return vt, vt.Kind == KString
		}
		if vt.Kind == KBeginObj || vt.Kind == KBeginArr {
			pos = int(vt.End)
		} else {
			pos += 2
		}
	}
}

// firstKey returns the first key token of the object at the current
// position.  The caller has verified KBeginObj; nothing is consumed.
func (d *D) firstKey() (Tok, bool) {
	kt := d.toks[d.pos+1]
	return kt, kt.Kind == KKey
}

// endArr consumes the closing token, complaining about extra elements.
func (d *D) endArr() {
	for d.ok() {
		t := d.next()
		if t.Kind == KEndArr {
			return
		}
		d.errf("unexpected extra tuple element")
		d.skipFrom(t)
	}
}

// --- JS heap helpers for the JS-building decoders ---

type JS struct {
	vm   *goja.Runtime
	date goja.Constructor
	set  goja.Constructor
}

func NewJS(vm *goja.Runtime) *JS {
	date, _ := goja.AssertConstructor(vm.Get("Date"))
	set, _ := goja.AssertConstructor(vm.Get("Set"))
	return &JS{vm: vm, date: date, set: set}
}

func (j *JS) Time(t time.Time) goja.Value {
	v, _ := j.date(nil, j.vm.ToValue(t.UnixMilli()))
	return v
}

func (j *JS) StrSet(ss []string) goja.Value {
	items := make([]any, len(ss))
	for i, s := range ss {
		items[i] = s
	}
	v, _ := j.set(nil, j.vm.NewArray(items...))
	return v
}

// --- stock JSON tokenizer ---

const maxDepth = 512

type jsonTokenizer struct {
	src   []byte
	pos   int
	depth int
	toks  []Tok
	arena []byte
}

// tokenizeJSON tokenizes every whitespace-separated top-level value in src.
// The toks and arena arguments are reusable buffers from a prior message.
func tokenizeJSON(src []byte, toks []Tok, arena []byte) ([]Tok, []byte, error) {
	t := &jsonTokenizer{src: src, toks: toks[:0], arena: arena[:0]}
	for {
		t.ws()
		if t.pos >= len(t.src) {
			return t.toks, t.arena, nil
		}
		if err := t.value(); err != nil {
			return t.toks, t.arena, err
		}
	}
}

func (t *jsonTokenizer) errAt(msg string) error {
	return fmt.Errorf("json: %s at offset %d", msg, t.pos)
}

func (t *jsonTokenizer) ws() {
	for t.pos < len(t.src) {
		switch t.src[t.pos] {
		case ' ', '\t', '\n', '\r':
			t.pos++
		default:
			return
		}
	}
}

func (t *jsonTokenizer) peekByte() byte {
	if t.pos < len(t.src) {
		return t.src[t.pos]
	}
	return 0
}

func (t *jsonTokenizer) value() error {
	t.ws()
	if t.pos >= len(t.src) {
		return t.errAt("unexpected end of input")
	}
	switch t.src[t.pos] {
	case '{':
		return t.object()
	case '[':
		return t.array()
	case '"':
		return t.string(KString)
	case 't':
		return t.lit("true", Tok{Kind: KBool, I: 1})
	case 'f':
		return t.lit("false", Tok{Kind: KBool})
	case 'n':
		return t.lit("null", Tok{Kind: KNull})
	default:
		return t.number()
	}
}

func (t *jsonTokenizer) lit(word string, tok Tok) error {
	if !bytes.HasPrefix(t.src[t.pos:], []byte(word)) {
		return t.errAt("invalid literal")
	}
	t.pos += len(word)
	t.toks = append(t.toks, tok)
	return nil
}

func (t *jsonTokenizer) object() error {
	if t.depth++; t.depth > maxDepth {
		return t.errAt("maximum nesting depth exceeded")
	}
	open := len(t.toks)
	t.toks = append(t.toks, Tok{Kind: KBeginObj})
	t.pos++ // '{'
	n := uint32(0)
	t.ws()
	if t.peekByte() == '}' {
		t.pos++
	} else {
		for {
			t.ws()
			if t.peekByte() != '"' {
				return t.errAt("expected object key")
			}
			if err := t.string(KKey); err != nil {
				return err
			}
			t.ws()
			if t.peekByte() != ':' {
				return t.errAt("expected ':'")
			}
			t.pos++
			if err := t.value(); err != nil {
				return err
			}
			n++
			t.ws()
			c := t.peekByte()
			if c == ',' {
				t.pos++
				continue
			}
			if c != '}' {
				return t.errAt("expected ',' or '}'")
			}
			t.pos++
			break
		}
	}
	t.toks = append(t.toks, Tok{Kind: KEndObj})
	t.toks[open].Num = n
	t.toks[open].End = uint32(len(t.toks))
	t.depth--
	return nil
}

func (t *jsonTokenizer) array() error {
	if t.depth++; t.depth > maxDepth {
		return t.errAt("maximum nesting depth exceeded")
	}
	open := len(t.toks)
	t.toks = append(t.toks, Tok{Kind: KBeginArr})
	t.pos++ // '['
	n := uint32(0)
	t.ws()
	if t.peekByte() == ']' {
		t.pos++
	} else {
		for {
			if err := t.value(); err != nil {
				return err
			}
			n++
			t.ws()
			c := t.peekByte()
			if c == ',' {
				t.pos++
				continue
			}
			if c != ']' {
				return t.errAt("expected ',' or ']'")
			}
			t.pos++
			break
		}
	}
	t.toks = append(t.toks, Tok{Kind: KEndArr})
	t.toks[open].Num = n
	t.toks[open].End = uint32(len(t.toks))
	t.depth--
	return nil
}

// string scans a string value or key.  The fast path spans the source
// directly (unescaped JSON string bytes are literal UTF-8); on the first
// backslash it switches to decoding into the arena.
func (t *jsonTokenizer) string(kind Kind) error {
	t.pos++ // '"'
	start := t.pos
	for t.pos < len(t.src) {
		switch c := t.src[t.pos]; {
		case c == '"':
			t.toks = append(t.toks, Tok{
				Kind: kind, Off: uint32(start), Num: uint32(t.pos - start),
			})
			t.pos++
			return nil
		case c == '\\':
			return t.stringEscaped(kind, start)
		case c < 0x20:
			return t.errAt("control character in string")
		default:
			t.pos++
		}
	}
	return t.errAt("unterminated string")
}

// stringEscaped continues a string scan from its first backslash, decoding
// escapes (utf8json -> utf8) into the arena.
func (t *jsonTokenizer) stringEscaped(kind Kind, start int) error {
	aStart := len(t.arena)
	t.arena = append(t.arena, t.src[start:t.pos]...)
	for t.pos < len(t.src) {
		switch c := t.src[t.pos]; {
		case c == '"':
			t.toks = append(t.toks, Tok{
				Kind: kind, Flags: flagArena,
				Off: uint32(aStart), Num: uint32(len(t.arena) - aStart),
			})
			t.pos++
			return nil
		case c == '\\':
			t.pos++
			if t.pos >= len(t.src) {
				return t.errAt("unterminated escape")
			}
			switch e := t.src[t.pos]; e {
			case '"', '\\', '/':
				t.arena = append(t.arena, e)
				t.pos++
			case 'b':
				t.arena = append(t.arena, '\b')
				t.pos++
			case 'f':
				t.arena = append(t.arena, '\f')
				t.pos++
			case 'n':
				t.arena = append(t.arena, '\n')
				t.pos++
			case 'r':
				t.arena = append(t.arena, '\r')
				t.pos++
			case 't':
				t.arena = append(t.arena, '\t')
				t.pos++
			case 'u':
				t.pos++
				r, err := t.uEscape()
				if err != nil {
					return err
				}
				t.arena = utf8.AppendRune(t.arena, r)
			default:
				return t.errAt("invalid escape")
			}
		case c < 0x20:
			return t.errAt("control character in string")
		default:
			t.arena = append(t.arena, c)
			t.pos++
		}
	}
	return t.errAt("unterminated string")
}

// uEscape decodes the hex of a \u escape (the pos is just past the 'u'),
// consuming the paired second escape of a surrogate pair.
func (t *jsonTokenizer) uEscape() (rune, error) {
	h1, err := t.hex4()
	if err != nil {
		return 0, err
	}
	r := rune(h1)
	if !utf16.IsSurrogate(r) {
		return r, nil
	}
	if t.pos+2 > len(t.src) || t.src[t.pos] != '\\' || t.src[t.pos+1] != 'u' {
		return 0, t.errAt("unpaired surrogate")
	}
	t.pos += 2
	h2, err := t.hex4()
	if err != nil {
		return 0, err
	}
	r = utf16.DecodeRune(rune(h1), rune(h2))
	if r == utf8.RuneError {
		return 0, t.errAt("invalid surrogate pair")
	}
	return r, nil
}

func (t *jsonTokenizer) hex4() (uint16, error) {
	if t.pos+4 > len(t.src) {
		return 0, t.errAt("unterminated \\u escape")
	}
	var v uint16
	for i := 0; i < 4; i++ {
		v <<= 4
		switch c := t.src[t.pos+i]; {
		case c >= '0' && c <= '9':
			v |= uint16(c - '0')
		case c >= 'a' && c <= 'f':
			v |= uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v |= uint16(c-'A') + 10
		default:
			return 0, t.errAt("invalid \\u escape")
		}
	}
	t.pos += 4
	return v, nil
}

// number parses integers by hand (allocation-free); floats and overflowing
// integers fall back to strconv.
func (t *jsonTokenizer) number() error {
	start := t.pos
	if t.peekByte() == '-' {
		t.pos++
	}
	digStart := t.pos
	for t.pos < len(t.src) && t.src[t.pos] >= '0' && t.src[t.pos] <= '9' {
		t.pos++
	}
	digs := t.src[digStart:t.pos]
	if len(digs) == 0 || (len(digs) > 1 && digs[0] == '0') {
		return t.errAt("invalid number")
	}
	if c := t.peekByte(); c == '.' || c == 'e' || c == 'E' {
		for t.pos < len(t.src) && isNumByte(t.src[t.pos]) {
			t.pos++
		}
		return t.float(start)
	}
	var v int64
	for _, c := range digs {
		dig := int64(c - '0')
		if v > (math.MaxInt64-dig)/10 {
			return t.float(start) // overflow: keep the value as a float
		}
		v = v*10 + dig
	}
	if t.src[start] == '-' {
		v = -v
	}
	t.toks = append(t.toks, Tok{Kind: KInt, I: v})
	return nil
}

func (t *jsonTokenizer) float(start int) error {
	f, err := strconv.ParseFloat(string(t.src[start:t.pos]), 64)
	if err != nil {
		return t.errAt("invalid number")
	}
	t.toks = append(t.toks, Tok{Kind: KFloat, F: f})
	return nil
}

func isNumByte(c byte) bool {
	return (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' ||
		c == '+' || c == '-'
}

// ============================ //generated-types ============================
// The rich native family: used both to author commands and as the target of
// transport decoding.  Union membership is carried by the nominal type, so
// the wire discriminator field has no struct field; the wire tuple shape
// likewise flattens into named fields.

type HoldTarget interface{ isHoldTarget() }

type TargetBook struct{ Book string }
type TargetEdition struct{ Edition string }

func (*TargetBook) isHoldTarget()    {}
func (*TargetEdition) isHoldTarget() {}

type TryHold struct {
	Id        string
	Patron    string
	Target    HoldTarget
	Open      bool
	Timestamp time.Time
}

type CancelHold struct{ Id string }

type RenamePatron struct {
	Id        string
	Name      string
	Timestamp time.Time
}

type UserCommands interface{ isUserCommands() }

func (*TryHold) isUserCommands()      {}
func (*CancelHold) isUserCommands()   {}
func (*RenamePatron) isUserCommands() {}

type Edition struct {
	Isbn  string
	Title string
	Tags  map[string]struct{}
}

type QueryCall interface{ isQueryCall() }

type QueryAllBooks struct{}
type QueryPatron struct{ Patron string }
type QueryHolds struct {
	Patron string
	Limit  int64
}

func (*QueryAllBooks) isQueryCall() {}
func (*QueryPatron) isQueryCall()   {}
func (*QueryHolds) isQueryCall()    {}

// ========================= //generated-native-walks ========================
// Typed recursive descent into the native family: what the host inspects.
// Union dispatchers are rendered from solver Solutions (noted inline).
// The exported entry points are the API; the walks compose beneath them.

// DecodeUserCommands decodes one UserCommands value.
func DecodeUserCommands(d *D) (UserCommands, []DecodeError, error) {
	v := decodeUserCommands(d)
	errs, fatal := d.finish()
	return v, errs, fatal
}

// CheckUserCommands validates one UserCommands value without keeping it.
func CheckUserCommands(d *D) ([]DecodeError, error) {
	_, errs, fatal := DecodeUserCommands(d)
	return errs, fatal
}

// DecodeQueryCall decodes one QueryCall value.
func DecodeQueryCall(d *D) (QueryCall, []DecodeError, error) {
	v := decodeQueryCall(d)
	errs, fatal := d.finish()
	return v, errs, fatal
}

// DecodeEdition decodes one Edition value.
func DecodeEdition(d *D) (*Edition, []DecodeError, error) {
	v := decodeEdition(d)
	errs, fatal := d.finish()
	return v, errs, fatal
}

// Solution: CheckJsonType{object: GetField("type", CheckLiteral{...})}
func decodeUserCommands(d *D) UserCommands {
	t := d.peek()
	if t.Kind != KBeginObj { // CheckJsonType
		d.errf("expected object, got %s", t.Kind)
		d.skipValue()
		return nil
	}
	vt, ok := d.discriminant("type") // GetField("type")
	if !ok {
		d.errf("missing union discriminator %q", "type")
		d.skipValue()
		return nil
	}
	switch string(d.span(vt)) { // CheckLiteral
	case "try-hold":
		return decodeTryHold(d)
	case "cancel-hold":
		return decodeCancelHold(d)
	case "rename-patron":
		return decodeRenamePatron(d)
	default:
		d.errf("unknown discriminator value %q", d.span(vt))
		d.skipValue()
		return nil
	}
}

// Solution: CheckJsonType{object: HasField[("book",...), ("edition",...)]}
func decodeHoldTarget(d *D) HoldTarget {
	t := d.peek()
	if t.Kind != KBeginObj { // CheckJsonType
		d.errf("expected object, got %s", t.Kind)
		d.skipValue()
		return nil
	}
	kt, ok := d.firstKey() // HasField
	if !ok {
		d.errf("expected a oneof key")
		d.skipValue()
		return nil
	}
	switch string(d.span(kt)) {
	case "book":
		return decodeTargetBook(d)
	case "edition":
		return decodeTargetEdition(d)
	default:
		d.errf("unknown oneof key %q (want book|edition)", d.span(kt))
		d.skipValue()
		return nil
	}
}

// Solution: CheckJsonType{array: CheckLength{1:..., 2:..., 3:...}}
func decodeQueryCall(d *D) QueryCall {
	t := d.peek()
	if t.Kind != KBeginArr { // CheckJsonType
		d.errf("expected array, got %s", t.Kind)
		d.skipValue()
		return nil
	}
	switch t.Num { // CheckLength, via the patched element count
	case 1:
		return decodeQueryAllBooks(d)
	case 2:
		return decodeQueryPatron(d)
	case 3:
		return decodeQueryHolds(d)
	default:
		d.errf("no tuple of length %d in union", t.Num)
		d.skipValue()
		return nil
	}
}

func decodeTryHold(d *D) *TryHold {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return nil
	}
	out := &TryHold{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break // KEndObj
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "try-hold")
		case "id":
			seen |= 1 << 1
			out.Id, _ = d.fieldStr(".id")
		case "patron":
			seen |= 1 << 2
			out.Patron, _ = d.fieldStr(".patron")
		case "target":
			seen |= 1 << 3
			d.push(".target")
			out.Target = decodeHoldTarget(d)
			d.pop()
		case "open":
			seen |= 1 << 4
			out.Open, _ = d.fieldBool(".open")
		case "timestamp":
			seen |= 1 << 5
			out.Timestamp, _ = d.fieldDate(".timestamp")
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id", "patron", "target", "open", "timestamp")
	return out
}

func decodeCancelHold(d *D) *CancelHold {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return nil
	}
	out := &CancelHold{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "cancel-hold")
		case "id":
			seen |= 1 << 1
			out.Id, _ = d.fieldStr(".id")
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id")
	return out
}

func decodeRenamePatron(d *D) *RenamePatron {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return nil
	}
	out := &RenamePatron{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "rename-patron")
		case "id":
			seen |= 1 << 1
			out.Id, _ = d.fieldStr(".id")
		case "name":
			seen |= 1 << 2
			out.Name, _ = d.fieldStr(".name")
		case "timestamp":
			seen |= 1 << 3
			out.Timestamp, _ = d.fieldDate(".timestamp")
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id", "name", "timestamp")
	return out
}

func decodeTargetBook(d *D) *TargetBook {
	d.next() // KBeginObj, kind pre-checked by the dispatcher
	out := &TargetBook{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "book":
			seen |= 1 << 0
			out.Book, _ = d.fieldStr(".book")
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "book")
	return out
}

func decodeTargetEdition(d *D) *TargetEdition {
	d.next() // KBeginObj, kind pre-checked by the dispatcher
	out := &TargetEdition{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "edition":
			seen |= 1 << 0
			out.Edition, _ = d.fieldStr(".edition")
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "edition")
	return out
}

func decodeEdition(d *D) *Edition {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return nil
	}
	out := &Edition{}
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "isbn":
			seen |= 1 << 0
			out.Isbn, _ = d.fieldStr(".isbn")
		case "title":
			seen |= 1 << 1
			out.Title, _ = d.fieldStr(".title")
		case "tags":
			seen |= 1 << 2
			if ss, ok := d.fieldStrList(".tags"); ok {
				out.Tags = make(map[string]struct{}, len(ss))
				for _, s := range ss {
					out.Tags[s] = struct{}{}
				}
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "isbn", "title", "tags")
	return out
}

func decodeQueryAllBooks(d *D) *QueryAllBooks {
	d.next() // KBeginArr, kind pre-checked by the dispatcher
	d.fieldLit("[0]", "all-books")
	d.endArr()
	return &QueryAllBooks{}
}

func decodeQueryPatron(d *D) *QueryPatron {
	d.next() // KBeginArr, kind pre-checked by the dispatcher
	out := &QueryPatron{}
	d.fieldLit("[0]", "patron")
	out.Patron, _ = d.fieldStr("[1]")
	d.endArr()
	return out
}

func decodeQueryHolds(d *D) *QueryHolds {
	d.next() // KBeginArr, kind pre-checked by the dispatcher
	out := &QueryHolds{}
	d.fieldLit("[0]", "holds")
	out.Patron, _ = d.fieldStr("[1]")
	out.Limit, _ = d.fieldInt("[2]")
	d.endArr()
	return out
}

// =========================== //generated-js-walks ==========================
// The same walks building rich values directly in the goja heap: what feeds
// the engine.  JS rich values are structural, so the discriminator field is
// kept.  Emitted for the types that cross into the engine (commands, events,
// store data); query dispatch is host business and gets no JS walk.

// DecodeUserCommandsJS decodes one UserCommands value into the JS heap.
func DecodeUserCommandsJS(d *D, j *JS) (goja.Value, []DecodeError, error) {
	v := decodeUserCommandsJS(d, j)
	errs, fatal := d.finish()
	return v, errs, fatal
}

// DecodeEditionJS decodes one Edition value into the JS heap.
func DecodeEditionJS(d *D, j *JS) (goja.Value, []DecodeError, error) {
	v := decodeEditionJS(d, j)
	errs, fatal := d.finish()
	return v, errs, fatal
}

func decodeUserCommandsJS(d *D, j *JS) goja.Value {
	t := d.peek()
	if t.Kind != KBeginObj {
		d.errf("expected object, got %s", t.Kind)
		d.skipValue()
		return goja.Null()
	}
	vt, ok := d.discriminant("type")
	if !ok {
		d.errf("missing union discriminator %q", "type")
		d.skipValue()
		return goja.Null()
	}
	switch string(d.span(vt)) {
	case "try-hold":
		return decodeTryHoldJS(d, j)
	case "cancel-hold":
		return decodeCancelHoldJS(d, j)
	case "rename-patron":
		return decodeRenamePatronJS(d, j)
	default:
		d.errf("unknown discriminator value %q", d.span(vt))
		d.skipValue()
		return goja.Null()
	}
}

func decodeHoldTargetJS(d *D, j *JS) goja.Value {
	t := d.peek()
	if t.Kind != KBeginObj {
		d.errf("expected object, got %s", t.Kind)
		d.skipValue()
		return goja.Null()
	}
	kt, ok := d.firstKey()
	if !ok {
		d.errf("expected a oneof key")
		d.skipValue()
		return goja.Null()
	}
	switch string(d.span(kt)) {
	case "book":
		return decodeTargetBookJS(d, j)
	case "edition":
		return decodeTargetEditionJS(d, j)
	default:
		d.errf("unknown oneof key %q (want book|edition)", d.span(kt))
		d.skipValue()
		return goja.Null()
	}
}

func decodeTryHoldJS(d *D, j *JS) goja.Value {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return goja.Null()
	}
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "try-hold")
			_ = o.Set("type", "try-hold")
		case "id":
			seen |= 1 << 1
			if s, ok := d.fieldStr(".id"); ok {
				_ = o.Set("id", s)
			}
		case "patron":
			seen |= 1 << 2
			if s, ok := d.fieldStr(".patron"); ok {
				_ = o.Set("patron", s)
			}
		case "target":
			seen |= 1 << 3
			d.push(".target")
			_ = o.Set("target", decodeHoldTargetJS(d, j))
			d.pop()
		case "open":
			seen |= 1 << 4
			if b, ok := d.fieldBool(".open"); ok {
				_ = o.Set("open", b)
			}
		case "timestamp":
			seen |= 1 << 5
			if ts, ok := d.fieldDate(".timestamp"); ok {
				_ = o.Set("timestamp", j.Time(ts))
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id", "patron", "target", "open", "timestamp")
	return o
}

func decodeCancelHoldJS(d *D, j *JS) goja.Value {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return goja.Null()
	}
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "cancel-hold")
			_ = o.Set("type", "cancel-hold")
		case "id":
			seen |= 1 << 1
			if s, ok := d.fieldStr(".id"); ok {
				_ = o.Set("id", s)
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id")
	return o
}

func decodeRenamePatronJS(d *D, j *JS) goja.Value {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return goja.Null()
	}
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "type":
			seen |= 1 << 0
			d.fieldLit(".type", "rename-patron")
			_ = o.Set("type", "rename-patron")
		case "id":
			seen |= 1 << 1
			if s, ok := d.fieldStr(".id"); ok {
				_ = o.Set("id", s)
			}
		case "name":
			seen |= 1 << 2
			if s, ok := d.fieldStr(".name"); ok {
				_ = o.Set("name", s)
			}
		case "timestamp":
			seen |= 1 << 3
			if ts, ok := d.fieldDate(".timestamp"); ok {
				_ = o.Set("timestamp", j.Time(ts))
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "type", "id", "name", "timestamp")
	return o
}

func decodeTargetBookJS(d *D, j *JS) goja.Value {
	d.next() // KBeginObj, kind pre-checked by the dispatcher
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "book":
			seen |= 1 << 0
			if s, ok := d.fieldStr(".book"); ok {
				_ = o.Set("book", s)
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "book")
	return o
}

func decodeTargetEditionJS(d *D, j *JS) goja.Value {
	d.next() // KBeginObj, kind pre-checked by the dispatcher
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "edition":
			seen |= 1 << 0
			if s, ok := d.fieldStr(".edition"); ok {
				_ = o.Set("edition", s)
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "edition")
	return o
}

func decodeEditionJS(d *D, j *JS) goja.Value {
	t := d.next()
	if t.Kind != KBeginObj {
		d.mismatch("object", t)
		return goja.Null()
	}
	o := j.vm.NewObject()
	var seen uint32
	for d.ok() {
		kt := d.next()
		if kt.Kind != KKey {
			break
		}
		switch string(d.span(kt)) {
		case "isbn":
			seen |= 1 << 0
			if s, ok := d.fieldStr(".isbn"); ok {
				_ = o.Set("isbn", s)
			}
		case "title":
			seen |= 1 << 1
			if s, ok := d.fieldStr(".title"); ok {
				_ = o.Set("title", s)
			}
		case "tags":
			seen |= 1 << 2
			if ss, ok := d.fieldStrList(".tags"); ok {
				_ = o.Set("tags", j.StrSet(ss))
			}
		default:
			d.skipValue()
		}
	}
	d.requireFields(seen, "isbn", "title", "tags")
	return o
}

// ===================== //user-code-transport-extension =====================
// A msgpack transport plugged in from user land: tokenize the message into
// the shared Tok representation, hand it to NewD, done.  Strings span the
// source directly (msgpack strings are raw UTF-8, no escapes), so the arena
// is never used; element counts come free from the container headers.

type mpTokenizer struct {
	src   []byte
	pos   int
	depth int
	toks  []Tok
}

// NewMsgpackDecoder returns a decoder over the msgpack transport.
func NewMsgpackDecoder(r io.Reader) *D {
	src, err := io.ReadAll(r)
	if err != nil {
		return &D{fatal: err}
	}
	t := &mpTokenizer{src: src}
	for t.pos < len(t.src) && err == nil {
		err = t.value()
	}
	d := NewD(src, nil, t.toks)
	d.fatal = err
	return d
}

func (t *mpTokenizer) errAt(msg string) error {
	return fmt.Errorf("msgpack: %s at offset %d", msg, t.pos)
}

func (t *mpTokenizer) uN(k int) (uint64, error) {
	if t.pos+k > len(t.src) {
		return 0, t.errAt("truncated")
	}
	var v uint64
	for i := 0; i < k; i++ {
		v = v<<8 | uint64(t.src[t.pos+i])
	}
	t.pos += k
	return v, nil
}

func (t *mpTokenizer) value() error {
	if t.pos >= len(t.src) {
		return t.errAt("truncated")
	}
	c := t.src[t.pos]
	t.pos++
	switch {
	case c <= 0x7f: // positive fixint
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(c)})
	case c >= 0xe0: // negative fixint
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(int8(c))})
	case c&0xf0 == 0x80: // fixmap
		return t.container(uint64(c&0x0f), true)
	case c&0xf0 == 0x90: // fixarray
		return t.container(uint64(c&0x0f), false)
	case c&0xe0 == 0xa0: // fixstr
		return t.str(KString, uint64(c&0x1f))
	default:
		return t.wide(c)
	}
	return nil
}

func (t *mpTokenizer) wide(c byte) error {
	switch c {
	case 0xc0:
		t.toks = append(t.toks, Tok{Kind: KNull})
	case 0xc2:
		t.toks = append(t.toks, Tok{Kind: KBool})
	case 0xc3:
		t.toks = append(t.toks, Tok{Kind: KBool, I: 1})
	case 0xca:
		bits, err := t.uN(4)
		if err != nil {
			return err
		}
		f := float64(math.Float32frombits(uint32(bits)))
		t.toks = append(t.toks, Tok{Kind: KFloat, F: f})
	case 0xcb:
		bits, err := t.uN(8)
		if err != nil {
			return err
		}
		t.toks = append(t.toks, Tok{Kind: KFloat, F: math.Float64frombits(bits)})
	case 0xcc, 0xcd, 0xce, 0xcf: // uint 8/16/32/64
		v, err := t.uN(1 << (c - 0xcc))
		if err != nil {
			return err
		}
		if v > math.MaxInt64 {
			return t.errAt("uint64 overflows int64")
		}
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(v)})
	case 0xd0: // int 8
		v, err := t.uN(1)
		if err != nil {
			return err
		}
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(int8(v))})
	case 0xd1: // int 16
		v, err := t.uN(2)
		if err != nil {
			return err
		}
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(int16(v))})
	case 0xd2: // int 32
		v, err := t.uN(4)
		if err != nil {
			return err
		}
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(int32(v))})
	case 0xd3: // int 64
		v, err := t.uN(8)
		if err != nil {
			return err
		}
		t.toks = append(t.toks, Tok{Kind: KInt, I: int64(v)})
	case 0xd9, 0xda, 0xdb: // str 8/16/32
		n, err := t.uN(1 << (c - 0xd9))
		if err != nil {
			return err
		}
		return t.str(KString, n)
	case 0xdc, 0xdd: // array 16/32
		n, err := t.uN(2 << (c - 0xdc))
		if err != nil {
			return err
		}
		return t.container(n, false)
	case 0xde, 0xdf: // map 16/32
		n, err := t.uN(2 << (c - 0xde))
		if err != nil {
			return err
		}
		return t.container(n, true)
	default: // bin, ext, reserved
		return t.errAt(fmt.Sprintf("unsupported msgpack code 0x%02x", c))
	}
	return nil
}

func (t *mpTokenizer) str(kind Kind, n uint64) error {
	if uint64(t.pos)+n > uint64(len(t.src)) {
		return t.errAt("truncated string")
	}
	t.toks = append(t.toks, Tok{Kind: kind, Off: uint32(t.pos), Num: uint32(n)})
	t.pos += int(n)
	return nil
}

// keyStr reads a string header in key position.
func (t *mpTokenizer) keyStr() error {
	if t.pos >= len(t.src) {
		return t.errAt("truncated")
	}
	c := t.src[t.pos]
	t.pos++
	switch {
	case c&0xe0 == 0xa0:
		return t.str(KKey, uint64(c&0x1f))
	case c == 0xd9 || c == 0xda || c == 0xdb:
		n, err := t.uN(1 << (c - 0xd9))
		if err != nil {
			return err
		}
		return t.str(KKey, n)
	}
	return t.errAt("expected string key")
}

func (t *mpTokenizer) container(n uint64, isMap bool) error {
	if t.depth++; t.depth > maxDepth {
		return t.errAt("maximum nesting depth exceeded")
	}
	open := len(t.toks)
	kind, end := KBeginArr, KEndArr
	if isMap {
		kind, end = KBeginObj, KEndObj
	}
	t.toks = append(t.toks, Tok{Kind: kind, Num: uint32(n)})
	for range n {
		if isMap {
			if err := t.keyStr(); err != nil {
				return err
			}
		}
		if err := t.value(); err != nil {
			return err
		}
	}
	t.toks = append(t.toks, Tok{Kind: end})
	t.toks[open].End = uint32(len(t.toks))
	t.depth--
	return nil
}

// ================================ //demo ===================================
// The msgpack library appears here only to author test bytes; the transport
// itself is the hand-rolled tokenizer above.

func report(label string, v any, errs []DecodeError, fatal error) {
	fmt.Printf("%s\n  value: %#v\n", label, v)
	for _, e := range errs {
		fmt.Printf("  error: %s\n", e)
	}
	if fatal != nil {
		fmt.Printf("  FATAL: %v\n", fatal)
	}
	fmt.Println()
}

func main() {
	// 1) JSON -> typed native.  An escaped key ("patron") exercises the
	//    arena path; every other string spans the source untouched.
	good := `{"type":"try-hold","id":"h-1","\u0070atron":"p-9",` +
		`"target":{"edition":"978-3-16"},"open":true,` +
		`"timestamp":"2026-08-20T12:34:56Z"}`
	v1, e1, f1 := DecodeUserCommands(NewJSONDecoder(strings.NewReader(good)))
	report("1) JSON -> typed native (escaped key via arena)", v1, e1, f1)
	if th, ok := v1.(*TryHold); ok {
		switch tg := th.Target.(type) {
		case *TargetEdition:
			fmt.Printf("   native switch: edition hold on %s at %s\n\n",
				tg.Edition, th.Timestamp.Format(time.RFC3339))
		case *TargetBook:
			fmt.Printf("   native switch: book hold on %s\n\n", tg.Book)
		}
	}

	// 2) JSON with the discriminator last (foreign writer: the non-consuming
	//    scan finds it) and five collectable errors; salvage still lands.
	bad := `{"id":42,"open":"yes","target":{"bok":"x"},` +
		`"timestamp":"not-a-date","type":"try-hold"}`
	v2, e2, f2 := DecodeUserCommands(NewJSONDecoder(strings.NewReader(bad)))
	report("2) JSON -> typed native, discriminator last + error collection", v2, e2, f2)

	// 3) Tuple union over JSON: the element count was patched into the
	//    container token during tokenization, so CheckLength is O(1) --
	//    identical dispatch cost to msgpack in 4.
	v3, e3, f3 := DecodeQueryCall(NewJSONDecoder(strings.NewReader(`["holds","p-9",3]`)))
	report("3) JSON tuple -> typed native (CheckLength via token count)", v3, e3, f3)

	// 4) The same tuple over msgpack.
	qraw, err := msgpack.Marshal([]any{"holds", "p-9", 3})
	if err != nil {
		panic(err)
	}
	v4, e4, f4 := DecodeQueryCall(NewMsgpackDecoder(bytes.NewReader(qraw)))
	report("4) msgpack tuple -> typed native (CheckLength via token count)", v4, e4, f4)

	// 5) msgpack -> goja: real JS Date minted in the JS heap.  Go map
	//    iteration order is random, so the discriminator scan gets exercised
	//    over msgpack too.
	vm := goja.New()
	j := NewJS(vm)

	craw, err := msgpack.Marshal(map[string]any{
		"type": "try-hold", "id": "h-2", "patron": "p-1",
		"target": map[string]any{"book": "b-7"}, "open": false,
		"timestamp": "2026-08-20T09:00:00Z",
	})
	if err != nil {
		panic(err)
	}
	v5, e5, f5 := DecodeUserCommandsJS(NewMsgpackDecoder(bytes.NewReader(craw)), j)
	_ = vm.Set("cmd", v5)
	probe, perr := vm.RunString(`cmd.type + " | timestamp Date? " +
		(cmd.timestamp instanceof Date) + " | " + cmd.timestamp.toISOString() +
		" | target.book=" + cmd.target.book`)
	report("5) msgpack -> goja (JS probe below)", probe, e5, f5)
	if perr != nil {
		fmt.Println("  probe error:", perr)
	}

	// 6) msgpack -> goja set lift; and the same bytes -> typed native set.
	eraw, err := msgpack.Marshal(map[string]any{
		"isbn": "978-3-16", "title": "DDD by Examples",
		"tags": []any{"ddd", "library"},
	})
	if err != nil {
		panic(err)
	}
	v6, e6, f6 := DecodeEditionJS(NewMsgpackDecoder(bytes.NewReader(eraw)), j)
	_ = vm.Set("ed", v6)
	probe2, perr2 := vm.RunString(`"tags Set? " + (ed.tags instanceof Set) +
		" | size=" + ed.tags.size + " | has(ddd)=" + ed.tags.has("ddd")`)
	report("6) msgpack -> goja set lift (JS probe below)", probe2, e6, f6)
	if perr2 != nil {
		fmt.Println("  probe error:", perr2)
	}
	v6b, e6b, f6b := DecodeEdition(NewMsgpackDecoder(bytes.NewReader(eraw)))
	report("6b) same bytes -> typed native Edition", v6b, e6b, f6b)

	// 7) Checker mode: the native decode with the value discarded.
	e7, f7 := CheckUserCommands(NewJSONDecoder(strings.NewReader(bad)))
	report("7) check-only over the bad input", "(no value)", e7, f7)

	// 8) Invalid encoding: fatal at construction, before any walk runs.
	v8, e8, f8 := DecodeUserCommands(NewJSONDecoder(strings.NewReader(`{"type":"try-h`)))
	report("8) truncated JSON -> fatal", v8, e8, f8)
}
