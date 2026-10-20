package room

import (
	"testing"
	"time"

	"starkflow/internal/config"
)

func newSuspendRoom(t *testing.T, suspend time.Duration) (*Room, *fakeConn, *fakeConn) {
	t.Helper()
	cfg := config.Config{
		MaxPlayersDefault: 4, MaxPlayersCap: 4, EmptyTTLCap: time.Minute,
		MaxStateKeys: 8, MaxStateBytes: 4096, MaxStringBytes: 1024, MaxPlayerProps: 8, MaxSyncBytes: 32 * 1024,
		MaxMsgBytes:       64 * 1024,
		StateWritesPerSec: 100, SuspendTTL: time.Minute, SuspendTTLCap: 5 * time.Minute, BatchInterval: 0,
	}
	r, err := New("app:r", "r", "r", Options{EmptyTTL: -1, SuspendTTL: suspend}, cfg, func(*Room) {})
	if err != nil {
		t.Fatal(err)
	}
	go r.Run()
	t.Cleanup(r.Close)
	a, b := &fakeConn{}, &fakeConn{}
	if e := r.Join(JoinReq{UserID: "a", Name: "Alice", Conn: a}); e != nil {
		t.Fatal(e)
	}
	if e := r.Join(JoinReq{UserID: "b", Name: "Bob", Conn: b}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	a.reset()
	b.reset()
	return r, a, b
}

// A room with the player timeout 0 drops a lost player at once: the others get
// player.left in the same moment instead of player.suspended plus a 30 second wait.
func TestSuspendZeroRemovesPlayerAtOnce(t *testing.T) {
	r, a, b := newSuspendRoom(t, 0)
	r.Disconnect(b)
	time.Sleep(10 * time.Millisecond)

	got, _ := a.msgs(t)
	if len(got) != 1 || got[0]["t"] != "player.left" {
		t.Fatalf("got %v, want one player.left and no player.suspended", got)
	}
	if got[0]["id"] != 2.0 || got[0]["reason"] != "left" || got[0]["name"] != "Bob" {
		t.Fatalf("player.left = %v, want id 2, reason left, name Bob", got[0])
	}
	if n := r.Info().Players; n != 1 {
		t.Fatalf("players = %d, want 1: the lost player must be gone", n)
	}
}

// With the default timeout the place is kept and player.suspended is sent instead.
func TestSuspendDefaultKeepsThePlace(t *testing.T) {
	r, a, b := newSuspendRoom(t, -1)
	r.Disconnect(b)
	time.Sleep(10 * time.Millisecond)

	got, _ := a.msgs(t)
	if len(got) != 1 || got[0]["t"] != "player.suspended" || got[0]["id"] != 2.0 {
		t.Fatalf("got %v, want one player.suspended for id 2", got)
	}
	if n := r.Info().Players; n != 2 {
		t.Fatalf("players = %d, want 2: the place must be kept", n)
	}
}

// room.joined tells the client which timeout the room uses.
func TestJoinedReportsSuspendTTL(t *testing.T) {
	r, _, _ := newSuspendRoom(t, 42*time.Second)
	c := &fakeConn{}
	if e := r.Join(JoinReq{UserID: "c", Conn: c}); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Millisecond)
	got, _ := c.msgs(t)
	if len(got) == 0 || got[0]["t"] != "room.joined" || got[0]["suspendTTL"] != 42.0 {
		t.Fatalf("room.joined = %v, want suspendTTL 42", got)
	}
}
