package server

import (
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"starkflow/internal/auth"
	"starkflow/internal/proto"
	"starkflow/internal/room"
	"starkflow/internal/rtc"
)

// maxRTCOffers limits how many WebRTC channels one connection may set up: the
// plugin makes one, a reconnect is a new connection anyway.
const maxRTCOffers = 4

// maxSDP is the largest offer accepted (a DataChannel-only offer is ~1 KB).
const maxSDP = 16 * 1024

// client is one WebSocket connection. It implements room.Conn.
type client struct {
	srv  *Server
	conn *websocket.Conn
	app  string

	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once

	// touched only by the read goroutine
	hello  bool
	userID string
	name   string
	rm     *room.Room
	tok    float64
	last   time.Time
	offers int // rtc.offer received

	// rmA mirrors rm for the WebRTC goroutine: snapshots from the DataChannel
	// do not come through the read goroutine.
	rmA  atomic.Pointer[room.Room]
	peer atomic.Pointer[rtc.Peer] // nil = no WebRTC channel
}

// rtcLimit is the rate limit of one WebRTC channel, touched only by its
// message goroutine (a new channel gets a new one: no sharing between them).
type rtcLimit struct {
	tok  float64
	last time.Time
}

// setRoom is the only place rm changes.
func (c *client) setRoom(rm *room.Room) {
	c.rm = rm
	c.rmA.Store(rm)
}

// SendUnreliable sends a "sync" frame over the WebRTC channel if it is open
// (room.UnreliableConn). false = send it over the WebSocket.
func (c *client) SendUnreliable(b []byte) bool {
	p := c.peer.Load()
	return p != nil && p.Send(b)
}

// Send queues a frame without blocking. A client that cannot keep up is dropped.
func (c *client) Send(b []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.send <- b:
		return true
	default:
		c.Close()
		return false
	}
}

// Close shuts the connection down. Safe to call many times from any goroutine.
func (c *client) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// fatal sends an error and closes shortly after, so the frame can be flushed.
func (c *client) fatal(id int64, e *proto.Error) {
	c.Send(proto.ErrFrame(id, e))
	time.AfterFunc(300*time.Millisecond, c.Close)
}

func (c *client) writePump() {
	ping := time.NewTicker(c.srv.cfg.IdleTimeout / 3)
	defer ping.Stop()
	for {
		select {
		case b := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, b); err != nil {
				c.Close()
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.Close()
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *client) readPump() {
	defer c.cleanup()
	cfg := c.srv.cfg
	c.conn.SetReadLimit(cfg.MaxMsgBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(cfg.HelloTimeout))
	c.conn.SetPongHandler(func(string) error {
		if c.hello {
			_ = c.conn.SetReadDeadline(time.Now().Add(cfg.IdleTimeout))
		}
		return nil
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if c.hello {
			_ = c.conn.SetReadDeadline(time.Now().Add(cfg.IdleTimeout))
		}
		if !c.allow() {
			c.Send(proto.ErrFrame(0, proto.Err(proto.ErrRateLimit, "too many messages")))
			continue
		}
		var m proto.ClientMsg
		if err := json.Unmarshal(data, &m); err != nil {
			c.Send(proto.ErrFrame(0, proto.Err(proto.ErrBadMessage, "invalid JSON")))
			continue
		}
		if m.T == "batch" {
			c.handleBatch(&m)
			continue
		}
		c.handle(&m)
	}
}

// handleBatch runs every item of {"t":"batch","items":[...]} as if it came in
// its own frame. Each item costs a rate-limit token like a normal message (the
// frame itself paid for the first one), so batching saves frames, not limits.
func (c *client) handleBatch(m *proto.ClientMsg) {
	if !c.hello {
		c.fatal(m.ID, proto.Err(proto.ErrNotReady, "send hello first"))
		return
	}
	if len(m.Items) == 0 {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "empty batch")))
		return
	}
	if len(m.Items) > c.srv.cfg.MaxBatchItems {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrMsgTooLarge, "too many items in batch")))
		return
	}
	for i, raw := range m.Items {
		var item proto.ClientMsg
		if err := json.Unmarshal(raw, &item); err != nil {
			c.Send(proto.ErrFrame(0, proto.Err(proto.ErrBadMessage, "invalid JSON in batch")))
			continue
		}
		if i > 0 && !c.allow() {
			// The frame paid for the first item, the rest cost a token each. Once the
			// limit is hit the remaining items are dropped with ONE error: answering
			// a 64-item batch with dozens of frames would only make it worse.
			c.Send(proto.ErrFrame(item.ID, proto.Err(proto.ErrRateLimit, "too many messages")))
			break
		}
		if item.T == "batch" || item.T == "hello" {
			c.Send(proto.ErrFrame(item.ID, proto.Err(proto.ErrBadMessage, item.T+" is not allowed inside a batch")))
			continue
		}
		c.handle(&item)
	}
}

func (c *client) cleanup() {
	if c.rm != nil {
		c.rm.Disconnect(c)
		c.setRoom(nil)
	}
	c.stopRTC()
	c.Close()
}

// allow is a token bucket limiting messages per second per connection.
func (c *client) allow() bool {
	cfg := c.srv.cfg
	now := time.Now()
	c.tok += now.Sub(c.last).Seconds() * cfg.MsgRatePerSec
	c.last = now
	if c.tok > cfg.MsgBurst {
		c.tok = cfg.MsgBurst
	}
	if c.tok < 1 {
		return false
	}
	c.tok--
	return true
}

func cleanName(n string) string {
	n = strings.TrimSpace(n)
	r := []rune(n)
	if len(r) > 32 {
		r = r[:32]
	}
	return string(r)
}

func (c *client) handle(m *proto.ClientMsg) {
	if !c.hello {
		if m.T != "hello" {
			c.fatal(m.ID, proto.Err(proto.ErrNotReady, "send hello first"))
			return
		}
		c.onHello(m)
		return
	}
	switch m.T {
	case "ping":
		c.Send(proto.Marshal(map[string]any{"t": "pong", "ts": m.Ts, "serverTime": time.Now().UnixMilli()}))
	case "room.join":
		c.onJoin(m)
	case "room.leave":
		if c.rm == nil {
			c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrNotInRoom, "you are not in a room")))
			return
		}
		c.rm.Leave(c)
		c.setRoom(nil)
		if m.ID != 0 {
			c.Send(proto.OkFrame(m.ID))
		}
	case "room.list":
		c.Send(proto.Marshal(map[string]any{"t": "room.list.result", "id": m.ID, "rooms": c.srv.list(c.app)}))
	case "event", "state.set", "state.add", "state.toggle", "player.set", "sync":
		if c.rm == nil {
			c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrNotInRoom, "you are not in a room")))
			return
		}
		switch m.T {
		case "event":
			c.rm.Event(c, m.ID, m.Code, m.Data, m.To)
		case "state.set":
			c.rm.State(c, m.ID, "set", m.Key, m.Value)
		case "state.add":
			c.rm.State(c, m.ID, "add", m.Key, m.Value)
		case "state.toggle":
			c.rm.State(c, m.ID, "toggle", m.Key, m.Value)
		case "player.set":
			c.rm.SetProp(c, m.ID, m.Key, m.Value)
		case "sync":
			c.rm.Sync(c, m.Seq, m.Ts, m.Iv, m.Objs)
		}
	case "rtc.offer":
		c.onRTCOffer(m)
	case "rtc.ice":
		c.onRTCIce(m)
	case "rtc.close":
		c.stopRTC()
	default:
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "unknown message type: "+m.T)))
	}
}

func (c *client) onHello(m *proto.ClientMsg) {
	cfg := c.srv.cfg
	uid := ""
	if m.Token != "" {
		u, ok := auth.Verify(cfg.Secret, m.Token, auth.MaxAge, time.Now())
		if !ok {
			c.fatal(m.ID, proto.Err(proto.ErrBadToken, "invalid or expired token"))
			return
		}
		uid = u
	} else {
		uid = auth.NewUserID()
	}
	c.userID = uid
	c.name = cleanName(m.Name)
	c.hello = true
	_ = c.conn.SetReadDeadline(time.Now().Add(cfg.IdleTimeout))
	welcome := map[string]any{
		"t":           "welcome",
		"userId":      uid,
		"token":       auth.Sign(cfg.Secret, uid, time.Now()),
		"serverTime":  time.Now().UnixMilli(),
		"proto":       proto.Version,
		"roomNameMax": cfg.MaxRoomNameRunes,
		// the client may send {"t":"batch"} and must accept it from the server
		"batch":          true,
		"maxString":      cfg.MaxStringBytes,
		"maxPlayerProps": cfg.MaxPlayerProps,
		// maxMsg is the frame limit the server itself accepts: the client must keep
		// its batches below it (the plugin sizes its batches from this).
		"maxMsg": cfg.MaxMsgBytes,
		// the client may use the "sync" channel for object snapshots
		"sync":    true,
		"maxSync": cfg.MaxSyncBytes,
		"batchMs": cfg.BatchInterval.Milliseconds(),
	}
	if c.srv.rtc != nil {
		// the client may open the WebRTC channel for "sync" (rtc.offer)
		welcome["rtc"] = true
		ice := []any{}
		if len(cfg.RTCICEServers) > 0 {
			ice = append(ice, map[string]any{"urls": cfg.RTCICEServers})
		}
		welcome["iceServers"] = ice
	}
	c.Send(proto.Marshal(welcome))
}

// ---- WebRTC channel for "sync" ---------------------------------------------

// onRTCOffer answers the client's offer. The previous channel, if any, is dropped.
func (c *client) onRTCOffer(m *proto.ClientMsg) {
	if c.srv.rtc == nil {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "WebRTC is disabled on this server")))
		return
	}
	if m.Sdp == "" || len(m.Sdp) > maxSDP {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "rtc.offer: bad sdp")))
		return
	}
	c.offers++
	if c.offers > maxRTCOffers {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrRateLimit, "rtc.offer: too many offers")))
		return
	}
	c.stopRTC()
	var self atomic.Pointer[rtc.Peer]
	lim := &rtcLimit{tok: c.srv.cfg.MsgBurst, last: time.Now()}
	p, answer, err := c.srv.rtc.Answer(m.Sdp, rtc.Handlers{
		Candidate: func(ci webrtc.ICECandidateInit) {
			c.Send(proto.Marshal(map[string]any{"t": "rtc.ice", "candidate": ci}))
		},
		Message: func(b []byte) { c.onRTCMessage(lim, b) },
		Closed: func() {
			// failed or closed by the client's side: tell it to stop using the channel
			if p := self.Load(); p != nil && c.peer.CompareAndSwap(p, nil) {
				c.Send(proto.Marshal(map[string]any{"t": "rtc.close"}))
			}
		},
	})
	if err != nil {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "rtc.offer: "+err.Error())))
		return
	}
	self.Store(p)
	c.peer.Store(p)
	c.Send(proto.Marshal(map[string]any{"t": "rtc.answer", "sdp": answer}))
}

func (c *client) onRTCIce(m *proto.ClientMsg) {
	p := c.peer.Load()
	if p == nil || len(m.Candidate) == 0 {
		return // late candidate of a dropped channel: nothing to do
	}
	var ci webrtc.ICECandidateInit
	if json.Unmarshal(m.Candidate, &ci) != nil {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrBadMessage, "rtc.ice: bad candidate")))
		return
	}
	_ = p.AddCandidate(ci) // a candidate we cannot use is not an error for the client
}

// stopRTC drops the channel; "sync" goes over the WebSocket again.
func (c *client) stopRTC() {
	if p := c.peer.Swap(nil); p != nil {
		p.Close()
	}
}

// onRTCMessage handles one message from the DataChannel. Only "sync" is
// accepted; it goes through the same Room.Sync checks as from the WebSocket,
// errors are sent over the WebSocket.
func (c *client) onRTCMessage(lim *rtcLimit, data []byte) {
	cfg := c.srv.cfg
	now := time.Now()
	lim.tok += now.Sub(lim.last).Seconds() * cfg.MsgRatePerSec
	lim.last = now
	if lim.tok > cfg.MsgBurst {
		lim.tok = cfg.MsgBurst
	}
	if lim.tok < 1 {
		return // over the limit: an unreliable snapshot is simply dropped
	}
	lim.tok--
	var m proto.ClientMsg
	if json.Unmarshal(data, &m) != nil || m.T != "sync" {
		return
	}
	if rm := c.rmA.Load(); rm != nil {
		rm.Sync(c, m.Seq, m.Ts, m.Iv, m.Objs)
	}
}

func (c *client) onJoin(m *proto.ClientMsg) {
	if c.rm != nil {
		c.Send(proto.ErrFrame(m.ID, proto.Err(proto.ErrAlreadyIn, "already in a room, leave it first")))
		return
	}
	// room.join: ref — это id комнаты (hex) или её имя на любом языке.
	// Имена не уникальны, поэтому при create=true всегда создаётся НОВАЯ комната,
	// а id выделяет сервер. При create=false ищем сначала по id, потом по имени
	// (самую старую комнату с таким именем).
	ref := m.Room
	if m.Create {
		name, e := c.srv.cleanRoomName(ref)
		if e != nil {
			c.Send(proto.ErrFrame(m.ID, e))
			return
		}
		ref = name
	} else {
		clean, e := c.srv.ValidRoomRef(ref)
		if e != nil {
			c.Send(proto.ErrFrame(m.ID, e))
			return
		}
		ref = clean
	}
	opts := room.Options{
		MaxPlayers: m.MaxPlayers,
		EmptyTTL:   -1,
		SuspendTTL: -1,
		Strict:     m.Strict,
		Schema:     m.Schema,
		Init:       m.Init,
		Password:   m.Password,
	}
	if m.EmptyTTL != nil && *m.EmptyTTL >= 0 {
		opts.EmptyTTL = time.Duration(*m.EmptyTTL) * time.Second
	}
	if m.SuspendTTL != nil && *m.SuspendTTL >= 0 {
		opts.SuspendTTL = time.Duration(*m.SuspendTTL) * time.Second
	}
	joinName := m.Name
	if joinName == "" {
		joinName = c.name
	}
	rm, err := c.srv.join(c.app, ref, m.Create, opts, room.JoinReq{
		ReqID:    m.ID,
		UserID:   c.userID,
		Name:     joinName,
		Conn:     c,
		Password: m.Password,
	})
	if err != nil {
		c.Send(proto.ErrFrame(m.ID, err))
		return
	}
	c.setRoom(rm)
}
