// Package room implements one multiplayer room. A room is a single goroutine:
// all its data is touched only from Run, so no locks are needed and every
// state operation is atomic.
package room

import (
	"encoding/json"
	"sort"
	"sync/atomic"
	"time"

	"starkflow/internal/config"
	"starkflow/internal/proto"
)

// Conn is what a room needs from a client connection.
type Conn interface {
	// Send queues a message. It must never block. It returns false if the
	// message could not be queued.
	Send(b []byte) bool
	Close()
}

// Options are chosen when the room is created.
type Options struct {
	MaxPlayers int           // 0 = server default
	EmptyTTL   time.Duration // <0 = server default; 0 = delete as soon as empty
	Strict     bool          // reject state keys that are not in Schema
	Schema     map[string]proto.RuleDef
	Init       map[string]any
}

// JoinReq is a request to enter (or re-enter) the room.
type JoinReq struct {
	ReqID  int64
	UserID string
	Name   string
	Conn   Conn
}

// Info is a lock-free summary used by room.list.
type Info struct {
	Name       string
	Players    int
	MaxPlayers int
}

// Player is a participant. A player whose connection dropped stays in the
// room as "suspended" for SuspendTTL and can come back with the same user id.
type Player struct {
	ID          int
	UserID      string
	Name        string
	Props       map[string]any
	conn        Conn
	suspendedAt time.Time
	bucket      float64
	last        time.Time
}

// Room is one game session.
type Room struct {
	Key  string // app-qualified key, unique on the server
	Name string

	cfg        config.Config
	state      *State
	players    map[int]*Player
	byUser     map[string]int
	nextID     int
	maxPlayers int
	emptyTTL   time.Duration
	everJoined bool
	emptySince time.Time
	closed     bool

	inbox   chan func()
	done    chan struct{}
	onClose func(*Room)
	count   atomic.Int32
}

// New creates a room. Call Run in its own goroutine afterwards.
func New(key, name string, opts Options, cfg config.Config, onClose func(*Room)) (*Room, *proto.Error) {
	maxP := opts.MaxPlayers
	if maxP <= 0 {
		maxP = cfg.MaxPlayersDefault
	}
	if maxP > cfg.MaxPlayersCap {
		maxP = cfg.MaxPlayersCap
	}
	ttl := opts.EmptyTTL
	if ttl < 0 {
		ttl = cfg.EmptyTTLDefault
	}
	if ttl > cfg.EmptyTTLCap {
		ttl = cfg.EmptyTTLCap
	}
	st, err := NewState(opts.Schema, opts.Init, opts.Strict, Limits{
		MaxKeys:   cfg.MaxStateKeys,
		MaxBytes:  cfg.MaxStateBytes,
		MaxString: cfg.MaxStringBytes,
	})
	if err != nil {
		return nil, err
	}
	return &Room{
		Key:        key,
		Name:       name,
		cfg:        cfg,
		state:      st,
		players:    map[int]*Player{},
		byUser:     map[string]int{},
		maxPlayers: maxP,
		emptyTTL:   ttl,
		emptySince: time.Now(),
		inbox:      make(chan func(), 256),
		done:       make(chan struct{}),
		onClose:    onClose,
	}, nil
}

// Info returns a summary; safe to call from any goroutine.
func (r *Room) Info() Info {
	return Info{Name: r.Name, Players: int(r.count.Load()), MaxPlayers: r.maxPlayers}
}

// Run is the room loop. It returns when the room is disposed.
func (r *Room) Run() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case fn := <-r.inbox:
			fn()
		case <-tick.C:
			r.housekeeping(time.Now())
		}
		if r.closed {
			return
		}
	}
}

// exec runs fn on the room goroutine. It reports false if the room is closed.
func (r *Room) exec(fn func()) bool {
	select {
	case <-r.done:
		return false
	default:
	}
	select {
	case r.inbox <- fn:
		return true
	case <-r.done:
		return false
	}
}

func (r *Room) housekeeping(now time.Time) {
	for id, p := range r.players {
		if p.conn == nil && now.Sub(p.suspendedAt) >= r.cfg.SuspendTTL {
			r.removePlayer(id, "timeout")
		}
	}
	if len(r.players) > 0 {
		r.emptySince = time.Time{}
		return
	}
	if r.emptySince.IsZero() {
		r.emptySince = now
	}
	ttl := r.emptyTTL
	if !r.everJoined && ttl < 10*time.Second {
		ttl = 10 * time.Second // grace period for the creator to arrive
	}
	if now.Sub(r.emptySince) >= ttl {
		r.dispose()
	}
}

func (r *Room) dispose() {
	r.closed = true
	r.onClose(r) // remove from the registry first, so new joins create a fresh room
	close(r.done)
}

// ---- players ---------------------------------------------------------

func (r *Room) hostID() int {
	host := 0
	for id, p := range r.players {
		if p.conn != nil && (host == 0 || id < host) {
			host = id
		}
	}
	return host
}

func (r *Room) checkHost(before int) {
	if after := r.hostID(); after != before && after != 0 {
		r.broadcast(proto.Marshal(map[string]any{"t": "host.changed", "hostId": after}), 0)
	}
}

func (r *Room) byConn(c Conn) *Player {
	for _, p := range r.players {
		if p.conn == c {
			return p
		}
	}
	return nil
}

func (r *Room) playerInfo(p *Player) map[string]any {
	status := "active"
	if p.conn == nil {
		status = "suspended"
	}
	return map[string]any{"id": p.ID, "userId": p.UserID, "name": p.Name, "status": status, "props": p.Props}
}

func (r *Room) playerList() []any {
	ids := make([]int, 0, len(r.players))
	for id := range r.players {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	out := make([]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, r.playerInfo(r.players[id]))
	}
	return out
}

func (r *Room) broadcast(b []byte, except int) {
	for id, p := range r.players {
		if p.conn != nil && id != except {
			p.conn.Send(b)
		}
	}
}

func (r *Room) removePlayer(id int, reason string) {
	p, ok := r.players[id]
	if !ok {
		return
	}
	before := r.hostID()
	delete(r.players, id)
	delete(r.byUser, p.UserID)
	r.count.Store(int32(len(r.players)))
	r.broadcast(proto.Marshal(map[string]any{"t": "player.left", "id": id, "reason": reason}), 0)
	r.checkHost(before)
}

func (r *Room) burst() float64 {
	if r.cfg.StateWritesPerSec < 1 {
		return 1
	}
	return r.cfg.StateWritesPerSec
}

func (p *Player) take(now time.Time, rate, burst float64) bool {
	p.bucket += now.Sub(p.last).Seconds() * rate
	p.last = now
	if p.bucket > burst {
		p.bucket = burst
	}
	if p.bucket < 1 {
		return false
	}
	p.bucket--
	return true
}

// ---- public API (safe to call from client goroutines) -----------------

// Join adds the player, or re-attaches a returning one (same user id).
// On success the room has already sent room.joined to the connection.
func (r *Room) Join(req JoinReq) *proto.Error {
	reply := make(chan *proto.Error, 1)
	if !r.exec(func() { reply <- r.doJoin(req) }) {
		return proto.Err(proto.ErrRoomClosed, "room is closed")
	}
	select {
	case e := <-reply:
		return e
	case <-r.done:
		select {
		case e := <-reply:
			return e
		default:
			return proto.Err(proto.ErrRoomClosed, "room is closed")
		}
	}
}

func (r *Room) doJoin(req JoinReq) *proto.Error {
	if r.closed {
		return proto.Err(proto.ErrRoomClosed, "room is closed")
	}
	now := time.Now()
	var p *Player
	resumed := false
	if id, ok := r.byUser[req.UserID]; ok {
		p = r.players[id]
		if p.conn != nil && p.conn != req.Conn {
			p.conn.Close() // the same user connected twice: the new session wins
		}
		p.conn = req.Conn
		p.suspendedAt = time.Time{}
		resumed = true
	} else {
		if len(r.players) >= r.maxPlayers {
			return proto.Err(proto.ErrRoomFull, "room is full")
		}
		r.nextID++
		p = &Player{
			ID:     r.nextID,
			UserID: req.UserID,
			Props:  map[string]any{},
			conn:   req.Conn,
			bucket: r.burst(),
			last:   now,
		}
		r.players[p.ID] = p
		r.byUser[req.UserID] = p.ID
	}
	if req.Name != "" {
		p.Name = req.Name
	}
	r.everJoined = true
	r.emptySince = time.Time{}
	r.count.Store(int32(len(r.players)))

	joined := map[string]any{
		"t":          "room.joined",
		"room":       r.Name,
		"you":        p.ID,
		"hostId":     r.hostID(),
		"maxPlayers": r.maxPlayers,
		"players":    r.playerList(),
		"state":      r.state.Snapshot(),
		"resumed":    resumed,
	}
	if req.ReqID != 0 {
		joined["id"] = req.ReqID
	}
	p.conn.Send(proto.Marshal(joined))

	ev := "player.joined"
	if resumed {
		ev = "player.resumed"
	}
	r.broadcast(proto.Marshal(map[string]any{"t": ev, "player": r.playerInfo(p)}), p.ID)
	return nil
}

// Disconnect marks the player of conn as suspended (connection lost).
func (r *Room) Disconnect(c Conn) {
	r.exec(func() {
		p := r.byConn(c)
		if p == nil {
			return // already replaced by a newer connection, or removed
		}
		before := r.hostID()
		p.conn = nil
		p.suspendedAt = time.Now()
		r.broadcast(proto.Marshal(map[string]any{"t": "player.suspended", "id": p.ID}), 0)
		r.checkHost(before)
	})
}

// Leave removes the player of conn for good.
func (r *Room) Leave(c Conn) {
	r.exec(func() {
		if p := r.byConn(c); p != nil {
			r.removePlayer(p.ID, "left")
		}
	})
}

// Event relays a game event. to is "all", "others" (default) or a player id.
func (r *Room) Event(c Conn, reqID int64, code int, data json.RawMessage, to json.RawMessage) {
	r.exec(func() {
		p := r.byConn(c)
		if p == nil {
			return
		}
		frame := proto.Marshal(map[string]any{"t": "event", "from": p.ID, "code": code, "data": data})
		if len(to) == 0 {
			r.broadcast(frame, p.ID)
			return
		}
		var mode string
		if json.Unmarshal(to, &mode) == nil {
			switch mode {
			case "all":
				r.broadcast(frame, 0)
			case "others":
				r.broadcast(frame, p.ID)
			default:
				p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrBadMessage, "to must be all, others or a player id")))
			}
			return
		}
		var id int
		if json.Unmarshal(to, &id) == nil {
			if tp := r.players[id]; tp != nil && tp.conn != nil {
				tp.conn.Send(frame)
			}
			return
		}
		p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrBadMessage, "bad target")))
	})
}

// State applies a state write (op: set, add, toggle) and broadcasts the result.
func (r *Room) State(c Conn, reqID int64, op, key string, value json.RawMessage) {
	r.exec(func() {
		p := r.byConn(c)
		if p == nil {
			return
		}
		if !p.take(time.Now(), r.cfg.StateWritesPerSec, r.burst()) {
			p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrRateLimit, "too many state writes")))
			return
		}
		ch, err := r.state.Apply(op, key, value)
		if err != nil {
			p.conn.Send(proto.ErrFrame(reqID, err))
			return
		}
		r.broadcast(proto.Marshal(map[string]any{
			"t": "state.changed", "key": ch.Key, "value": ch.New, "old": ch.Old, "by": p.ID,
		}), 0)
		if reqID != 0 {
			p.conn.Send(proto.OkFrame(reqID))
		}
	})
}

// SetProp sets a per-player property (nickname colour, ready flag, ...).
func (r *Room) SetProp(c Conn, reqID int64, key string, value json.RawMessage) {
	r.exec(func() {
		p := r.byConn(c)
		if p == nil {
			return
		}
		if !ValidKey(key) {
			p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrUnknownKey, "bad key name")))
			return
		}
		v, err := DecodeValue(value)
		if err != nil {
			p.conn.Send(proto.ErrFrame(reqID, err))
			return
		}
		if s, ok := v.(string); ok && len(s) > r.cfg.MaxStringBytes {
			p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrOutOfLimits, "string is too long")))
			return
		}
		if _, exists := p.Props[key]; !exists && len(p.Props) >= 16 {
			p.conn.Send(proto.ErrFrame(reqID, proto.Err(proto.ErrOutOfLimits, "too many player properties")))
			return
		}
		p.Props[key] = v
		r.broadcast(proto.Marshal(map[string]any{"t": "player.props", "id": p.ID, "key": key, "value": v}), 0)
		if reqID != 0 {
			p.conn.Send(proto.OkFrame(reqID))
		}
	})
}
