// Package islands embeds the shared Islands WASM core using wazero.
package islands

import (
	"bytes"
	"encoding"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"time"
	"unicode/utf8"
)

const maxMessageBytes = 1 << 20
const maxCodeBytes = 16 << 20
const linearMemoryBytes = 128 << 20

// Error is an SDK, guest, or host capability failure. Code is machine-readable.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Cause   error  `json:"-"`
}

func (e *Error) Error() string            { return e.Code + ": " + e.Message }
func (e *Error) Unwrap() error            { return e.Cause }
func failure(code, message string) *Error { return &Error{Code: code, Message: message} }

func wrap(code string, err error) *Error {
	return &Error{Code: code, Message: err.Error(), Cause: err}
}

type Manifest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name,omitempty"`
	Version     string   `json:"version,omitempty"`
	Description string   `json:"description,omitempty"`
	Requires    []string `json:"requires,omitempty"`
}

type Artifact struct {
	FormatVersion int      `json:"formatVersion"`
	Manifest      Manifest `json:"manifest"`
	Code          string   `json:"code"`
}

// ParseArtifact parses portable JSON; it does not compile or evaluate code.
func ParseArtifact(data []byte) (Artifact, error) {
	var a Artifact
	if len(data) > maxCodeBytes*2 || !utf8.Valid(data) {
		return a, failure("INVALID_ARTIFACT", "artifact is oversized or not UTF-8")
	}
	if err := json.Unmarshal(data, &a); err != nil {
		return a, wrap("INVALID_ARTIFACT", err)
	}
	return a, a.validate()
}

func (a Artifact) validate() error {
	if a.FormatVersion != 1 || !validName(a.Manifest.ID) || a.Code == "" || len(a.Code) > maxCodeBytes || !utf8.ValidString(a.Code) {
		return failure("INVALID_ARTIFACT", "expected version 1, a nonempty manifest id and UTF-8 code (at most 16 MiB)")
	}
	for _, method := range a.Manifest.Requires {
		if !validName(method) {
			return failure("INVALID_ARTIFACT", "invalid required capability name")
		}
	}
	return nil
}

// Limits apply to each instance. Zero fields select the documented defaults.
// Fuel counts QuickJS interrupt callbacks, not WASM instructions.
type Limits struct {
	MemoryBytes     uint32
	StackBytes      uint32
	Fuel            uint32
	Timeout         time.Duration
	MaxPendingCalls int
}

func (l Limits) defaults() (Limits, error) {
	if l.MemoryBytes == 0 {
		l.MemoryBytes = 16 << 20
	}
	if l.StackBytes == 0 {
		l.StackBytes = 512 << 10
	}
	if l.Fuel == 0 {
		l.Fuel = 10_000
	}
	if l.Timeout == 0 {
		l.Timeout = 5 * time.Second
	}
	if l.MaxPendingCalls == 0 {
		l.MaxPendingCalls = 64
	}
	if l.MemoryBytes > linearMemoryBytes || l.StackBytes > 1<<20 || l.Fuel > math.MaxInt32 || l.Timeout < 0 || l.MaxPendingCalls < 1 {
		return l, failure("INVALID_LIMITS", "limits must be positive; heap <=128 MiB, stack <=1 MiB and fuel <=2147483647")
	}
	return l, nil
}

type LoadOptions struct {
	// Policy is "sandboxed" (default) or "trusted" (all registered capabilities).
	Policy   string
	Grants   []string
	Config   any
	Metadata map[string]any
}

func validName(name string) bool { return name != "" && len(name) <= 1024 && utf8.ValidString(name) }

// JSON values use nil, bool, finite numbers, string, arrays/slices, and maps
// with string keys. Live objects, structs, custom marshalers and cycles are rejected.
func validateJSON(v reflect.Value, depth int) error {
	if depth > 100 {
		return failure("INVALID_JSON", "JSON nesting exceeds 100 levels (or contains a cycle)")
	}
	if !v.IsValid() {
		return nil
	}
	if v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil
		}
		return validateJSON(v.Elem(), depth+1)
	}
	if v.CanInterface() {
		if number, ok := v.Interface().(json.Number); ok {
			value, err := strconv.ParseFloat(string(number), 64)
			if err != nil {
				return wrap("INVALID_JSON", err)
			}
			return validateNumber(value)
		}
	}
	switch v.Kind() {
	case reflect.Bool:
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return failure("INVALID_JSON", "strings must be UTF-8")
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if n := v.Int(); n > 9007199254740991 || n < -9007199254740991 {
			return failure("INVALID_JSON", "integer exceeds JavaScript safe integer range")
		}
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if v.Uint() > 9007199254740991 {
			return failure("INVALID_JSON", "integer exceeds JavaScript safe integer range")
		}
	case reflect.Float32, reflect.Float64:
		if err := validateNumber(v.Float()); err != nil {
			return err
		}
	case reflect.Array, reflect.Slice:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return failure("INVALID_JSON", "byte buffers are not JSON arrays; decode them explicitly")
		}
		for i := 0; i < v.Len(); i++ {
			if err := validateJSON(v.Index(i), depth+1); err != nil {
				return err
			}
		}
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			return failure("INVALID_JSON", "object keys must be strings")
		}
		iter := v.MapRange()
		for iter.Next() {
			if err := validateJSON(iter.Key(), depth+1); err != nil {
				return err
			}
			if err := validateJSON(iter.Value(), depth+1); err != nil {
				return err
			}
		}
	default:
		return failure("INVALID_JSON", fmt.Sprintf("%s is not a JSON value", v.Kind()))
	}
	if v.CanInterface() {
		if _, ok := v.Interface().(json.Marshaler); ok {
			return failure("INVALID_JSON", "custom marshalers are not JSON values")
		}
		if _, ok := v.Interface().(encoding.TextMarshaler); ok {
			return failure("INVALID_JSON", "custom text marshalers are not JSON values")
		}
	}
	return nil
}

func validateNumber(value float64) error {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return failure("INVALID_JSON", "numbers must be finite")
	}
	if math.Trunc(value) == value && math.Abs(value) > 9007199254740991 {
		return failure("INVALID_JSON", "integer exceeds JavaScript safe integer range")
	}
	return nil
}

func decodeJSON(data []byte) (any, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, wrap("PROTOCOL_ERROR", err)
	}
	if err := validateJSON(reflect.ValueOf(value), 0); err != nil {
		return nil, wrap("PROTOCOL_ERROR", err)
	}
	return value, nil
}

func jsonCopy(value any) (any, error) {
	if err := validateJSON(reflect.ValueOf(value), 0); err != nil {
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, wrap("INVALID_JSON", err)
	}
	if len(data) > maxMessageBytes {
		return nil, failure("MESSAGE_TOO_LARGE", "JSON value exceeds 1 MiB")
	}
	var copy any
	if err = json.Unmarshal(data, &copy); err != nil {
		return nil, wrap("INVALID_JSON", err)
	}
	return copy, nil
}

func encodeMessage(message map[string]any) ([]byte, error) {
	data, err := json.Marshal(message)
	if err != nil {
		return nil, wrap("INVALID_JSON", err)
	}
	if len(data) > maxMessageBytes {
		return nil, failure("MESSAGE_TOO_LARGE", "wire message exceeds 1 MiB")
	}
	return data, nil
}

type wireMessage struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Input  json.RawMessage `json:"input"`
	OK     *bool           `json:"ok"`
	Value  json.RawMessage `json:"value"`
	Error  *wireError      `json:"error"`
}

type wireError struct {
	Code    string  `json:"code"`
	Message *string `json:"message"`
}

func decodeMessages(data []byte) ([]wireMessage, error) {
	var messages []wireMessage
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var m wireMessage
		if !utf8.Valid(line) || json.Unmarshal(line, &m) != nil || !validName(m.ID) || len(m.ID) < 2 {
			return nil, failure("PROTOCOL_ERROR", "malformed guest message")
		}
		switch m.Type {
		case "call":
			if m.ID[0] != 'g' || !validName(m.Method) || m.Input == nil {
				return nil, failure("PROTOCOL_ERROR", "malformed capability call")
			}
		case "result":
			if m.ID[0] != 'h' || m.OK == nil {
				return nil, failure("PROTOCOL_ERROR", "malformed operation result")
			}
			if *m.OK && m.Value == nil {
				return nil, failure("PROTOCOL_ERROR", "result must contain a JSON value")
			}
			if !*m.OK && (m.Error == nil || !validName(m.Error.Code) || m.Error.Message == nil) {
				return nil, failure("PROTOCOL_ERROR", "result must contain an error code and message")
			}
		default:
			return nil, failure("PROTOCOL_ERROR", "unknown guest message type")
		}
		messages = append(messages, m)
	}
	return messages, nil
}

func errorEnvelope(id string, err error) map[string]any {
	e := failure("HOST_ERROR", err.Error())
	var typed *Error
	if errors.As(err, &typed) {
		e = typed
	}
	// Keep callback failures small enough to send even after an oversized result.
	message := e.Message
	if len(message) > 4096 {
		message = string([]rune(message)[:min(len([]rune(message)), 1024)])
	}
	return map[string]any{"type": "result", "id": id, "ok": false, "error": map[string]any{"code": e.Code, "message": message}}
}
