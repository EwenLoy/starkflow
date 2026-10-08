package room

import (
	"encoding/json"
	"testing"

	"starkflow/internal/proto"
)

func f(v float64) *float64 { return &v }

func newBossState(t *testing.T) *State {
	t.Helper()
	defs := map[string]proto.RuleDef{
		"boss_hp":     {Kind: "num", Mode: "add", Min: f(0), Max: f(1000), MaxDelta: 50},
		"boss_max_hp": {Kind: "num", Mode: "const"},
		"winner":      {Kind: "str", Mode: "once"},
	}
	initVals := map[string]any{"boss_hp": float64(1000), "boss_max_hp": float64(1000)}
	s, err := NewState(defs, initVals, false, Limits{MaxKeys: 8, MaxBytes: 1024, MaxString: 16})
	if err != nil {
		t.Fatalf("NewState: %v", err)
	}
	return s
}

func TestAddAndClamp(t *testing.T) {
	s := newBossState(t)
	ch, err := s.Apply("add", "boss_hp", json.RawMessage("-25"))
	if err != nil || ch.New != float64(975) {
		t.Fatalf("add -25: %+v %v", ch, err)
	}
	if _, err := s.Apply("add", "boss_hp", json.RawMessage("-60")); err == nil || err.Code != proto.ErrDeltaTooBig {
		t.Fatalf("expected delta too big, got %v", err)
	}
	for i := 0; i < 30; i++ {
		if _, err := s.Apply("add", "boss_hp", json.RawMessage("-50")); err != nil {
			t.Fatalf("add -50: %v", err)
		}
	}
	if got := s.Snapshot()["boss_hp"]; got != float64(0) {
		t.Fatalf("boss_hp should be clamped to 0, got %v", got)
	}
}

func TestModes(t *testing.T) {
	s := newBossState(t)
	if _, err := s.Apply("set", "boss_hp", json.RawMessage("5")); err == nil || err.Code != proto.ErrForbidden {
		t.Fatalf("set on add-only key must be forbidden, got %v", err)
	}
	if _, err := s.Apply("set", "boss_max_hp", json.RawMessage("5")); err == nil || err.Code != proto.ErrForbidden {
		t.Fatalf("const key must be forbidden, got %v", err)
	}
	if _, err := s.Apply("set", "winner", json.RawMessage(`"anna"`)); err != nil {
		t.Fatalf("first write of once key: %v", err)
	}
	if _, err := s.Apply("set", "winner", json.RawMessage(`"bob"`)); err == nil || err.Code != proto.ErrForbidden {
		t.Fatalf("second write of once key must fail, got %v", err)
	}
}

func TestLimitsAndTypes(t *testing.T) {
	s := newBossState(t)
	if _, err := s.Apply("set", "note", json.RawMessage(`"this string is longer than sixteen"`)); err == nil || err.Code != proto.ErrOutOfLimits {
		t.Fatalf("long string must be rejected, got %v", err)
	}
	if _, err := s.Apply("toggle", "flag", nil); err != nil {
		t.Fatalf("toggle on a new key: %v", err)
	}
	if ch, _ := s.Apply("toggle", "flag", nil); ch.New != false {
		t.Fatalf("second toggle should give false, got %v", ch.New)
	}
	if _, err := s.Apply("add", "flag", json.RawMessage("1")); err == nil {
		t.Fatal("add on a bool key must fail")
	}
	if _, err := s.Apply("set", "bad key!", json.RawMessage("1")); err == nil {
		t.Fatal("bad key name must fail")
	}
}
