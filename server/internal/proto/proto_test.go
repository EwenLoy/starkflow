package proto

import (
	"encoding/json"
	"testing"
)

// The plugin marks a keyframe with "k":1 (see docs/PROTOCOL.md). A number in a
// boolean field failed to decode, and every snapshot answered with 101.
func TestSyncKeyframeFlag(t *testing.T) {
	cases := []struct {
		name string
		in   string
		key  bool
	}{
		{"k:1, as the plugin sends it", `{"t":"sync","seq":8,"ts":24544,"iv":67,"objs":[[0,3075,30,955,"data",{"ID":"13b5","Anim":"Duke","Name":"Toffy"}]],"k":1}`, true},
		{"k:true", `{"t":"sync","seq":1,"ts":1,"objs":[],"k":true}`, true},
		{"k:0", `{"t":"sync","seq":1,"ts":1,"objs":[],"k":0}`, false},
		{"k:false", `{"t":"sync","seq":1,"ts":1,"objs":[],"k":false}`, false},
		{"no k: a delta", `{"t":"sync","seq":1,"ts":1,"objs":[[0,1,30]]}`, false},
		{"k:null", `{"t":"sync","seq":1,"ts":1,"objs":[],"k":null}`, false},
	}
	for _, c := range cases {
		var m ClientMsg
		if err := json.Unmarshal([]byte(c.in), &m); err != nil {
			t.Fatalf("%s: failed to decode: %v", c.name, err)
		}
		if bool(m.K) != c.key {
			t.Fatalf("%s: k = %v, want %v", c.name, bool(m.K), c.key)
		}
		if m.T != "sync" || len(m.Objs) == 0 {
			t.Fatalf("%s: snapshot fields are lost: %+v", c.name, m)
		}
	}
}

// A key that is neither a boolean nor a number is still a bad message.
func TestFlagRejectsGarbage(t *testing.T) {
	for _, in := range []string{`{"t":"sync","k":"yes"}`, `{"t":"sync","k":{}}`, `{"t":"sync","k":[1]}`} {
		var m ClientMsg
		if err := json.Unmarshal([]byte(in), &m); err == nil {
			t.Fatalf("%s: a bad k must be an error, got %v", in, bool(m.K))
		}
	}
	var m ClientMsg
	if err := json.Unmarshal([]byte(`{"t":`), &m); err == nil {
		t.Fatal("a broken frame must be an error")
	}
}
