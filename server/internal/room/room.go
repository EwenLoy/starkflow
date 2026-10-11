// Package room implements one multiplayer room. A room is a single goroutine:
// all its data is touched only from Run, so no locks are needed and every
// state operation is atomic.
package room

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"sort"
	"strconv"
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
	Password   string // optional password: only its salted hash is kept
}

// JoinReq is a request to enter (or re-enter) the room.
type JoinReq struct {
	ReqID    int64
	UserID   string
	Name     string
	Conn     Conn
	Password string // needed to enter a locked room as a new player
}

// Info is a lock-free summary used by room.list.
type Info struct {
	ID         string // короткий хэш: он уникален, имя комнаты — просто метка
	Name       string
	Players    int
	MaxPlayers int
	Locked     bool // true if a password is needed to enter
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

	// Последний снимок объектного синка игрока ("sync"): его получает каждый,
	// кто входит в комнату, чтобы сразу увидеть объекты. nil — снимков не было.
	sync *syncSnap

	// Бюджет объектного синка: байты в секунду (см. cfg.SyncBytesPerSec). Свой
	// таймер, чтобы не мешать bucket лимита записей стейта.
	syncBucket float64
	syncLast   time.Time

	// Исходящая очередь (батчинг): кадры для этого игрока, которые уйдут одним
	// {"t":"batch"} по таймеру комнаты. nil в out — значение, вытесненное более
	// свежим (см. queue). outKeys: ключ склейки -> индекс в out.
	out     [][]byte
	outKeys map[string]int
}

// Room is one game session.
type Room struct {
	Key  string // app-qualified key (app:id), unique on the server
	ID   string // короткий хэш комнаты: одинаковые имена не мешают друг другу
	Name string // отображаемое имя, любой язык

	cfg        config.Config
	created    time.Time
	state      *State
	players    map[int]*Player
	byUser     map[string]int
	nextID     int
	maxPlayers int
	emptyTTL   time.Duration
	everJoined bool
	emptySince time.Time
	closed     bool

	passSalt []byte // set once at creation, read-only afterwards
	passHash []byte // nil = open room

	flushT     *time.Timer // сброс исходящих очередей игроков (батчинг)
	flushArmed bool

	inbox   chan func()
	done    chan struct{}
	onClose func(*Room)
	count   atomic.Int32
}

// New creates a room. Call Run in its own goroutine afterwards.
func New(key, id, name string, opts Options, cfg config.Config, onClose func(*Room)) (*Room, *proto.Error) {
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
	r := &Room{
		Key:        key,
		ID:         id,
		Name:       name,
		cfg:        cfg,
		created:    time.Now(),
		state:      st,
		players:    map[int]*Player{},
		byUser:     map[string]int{},
		maxPlayers: maxP,
		emptyTTL:   ttl,
		emptySince: time.Now(),
		inbox:      make(chan func(), 256),
		done:       make(chan struct{}),
		onClose:    onClose,
		flushT:     time.NewTimer(time.Hour),
	}
	r.flushT.Stop() // armed by queue
	if opts.Password != "" {
		r.setPassword(opts.Password)
	}
	return r, nil
}

// Info returns a summary; safe to call from any goroutine.
func (r *Room) Info() Info {
	return Info{
		ID:         r.ID,
		Name:       r.Name,
		Players:    int(r.count.Load()),
		MaxPlayers: r.maxPlayers,
		Locked:     len(r.passHash) > 0,
	}
}

// setPassword stores a salted hash of the room password. Call only from New.
func (r *Room) setPassword(pass string) {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	r.passSalt = salt
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(pass))
	r.passHash = h.Sum(nil)
}

// locked reports whether the room needs a password.
func (r *Room) locked() bool { return len(r.passHash) > 0 }

// passwordOK reports whether pass opens the room; open rooms accept anything.
func (r *Room) passwordOK(pass string) bool {
	if !r.locked() {
		return true
	}
	h := sha256.New()
	h.Write(r.passSalt)
	h.Write([]byte(pass))
	return subtle.ConstantTimeCompare(h.Sum(nil), r.passHash) == 1
}

// Created reports when the room was made; used to pick the oldest room with a name.
func (r *Room) Created() time.Time { return r.created }

// Run is the room loop. It returns when the room is disposed.
func (r *Room) Run() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	defer r.flushT.Stop()
	for {
		select {
		case fn := <-r.inbox:
			fn()
		case <-tick.C:
			r.housekeeping(time.Now())
		case <-r.flushT.C:
			r.flushArmed = false
			for _, p := range r.players {
				r.flushPlayer(p, nil)
			}
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
	info := map[string]any{"id": p.ID, "userId": p.UserID, "name": p.Name, "status": status, "props": p.Props}
	if p.sync != nil {
		info["sync"] = p.sync
	}
	return info
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

// broadcast sends b to everyone right away. Frames already queued for a
// player go out first, in the same WebSocket frame, so the order is kept.
func (r *Room) broadcast(b []byte, except int) {
	for id, p := range r.players {
		if p.conn != nil && id != except {
			r.flushPlayer(p, b)
		}
	}
}

// broadcastQueued is broadcast through the batching queue (see queue).
func (r *Room) broadcastQueued(b []byte, except int, merge string) {
	for id, p := range r.players {
		if p.conn != nil && id != except {
			r.queue(p, b, merge)
		}
	}
}

// send sends b to one player right away, after what is already queued for them.
func (r *Room) send(p *Player, b []byte) {
	if p.conn != nil {
		r.flushPlayer(p, b)
	}
}

// queue puts b into the player's outgoing queue; the room timer sends the
// whole queue as one {"t":"batch"} frame every BatchInterval. A non-empty
// merge key drops the older queued frame with the same key: only the newest
// value of a player property is worth sending.
func (r *Room) queue(p *Player, b []byte, merge string) {
	if p.conn == nil {
		return
	}
	if r.cfg.BatchInterval <= 0 {
		p.conn.Send(b)
		return
	}
	if merge != "" {
		if p.outKeys == nil {
			p.outKeys = map[string]int{}
		}
		if i, ok := p.outKeys[merge]; ok {
			p.out[i] = nil
		}
		p.outKeys[merge] = len(p.out)
	}
	p.out = append(p.out, b)
	if !r.flushArmed {
		r.flushArmed = true
		r.flushT.Reset(r.cfg.BatchInterval)
	}
}

// flushPlayer sends the player's queue plus extra (may be nil) as one frame, or
// as several frames if the batch would not fit into MaxMsgBytes.
func (r *Room) flushPlayer(p *Player, extra []byte) {
	var items [][]byte
	for _, b := range p.out {
		if b != nil {
			items = append(items, b)
		}
	}
	p.dropQueue()
	if extra != nil {
		items = append(items, extra)
	}
	if p.conn == nil || len(items) == 0 {
		return
	}
	// A frame the server would not accept as its own input is useless: split the
	// batch instead of sending one oversized frame (a snapshot is big, and a
	// player with many objects queues several of them).
	limit := int(r.cfg.MaxMsgBytes)
	if limit < 1024 {
		limit = 1024
	}
	for len(items) > 0 {
		n, size := 0, 24 // 24 = {"t":"batch","items":[]}
		for n < len(items) {
			b := len(items[n]) + 1
			if n > 0 && size+b > limit {
				break
			}
			size += b
			n++
		}
		if n == 1 {
			p.conn.Send(items[0])
		} else {
			p.conn.Send(batchFrame(items[:n]))
		}
		items = items[n:]
	}
}

// dropQueue forgets everything queued for the player.
func (p *Player) dropQueue() {
	p.out = nil
	p.outKeys = nil
}

// batchFrame wraps already encoded messages into {"t":"batch","items":[...]}.
func batchFrame(items [][]byte) []byte {
	n := 24 + len(items)
	for _, b := range items {
		n += len(b)
	}
	out := make([]byte, 0, n)
	out = append(out, `{"t":"batch","items":[`...)
	for i, b := range items {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, b...)
	}
	return append(out, "]}"...)
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

// takeSync charges n bytes to the player's snapshot budget: rate bytes per
// second, the burst is one second of traffic.
func (p *Player) takeSync(now time.Time, rate float64, n int) bool {
	p.syncBucket += now.Sub(p.syncLast).Seconds() * rate
	p.syncLast = now
	if p.syncBucket > rate {
		p.syncBucket = rate
	}
	if p.syncBucket < float64(n) {
		return false
	}
	p.syncBucket -= float64(n)
	return true
}

// ---- public API (safe to call from client goroutines) -----------------

// Join adds the player, or re-attaches a returning one (same user id).
// A locked room asks for the password only from new players: a suspended player
// returning with the same user id gets back in without it.
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
		p.dropQueue() // room.joined below carries the full snapshot
		resumed = true
	} else {
		if !r.passwordOK(req.Password) {
			return proto.Err(proto.ErrBadPassword, "wrong room password")
		}
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
		"roomId":     r.ID,
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
		p.dropQueue()
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

// Close shuts the room down and disconnects every player. Used by the
// directory admin (kick) and graceful shutdown; players may rejoin elsewhere.
func (r *Room) Close() {
	r.exec(func() {
		for _, p := range r.players {
			if p.conn != nil {
				p.conn.Close()
			}
		}
		r.dispose()
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
				r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrBadMessage, "to must be all, others or a player id")))
			}
			return
		}
		var id int
		if json.Unmarshal(to, &id) == nil {
			if tp := r.players[id]; tp != nil {
				r.send(tp, frame)
			}
			return
		}
		r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrBadMessage, "bad target")))
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
			r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrRateLimit, "too many state writes")))
			return
		}
		ch, err := r.state.Apply(op, key, value)
		if err != nil {
			r.send(p, proto.ErrFrame(reqID, err))
			return
		}
		r.broadcastQueued(proto.Marshal(map[string]any{
			"t": "state.changed", "key": ch.Key, "value": ch.New, "old": ch.Old, "by": p.ID,
		}), 0, "")
		if reqID != 0 {
			r.queue(p, proto.OkFrame(reqID), "")
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
			r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrUnknownKey, "bad key name")))
			return
		}
		v, err := DecodeValue(value)
		if err != nil {
			r.send(p, proto.ErrFrame(reqID, err))
			return
		}
		if s, ok := v.(string); ok && len(s) > r.cfg.MaxStringBytes {
			r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrOutOfLimits, "string is too long")))
			return
		}
		if _, exists := p.Props[key]; !exists && len(p.Props) >= r.cfg.MaxPlayerProps {
			r.send(p, proto.ErrFrame(reqID, proto.Err(proto.ErrOutOfLimits, "too many player properties")))
			return
		}
		p.Props[key] = v
		r.broadcastQueued(proto.Marshal(map[string]any{"t": "player.props", "id": p.ID, "key": key, "value": v}),
			0, strconv.Itoa(p.ID)+":"+key)
		if reqID != 0 {
			r.queue(p, proto.OkFrame(reqID), "")
		}
	})
}

// syncSnap is one snapshot of a player's synced objects, relayed as is.
type syncSnap struct {
	Seq  int64           `json:"seq"`
	Ts   int64           `json:"ts"`
	Iv   int             `json:"iv,omitempty"`
	Objs json.RawMessage `json:"objs"`
}

// Sync stores the newest snapshot of the player's objects and relays it to the
// others as {"t":"sync","id":...,"seq":...,"ts":...,"iv":...,"objs":[...]}.
// The server does not look inside the records: the owner is authoritative,
// the server only keeps the last snapshot for players who join later.
func (r *Room) Sync(c Conn, seq, ts int64, iv int, objs json.RawMessage) {
	r.exec(func() {
		p := r.byConn(c)
		if p == nil {
			return
		}
		if len(objs) > r.cfg.MaxSyncBytes {
			r.send(p, proto.ErrFrame(0, proto.Err(proto.ErrOutOfLimits, "sync snapshot is too big")))
			return
		}
		var arr []json.RawMessage
		if json.Unmarshal(objs, &arr) != nil {
			r.send(p, proto.ErrFrame(0, proto.Err(proto.ErrBadType, "sync: objs must be an array")))
			return
		}
		// The snapshot is relayed to every other player, so it is charged to a byte
		// budget. An empty snapshot ("no objects any more") is always allowed: it
		// costs nothing and must reach the others, or their copies never go away.
		if len(arr) > 0 && r.cfg.SyncBytesPerSec > 0 {
			if !p.takeSync(time.Now(), float64(r.cfg.SyncBytesPerSec), len(objs)) {
				r.send(p, proto.ErrFrame(0, proto.Err(proto.ErrRateLimit, "sync: too many bytes per second")))
				return
			}
		}
		if iv < 0 || iv > 60000 {
			iv = 0
		}
		if len(arr) == 0 {
			p.sync = nil // no objects any more: nothing to show to newcomers
		} else {
			p.sync = &syncSnap{Seq: seq, Ts: ts, Iv: iv, Objs: objs}
		}
		r.broadcastQueued(proto.Marshal(map[string]any{
			"t": "sync", "id": p.ID, "seq": seq, "ts": ts, "iv": iv, "objs": objs,
		}), p.ID, "")
	})
}
