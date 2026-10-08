package server

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"starkflow/internal/auth"
	"starkflow/internal/proto"
	"starkflow/internal/room"
)

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
		c.handle(&m)
	}
}

func (c *client) cleanup() {
	if c.rm != nil {
		c.rm.Disconnect(c)
		c.rm = nil
	}
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
		c.rm = nil
		if m.ID != 0 {
			c.Send(proto.OkFrame(m.ID))
		}
	case "room.list":
		c.Send(proto.Marshal(map[string]any{"t": "room.list.result", "id": m.ID, "rooms": c.srv.list(c.app)}))
	case "event", "state.set", "state.add", "state.toggle", "player.set":
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
		}
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
	c.Send(proto.Marshal(map[string]any{
		"t":           "welcome",
		"userId":      uid,
		"token":       auth.Sign(cfg.Secret, uid, time.Now()),
		"serverTime":  time.Now().UnixMilli(),
		"proto":       proto.Version,
		"roomNameMax": cfg.MaxRoomNameRunes,
	}))
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
		Strict:     m.Strict,
		Schema:     m.Schema,
		Init:       m.Init,
	}
	if m.EmptyTTL != nil && *m.EmptyTTL >= 0 {
		opts.EmptyTTL = time.Duration(*m.EmptyTTL) * time.Second
	}
	rm, err := c.srv.join(c.app, ref, m.Create, opts, room.JoinReq{
		ReqID:  m.ID,
		UserID: c.userID,
		Name:   c.name,
		Conn:   c,
	})
	if err != nil {
		c.Send(proto.ErrFrame(m.ID, err))
		return
	}
	c.rm = rm
}
