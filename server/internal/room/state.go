package room

import (
	"encoding/json"
	"math"

	"starkflow/internal/proto"
)

// Limits bounds the size of a room state.
type Limits struct {
	MaxKeys   int
	MaxBytes  int
	MaxString int
}

// Rule describes how one state key may be written.
type Rule struct {
	Kind     string // num | str | bool ("" = inferred from the first value)
	Mode     string // set | add | const | once | server
	Min, Max *float64
	MaxDelta float64
	Reject   bool
	MaxLen   int
}

// Change is the result of a successful write.
type Change struct {
	Key string
	Old any
	New any
}

// State is the shared key/value store of a room. It is NOT safe for
// concurrent use: only the room goroutine touches it, which is exactly what
// makes set/add/toggle atomic.
type State struct {
	vals   map[string]any
	rules  map[string]Rule
	strict bool
	lim    Limits
	bytes  int
}

// ValidKey reports whether k is an allowed key name.
func ValidKey(k string) bool {
	if len(k) == 0 || len(k) > 64 {
		return false
	}
	for _, c := range k {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_'
		if !ok {
			return false
		}
	}
	return true
}

func kindOf(v any) string {
	switch v.(type) {
	case float64:
		return "num"
	case string:
		return "str"
	case bool:
		return "bool"
	}
	return ""
}

func sizeOf(key string, v any) int {
	n := len(key)
	switch x := v.(type) {
	case string:
		n += len(x)
	case float64:
		n += 8
	case bool:
		n++
	}
	return n
}

// DecodeValue parses a JSON number, string or bool.
func DecodeValue(raw json.RawMessage) (any, *proto.Error) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, proto.Err(proto.ErrBadType, "value must be a number, string or bool")
	}
	if kindOf(v) == "" {
		return nil, proto.Err(proto.ErrBadType, "value must be a number, string or bool")
	}
	return v, nil
}

// NewState builds a state from rule definitions and initial values.
// Initial values may be written to any key, including const keys.
func NewState(defs map[string]proto.RuleDef, initVals map[string]any, strict bool, lim Limits) (*State, *proto.Error) {
	s := &State{vals: map[string]any{}, rules: map[string]Rule{}, strict: strict, lim: lim}
	for k, d := range defs {
		if !ValidKey(k) {
			return nil, proto.Err(proto.ErrUnknownKey, "bad key name in schema: "+k)
		}
		kind := d.Kind
		if kind == "" {
			kind = "num"
		}
		if kind != "num" && kind != "str" && kind != "bool" {
			return nil, proto.Err(proto.ErrBadType, "bad kind for key "+k)
		}
		mode := d.Mode
		if mode == "" {
			mode = "set"
		}
		switch mode {
		case "set", "add", "const", "once", "server":
		default:
			return nil, proto.Err(proto.ErrBadType, "bad mode for key "+k)
		}
		s.rules[k] = Rule{Kind: kind, Mode: mode, Min: d.Min, Max: d.Max, MaxDelta: d.MaxDelta, Reject: d.Reject, MaxLen: d.MaxLen}
	}
	for k, v := range initVals {
		if !ValidKey(k) {
			return nil, proto.Err(proto.ErrUnknownKey, "bad key name in init: "+k)
		}
		rule, has := s.rules[k]
		if !has {
			if s.strict {
				return nil, proto.Err(proto.ErrUnknownKey, "unknown key in init: "+k)
			}
			rule = Rule{Mode: "set"}
		}
		if _, err := s.store(k, rule, v); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// store validates the new value against the rule and limits, then saves it.
// It returns the value actually stored (numbers may be clamped).
func (s *State) store(key string, rule Rule, nv any) (any, *proto.Error) {
	k := kindOf(nv)
	if k == "" {
		return nil, proto.Err(proto.ErrBadType, "value must be a number, string or bool")
	}
	if rule.Kind != "" && rule.Kind != k {
		return nil, proto.Err(proto.ErrBadType, "key "+key+" expects "+rule.Kind)
	}
	old, exists := s.vals[key]
	if exists && rule.Kind == "" && kindOf(old) != k {
		return nil, proto.Err(proto.ErrBadType, "key "+key+" holds "+kindOf(old))
	}
	if f, ok := nv.(float64); ok {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, proto.Err(proto.ErrBadType, "number is not finite")
		}
		if rule.Min != nil && f < *rule.Min {
			if rule.Reject {
				return nil, proto.Err(proto.ErrOutOfLimits, "value below minimum for "+key)
			}
			f = *rule.Min
		}
		if rule.Max != nil && f > *rule.Max {
			if rule.Reject {
				return nil, proto.Err(proto.ErrOutOfLimits, "value above maximum for "+key)
			}
			f = *rule.Max
		}
		nv = f
	}
	if str, ok := nv.(string); ok {
		limit := s.lim.MaxString
		if rule.MaxLen > 0 && rule.MaxLen < limit {
			limit = rule.MaxLen
		}
		if len(str) > limit {
			return nil, proto.Err(proto.ErrOutOfLimits, "string for "+key+" is too long")
		}
	}
	if !exists && len(s.vals) >= s.lim.MaxKeys {
		return nil, proto.Err(proto.ErrOutOfLimits, "too many state keys")
	}
	newBytes := s.bytes + sizeOf(key, nv)
	if exists {
		newBytes -= sizeOf(key, old)
	}
	if newBytes > s.lim.MaxBytes {
		return nil, proto.Err(proto.ErrOutOfLimits, "room state is too large")
	}
	s.bytes = newBytes
	s.vals[key] = nv
	return nv, nil
}

// Apply performs a client write: op is "set", "add" or "toggle".
func (s *State) Apply(op, key string, raw json.RawMessage) (Change, *proto.Error) {
	ch := Change{Key: key}
	if !ValidKey(key) {
		return ch, proto.Err(proto.ErrUnknownKey, "bad key name")
	}
	rule, has := s.rules[key]
	if !has {
		if s.strict {
			return ch, proto.Err(proto.ErrUnknownKey, "unknown key: "+key)
		}
		rule = Rule{Mode: "set"}
	}
	old, exists := s.vals[key]
	ch.Old = old

	switch rule.Mode {
	case "const", "server":
		return ch, proto.Err(proto.ErrForbidden, "key "+key+" cannot be changed by clients")
	case "once":
		if op != "set" || exists {
			return ch, proto.Err(proto.ErrForbidden, "key "+key+" can be written only once")
		}
	case "add":
		if op != "add" {
			return ch, proto.Err(proto.ErrForbidden, "key "+key+" accepts only add")
		}
	}

	var nv any
	switch op {
	case "set":
		v, err := DecodeValue(raw)
		if err != nil {
			return ch, err
		}
		nv = v
	case "add":
		var d float64
		if err := json.Unmarshal(raw, &d); err != nil {
			return ch, proto.Err(proto.ErrBadType, "add expects a number")
		}
		if rule.MaxDelta > 0 && math.Abs(d) > rule.MaxDelta {
			return ch, proto.Err(proto.ErrDeltaTooBig, "change of key "+key+" is too big")
		}
		cur := 0.0
		if exists {
			c, ok := old.(float64)
			if !ok {
				return ch, proto.Err(proto.ErrBadType, "key "+key+" is not a number")
			}
			cur = c
		}
		nv = cur + d
	case "toggle":
		cur := false
		if exists {
			c, ok := old.(bool)
			if !ok {
				return ch, proto.Err(proto.ErrBadType, "key "+key+" is not a bool")
			}
			cur = c
		}
		nv = !cur
	default:
		return ch, proto.Err(proto.ErrBadMessage, "unknown state operation")
	}

	stored, err := s.store(key, rule, nv)
	if err != nil {
		return ch, err
	}
	ch.New = stored
	return ch, nil
}

// Snapshot returns a copy of all values.
func (s *State) Snapshot() map[string]any {
	out := make(map[string]any, len(s.vals))
	for k, v := range s.vals {
		out[k] = v
	}
	return out
}
