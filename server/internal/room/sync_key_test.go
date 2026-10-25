package room

import (
	"encoding/json"
	"testing"
	"time"
)

// A delta means nothing without the keyframe it was built against, so a
// newcomer is given the last keyframe, never the last delta.
func TestSyncKeepsOnlyKeyframesForNewcomers(t *testing.T) {
	r, a, _ := newTestRoom(t, 0)
	r.Sync(a, 1, 1000, 33, json.RawMessage(`[[0,11,10,20,0]]`), true)
	r.Sync(a, 2, 1033, 33, json.RawMessage(`[[0,1,11,21]]`), false)
	r.Sync(a, 3, 1066, 33, json.RawMessage(`[[0,1,12,22]]`), false)
	time.Sleep(20 * time.Millisecond)

	c := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: c}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ := c.msgs(t)
	snap, ok := joined[0]["players"].([]any)[0].(map[string]any)["sync"].(map[string]any)
	if !ok || snap["seq"] != 1.0 {
		t.Fatalf("a newcomer must get the last keyframe (seq 1), got %v", joined[0])
	}

	// the next keyframe replaces it, the deltas after it change nothing
	r.Sync(a, 4, 1100, 33, json.RawMessage(`[[0,11,13,23,0]]`), true)
	r.Sync(a, 5, 1133, 33, json.RawMessage(`[[0,1,14,24]]`), false)
	time.Sleep(20 * time.Millisecond)
	d := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "d", Conn: d}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ = d.msgs(t)
	snap, ok = joined[0]["players"].([]any)[0].(map[string]any)["sync"].(map[string]any)
	if !ok || snap["seq"] != 4.0 {
		t.Fatalf("a newcomer must get the newest keyframe (seq 4), got %v", joined[0])
	}
}

// The keyframe flag is relayed: a receiver can tell a full snapshot from a
// delta and drop a delta it has no base for.
func TestSyncRelayMarksKeyframes(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 1, 1000, 33, json.RawMessage(`[[0,11,10,20,0]]`), true)
	r.Sync(a, 2, 1033, 33, json.RawMessage(`[[0,1,11,21]]`), false)
	time.Sleep(20 * time.Millisecond)

	msgs, _ := b.msgs(t)
	if len(msgs) != 2 || msgs[0]["k"] != true || msgs[1]["k"] != nil {
		t.Fatalf("got %v, want k only on the keyframe", msgs)
	}
}

// An older plugin sends no keyframes at all: its snapshots are full ones, so
// the newest is kept for newcomers, as before.
func TestSyncKeepsSnapshotsOfOldClient(t *testing.T) {
	r, a, _ := newTestRoom(t, 0)
	r.Sync(a, 1, 1000, 33, json.RawMessage(`[[0,11,10,20,0]]`), false)
	r.Sync(a, 2, 1033, 33, json.RawMessage(`[[0,11,11,21,0]]`), false)
	time.Sleep(20 * time.Millisecond)

	c := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: c}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ := c.msgs(t)
	snap, ok := joined[0]["players"].([]any)[0].(map[string]any)["sync"].(map[string]any)
	if !ok || snap["seq"] != 2.0 {
		t.Fatalf("a newcomer must get the newest full snapshot, got %v", joined[0])
	}
}
