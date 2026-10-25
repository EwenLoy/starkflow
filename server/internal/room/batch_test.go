package room

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"starkflow/internal/config"
)

type fakeConn struct {
	mu     sync.Mutex
	frames [][]byte
}

func (c *fakeConn) Send(b []byte) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, b)
	return true
}

func (c *fakeConn) Close() {}

// msgs returns every message received, with batch frames unwrapped, and the frame count.
func (c *fakeConn) msgs(t *testing.T) ([]map[string]any, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []map[string]any
	for _, f := range c.frames {
		var m map[string]any
		if err := json.Unmarshal(f, &m); err != nil {
			t.Fatalf("bad frame %s: %v", f, err)
		}
		if m["t"] == "batch" {
			for _, it := range m["items"].([]any) {
				out = append(out, it.(map[string]any))
			}
			continue
		}
		out = append(out, m)
	}
	return out, len(c.frames)
}

func (c *fakeConn) reset() {
	c.mu.Lock()
	c.frames = nil
	c.mu.Unlock()
}

func newTestRoom(t *testing.T, batch time.Duration) (*Room, *fakeConn, *fakeConn) {
	return newTestRoomCfg(t, func(c *config.Config) { c.BatchInterval = batch })
}

func newTestRoomCfg(t *testing.T, tweak func(*config.Config)) (*Room, *fakeConn, *fakeConn) {
	t.Helper()
	cfg := config.Config{
		MaxPlayersDefault: 4, MaxPlayersCap: 4, EmptyTTLCap: time.Minute,
		MaxStateKeys: 8, MaxStateBytes: 4096, MaxStringBytes: 1024, MaxPlayerProps: 8, MaxSyncBytes: 32 * 1024,
		MaxMsgBytes:       64 * 1024,
		StateWritesPerSec: 100, SuspendTTL: time.Minute, BatchInterval: 0,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	r, err := New("app:r", "r", "r", Options{EmptyTTL: -1}, cfg, func(*Room) {})
	if err != nil {
		t.Fatal(err)
	}
	go r.Run()
	t.Cleanup(r.Close)
	a, b := &fakeConn{}, &fakeConn{}
	if e := r.Join(JoinReq{UserID: "a", Conn: a}); e != nil {
		t.Fatal(e)
	}
	if e := r.Join(JoinReq{UserID: "b", Conn: b}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	a.reset()
	b.reset()
	return r, a, b
}

func TestBatchMergesPropsIntoOneFrame(t *testing.T) {
	r, a, b := newTestRoom(t, 30*time.Millisecond)
	for _, v := range []string{"1", "2", "3"} {
		r.SetProp(a, 0, "pos", json.RawMessage(v))
	}
	r.SetProp(a, 0, "hp", json.RawMessage("7"))
	time.Sleep(80 * time.Millisecond)

	msgs, frames := b.msgs(t)
	if frames != 1 {
		t.Fatalf("frames = %d, want 1", frames)
	}
	if len(msgs) != 2 || msgs[0]["key"] != "pos" || msgs[0]["value"] != 3.0 || msgs[1]["key"] != "hp" {
		t.Fatalf("got %v, want the newest pos then hp", msgs)
	}
}

func TestImmediateMessageKeepsOrder(t *testing.T) {
	r, a, b := newTestRoom(t, time.Hour) // the timer never fires during the test
	r.SetProp(a, 0, "pos", json.RawMessage("1"))
	r.Event(a, 0, 5, json.RawMessage(`"boom"`), nil)
	time.Sleep(20 * time.Millisecond)

	msgs, frames := b.msgs(t)
	if frames != 1 || len(msgs) != 2 || msgs[0]["t"] != "player.props" || msgs[1]["t"] != "event" {
		t.Fatalf("got %d frames %v, want props then event in one frame", frames, msgs)
	}
}

func TestNoBatching(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.SetProp(a, 0, "pos", json.RawMessage("1"))
	r.SetProp(a, 0, "pos", json.RawMessage("2"))
	time.Sleep(20 * time.Millisecond)

	msgs, frames := b.msgs(t)
	if frames != 2 || len(msgs) != 2 {
		t.Fatalf("got %d frames %v, want one frame per change", frames, msgs)
	}
}

func TestSyncRelayAndSnapshotForNewcomer(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 1, 1000, 33, json.RawMessage(`[[0,3,10,20]]`), false)
	r.Sync(a, 2, 1033, 33, json.RawMessage(`[[0,3,11,21]]`), false)
	time.Sleep(20 * time.Millisecond)

	if msgs, _ := a.msgs(t); len(msgs) != 0 {
		t.Fatalf("the sender must not get its own snapshots, got %v", msgs)
	}
	msgs, _ := b.msgs(t)
	if len(msgs) != 2 || msgs[1]["t"] != "sync" || msgs[1]["seq"] != 2.0 || msgs[1]["ts"] != 1033.0 || msgs[1]["id"] != 1.0 {
		t.Fatalf("got %v, want two sync messages from player 1", msgs)
	}

	c := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: c}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ := c.msgs(t)
	players := joined[0]["players"].([]any)
	snap, ok := players[0].(map[string]any)["sync"].(map[string]any)
	if !ok || snap["seq"] != 2.0 {
		t.Fatalf("a newcomer must get the last snapshot, got %v", players[0])
	}

	// an empty snapshot removes the stored one
	r.Sync(a, 3, 1066, 33, json.RawMessage(`[]`), false)
	d := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "d", Conn: d}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ = d.msgs(t)
	if _, has := joined[0]["players"].([]any)[0].(map[string]any)["sync"]; has {
		t.Fatal("an empty snapshot must clear the stored one")
	}
}

func TestSyncRejectsBadSnapshots(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 1, 1, 0, json.RawMessage(`{"x":1}`), false)
	r.Sync(a, 2, 1, 0, json.RawMessage(`"`+string(make([]byte, 40000))+`"`), false)
	time.Sleep(20 * time.Millisecond)
	msgs, _ := a.msgs(t)
	if len(msgs) != 2 || msgs[0]["code"] != 401.0 || msgs[1]["code"] != 404.0 {
		t.Fatalf("got %v, want errors 401 and 404", msgs)
	}
	if got, _ := b.msgs(t); len(got) != 0 {
		t.Fatalf("bad snapshots must not be relayed, got %v", got)
	}
}

// A batch that would not fit into the frame limit the server itself accepts is
// split instead of sent as one oversized frame.
func TestBatchSplitsByFrameLimit(t *testing.T) {
	r, a, b := newTestRoomCfg(t, func(c *config.Config) {
		c.BatchInterval = 30 * time.Millisecond
		c.MaxMsgBytes = 2048
		c.MaxPlayerProps = 32
	})
	for i := 0; i < 12; i++ {
		r.SetProp(a, 0, "k"+strconv.Itoa(i), json.RawMessage(`"`+strings.Repeat("x", 400)+`"`))
	}
	time.Sleep(120 * time.Millisecond)

	msgs, frames := b.msgs(t)
	if frames < 3 {
		t.Fatalf("frames = %d, want the batch split into several frames", frames)
	}
	if len(msgs) != 12 {
		t.Fatalf("got %d messages, want all 12 across the frames", len(msgs))
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, f := range b.frames {
		if len(f) > 2048 {
			t.Fatalf("a frame of %d bytes is over the limit of the server", len(f))
		}
	}
}

// The object sync channel is charged to a byte budget: a client cannot flood the
// room with full-size snapshots, but an empty snapshot (objects are gone) always
// goes through.
func TestSyncByteBudget(t *testing.T) {
	r, a, b := newTestRoomCfg(t, func(c *config.Config) {
		c.BatchInterval = 0
		c.SyncBytesPerSec = 1000
	})
	objs := json.RawMessage(`[[0,3,10,20]]`)
	for i := 0; i < 200; i++ {
		r.Sync(a, int64(i+1), int64(i), 33, objs, false)
	}
	time.Sleep(20 * time.Millisecond)

	errs := 0
	msgs, _ := a.msgs(t)
	for _, m := range msgs {
		if m["t"] == "err" && m["code"] == 500.0 {
			errs++
		}
	}
	if errs == 0 {
		t.Fatalf("want a rate limit error after the budget is used up, got %v", msgs)
	}
	relayed, _ := b.msgs(t)
	if len(relayed) == 0 || len(relayed) >= 200 {
		t.Fatalf("relayed = %d, want some snapshots but not all 200", len(relayed))
	}

	// the budget is used up, but "no objects any more" must still reach the others
	r.Sync(a, 9999, 1, 33, json.RawMessage(`[]`), false)
	time.Sleep(20 * time.Millisecond)
	relayed, _ = b.msgs(t)
	last := relayed[len(relayed)-1]
	if last["t"] != "sync" || len(last["objs"].([]any)) != 0 {
		t.Fatalf("an empty snapshot must be relayed, got %v", last)
	}
}
