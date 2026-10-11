package server

import (
	"encoding/json"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"starkflow/internal/config"
)

// End-to-end over real WebRTC on this machine: the server with a UDP port and
// clients made with pion (the browser does the same through RTCPeerConnection).

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenUDP("udp4", &net.UDPAddr{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func testServer(t *testing.T, rtcPort int) *httptest.Server {
	t.Helper()
	cfg := config.Config{
		Mode: "node", Secret: []byte("test"),
		MaxMsgBytes: 64 * 1024, IdleTimeout: 30 * time.Second, HelloTimeout: 5 * time.Second,
		SendQueue: 256, MsgRatePerSec: 60, MsgBurst: 120,
		MaxRooms: 10, MaxRoomNameRunes: 32, MaxPlayersDefault: 8, MaxPlayersCap: 8,
		EmptyTTLDefault: time.Minute, EmptyTTLCap: time.Hour, SuspendTTL: time.Minute,
		MaxStateKeys: 8, MaxStateBytes: 4096, MaxStringBytes: 1024, MaxPlayerProps: 8,
		MaxSyncBytes: 32 * 1024, StateWritesPerSec: 20, SyncBytesPerSec: 512 * 1024,
		BatchInterval: 0, MaxBatchItems: 64,
		RTCPort: rtcPort,
	}
	srv := New(cfg)
	if rtcPort > 0 && srv.rtc == nil {
		t.Fatal("the WebRTC engine did not start")
	}
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		hs.Close()
		if srv.rtc != nil {
			srv.rtc.Close()
		}
	})
	return hs
}

// tclient is one player: a WebSocket plus, optionally, a pion DataChannel.
type tclient struct {
	t  *testing.T
	ws *websocket.Conn

	mu      sync.Mutex
	wsMsgs  []map[string]any
	rtcMsgs []map[string]any
	welcome map[string]any

	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	opened chan struct{}
}

func dial(t *testing.T, hs *httptest.Server) *tclient {
	t.Helper()
	url := "ws" + strings.TrimPrefix(hs.URL, "http") + "/ws?v=1&app=test"
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := &tclient{t: t, ws: ws, opened: make(chan struct{})}
	t.Cleanup(func() {
		_ = ws.Close()
		if c.pc != nil {
			_ = c.pc.Close()
		}
	})
	c.send(map[string]any{"t": "hello", "token": "", "name": "p"})
	go c.readLoop()
	c.waitFor(func() bool { return c.welcome != nil }, "welcome")
	return c
}

func (c *tclient) send(m map[string]any) {
	b, _ := json.Marshal(m)
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteMessage(websocket.TextMessage, b)
}

func unwrap(data []byte) []map[string]any {
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	if m["t"] == "batch" {
		var out []map[string]any
		for _, it := range m["items"].([]any) {
			out = append(out, it.(map[string]any))
		}
		return out
	}
	return []map[string]any{m}
}

func (c *tclient) readLoop() {
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		for _, m := range unwrap(data) {
			c.mu.Lock()
			c.wsMsgs = append(c.wsMsgs, m)
			if m["t"] == "welcome" {
				c.welcome = m
			}
			pc := c.pc
			c.mu.Unlock()
			switch m["t"] {
			case "rtc.answer":
				_ = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m["sdp"].(string)})
			case "rtc.ice":
				b, _ := json.Marshal(m["candidate"])
				var ci webrtc.ICECandidateInit
				_ = json.Unmarshal(b, &ci)
				_ = pc.AddICECandidate(ci)
			}
		}
	}
}

func (c *tclient) waitFor(cond func() bool, what string) {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		ok := cond()
		c.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	c.t.Fatalf("timed out waiting for %s", what)
}

// openRTC does what the plugin does: offer, trickle ICE, wait for the channel.
func (c *tclient) openRTC() {
	c.t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		c.t.Fatal(err)
	}
	ordered, retr := false, uint16(0)
	dc, err := pc.CreateDataChannel("sync", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &retr})
	if err != nil {
		c.t.Fatal(err)
	}
	dc.OnOpen(func() { close(c.opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		for _, it := range unwrap(m.Data) {
			c.mu.Lock()
			c.rtcMsgs = append(c.rtcMsgs, it)
			c.mu.Unlock()
		}
	})
	pc.OnICECandidate(func(ic *webrtc.ICECandidate) {
		if ic != nil {
			c.send(map[string]any{"t": "rtc.ice", "candidate": ic.ToJSON()})
		}
	})
	c.mu.Lock()
	c.pc, c.dc = pc, dc
	c.mu.Unlock()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		c.t.Fatal(err)
	}
	c.send(map[string]any{"t": "rtc.offer", "sdp": pc.LocalDescription().SDP})
	select {
	case <-c.opened:
	case <-time.After(10 * time.Second):
		c.t.Fatal("the WebRTC channel did not open")
	}
}

func (c *tclient) syncs(rtc bool) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	src := c.wsMsgs
	if rtc {
		src = c.rtcMsgs
	}
	var out []map[string]any
	for _, m := range src {
		if m["t"] == "sync" {
			out = append(out, m)
		}
	}
	return out
}

func TestWelcomeWithoutRTC(t *testing.T) {
	hs := testServer(t, 0)
	c := dial(t, hs)
	if _, has := c.welcome["rtc"]; has {
		t.Fatalf("rtc must not be announced without STARKFLOW_RTC_PORT: %v", c.welcome)
	}
}

func TestRTCSyncEndToEnd(t *testing.T) {
	hs := testServer(t, freeUDPPort(t))
	a, b, w := dial(t, hs), dial(t, hs), dial(t, hs)
	if a.welcome["rtc"] != true {
		t.Fatalf("welcome must announce rtc: %v", a.welcome)
	}
	a.openRTC()
	b.openRTC()

	a.send(map[string]any{"t": "room.join", "room": "r1", "create": true})
	a.waitFor(func() bool {
		for _, m := range a.wsMsgs {
			if m["t"] == "room.joined" {
				return true
			}
		}
		return false
	}, "room.joined (a)")
	var roomID string
	a.mu.Lock()
	for _, m := range a.wsMsgs {
		if m["t"] == "room.joined" {
			roomID, _ = m["roomId"].(string)
		}
	}
	a.mu.Unlock()
	for _, c := range []*tclient{b, w} {
		c.send(map[string]any{"t": "room.join", "room": roomID})
		c.waitFor(func() bool {
			for _, m := range c.wsMsgs {
				if m["t"] == "room.joined" {
					return true
				}
			}
			return false
		}, "room.joined")
	}

	// a -> server over WebRTC; b gets it over WebRTC, w (no channel) over the WebSocket
	snap, _ := json.Marshal(map[string]any{"t": "sync", "seq": 1, "ts": 1000, "iv": 33, "objs": [][]int{{0, 3, 10, 20}}})
	if err := a.dc.SendText(string(snap)); err != nil {
		t.Fatal(err)
	}
	b.waitFor(func() bool {
		for _, m := range b.rtcMsgs {
			if m["t"] == "sync" {
				return true
			}
		}
		return false
	}, "sync over WebRTC (b)")
	w.waitFor(func() bool {
		for _, m := range w.wsMsgs {
			if m["t"] == "sync" {
				return true
			}
		}
		return false
	}, "sync over the WebSocket (w)")
	time.Sleep(100 * time.Millisecond)
	if n := len(b.syncs(false)); n != 0 {
		t.Fatalf("b has a channel: the snapshot must not also come over the WebSocket (%d)", n)
	}
	if got := b.syncs(true)[0]; got["id"] != 1.0 || got["seq"] != 1.0 {
		t.Fatalf("bad relayed snapshot %v", got)
	}

	// the client closes its channel: snapshots for b go over the WebSocket again
	b.send(map[string]any{"t": "rtc.close"})
	time.Sleep(100 * time.Millisecond)
	a.send(map[string]any{"t": "sync", "seq": 2, "ts": 1033, "iv": 33, "objs": [][]int{{0, 3, 11, 21}}})
	b.waitFor(func() bool {
		for _, m := range b.wsMsgs {
			if m["t"] == "sync" {
				return true
			}
		}
		return false
	}, "sync over the WebSocket after rtc.close (b)")
}
