package room

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// rtcConn is a fakeConn with an open (or closed) unreliable channel.
type rtcConn struct {
	fakeConn
	open bool
	mu2  sync.Mutex
	udp  [][]byte
}

func (c *rtcConn) SendUnreliable(b []byte) bool {
	if !c.open {
		return false
	}
	c.mu2.Lock()
	c.udp = append(c.udp, b)
	c.mu2.Unlock()
	return true
}

func (c *rtcConn) udpCount() int {
	c.mu2.Lock()
	defer c.mu2.Unlock()
	return len(c.udp)
}

func TestSyncGoesOneWayPerReceiver(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	cOpen := &rtcConn{open: true}
	cClosed := &rtcConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: cOpen}); e != nil {
		t.Fatal(e)
	}
	if e := r.Join(JoinReq{UserID: "d", Conn: cClosed}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	cOpen.reset()
	cClosed.reset()
	b.reset()

	r.Sync(a, 1, 1000, 33, json.RawMessage(`[[0,3,10,20]]`), false)
	time.Sleep(20 * time.Millisecond)
	if n := cOpen.udpCount(); n != 1 {
		t.Fatalf("open channel: got %d WebRTC frames, want 1", n)
	}
	if msgs, _ := cOpen.msgs(t); len(msgs) != 0 {
		t.Fatalf("open channel: the snapshot must not also go over the WebSocket, got %v", msgs)
	}
	if msgs, _ := cClosed.msgs(t); len(msgs) != 1 || msgs[0]["t"] != "sync" {
		t.Fatalf("closed channel: want the snapshot over the WebSocket, got %v", msgs)
	}
	if msgs, _ := b.msgs(t); len(msgs) != 1 {
		t.Fatalf("plain conn: want the snapshot over the WebSocket, got %v", msgs)
	}

	// the empty snapshot always goes over the WebSocket
	r.Sync(a, 2, 1033, 33, json.RawMessage(`[]`), false)
	time.Sleep(20 * time.Millisecond)
	if n := cOpen.udpCount(); n != 1 {
		t.Fatalf("the empty snapshot must not go over WebRTC, got %d WebRTC frames", n)
	}
	if msgs, _ := cOpen.msgs(t); len(msgs) != 1 || msgs[0]["objs"] == nil {
		t.Fatalf("the empty snapshot must go over the WebSocket, got %v", msgs)
	}
}

func TestSyncDropsLateSnapshots(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 5, 1000, 33, json.RawMessage(`[[0,3,1,1]]`), false)
	r.Sync(a, 6, 1033, 33, json.RawMessage(`[]`), false)          // "no objects any more"
	r.Sync(a, 4, 967, 33, json.RawMessage(`[[0,3,0,0]]`), false)  // late, reordered
	r.Sync(a, 6, 1033, 33, json.RawMessage(`[[0,3,0,0]]`), false) // duplicate seq
	time.Sleep(20 * time.Millisecond)
	msgs, _ := b.msgs(t)
	if len(msgs) != 2 || msgs[1]["seq"] != 6.0 {
		t.Fatalf("late snapshots must not be relayed, got %v", msgs)
	}
	// and must not bring the objects back for newcomers
	c := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: c}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	joined, _ := c.msgs(t)
	if _, has := joined[0]["players"].([]any)[0].(map[string]any)["sync"]; has {
		t.Fatal("a late snapshot after the empty one must not be stored")
	}
}

func TestSyncSeqResetsOnResume(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 50, 1000, 33, json.RawMessage(`[[0,3,1,1]]`), false)
	time.Sleep(10 * time.Millisecond)
	// the page reloads: same user, new connection, seq starts from 1 again
	a2 := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "a", Conn: a2}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	b.reset()
	r.Sync(a2, 1, 10, 33, json.RawMessage(`[[0,3,2,2]]`), false)
	time.Sleep(20 * time.Millisecond)
	if msgs, _ := b.msgs(t); len(msgs) != 1 || msgs[0]["seq"] != 1.0 {
		t.Fatalf("after a resume seq 1 must be accepted, got %v", msgs)
	}
}

func TestSyncWithoutSeqIsAlwaysAccepted(t *testing.T) {
	r, a, b := newTestRoom(t, 0)
	r.Sync(a, 0, 1000, 33, json.RawMessage(`[[0,3,1,1]]`), false)
	r.Sync(a, 0, 1033, 33, json.RawMessage(`[[0,3,2,2]]`), false)
	time.Sleep(20 * time.Millisecond)
	if msgs, _ := b.msgs(t); len(msgs) != 2 {
		t.Fatalf("unnumbered snapshots (old clients) must pass, got %v", msgs)
	}
}
