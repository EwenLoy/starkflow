// Package server wires WebSocket connections to rooms.
package server

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"starkflow/internal/config"
	"starkflow/internal/directory"
	"starkflow/internal/proto"
	"starkflow/internal/room"
	"starkflow/internal/rtc"
)

//go:embed web/index.html
var webFS embed.FS

// Server owns the room registry and the HTTP endpoints.
type Server struct {
	cfg      config.Config
	upgrader websocket.Upgrader

	mu       sync.Mutex
	rooms    map[string]*room.Room
	draining atomic.Bool

	rtc *rtc.Engine // nil = WebRTC is off (no STARKFLOW_RTC_PORT, or the port failed)
}

// New creates a server.
func New(cfg config.Config) *Server {
	s := &Server{cfg: cfg, rooms: map[string]*room.Room{}}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     s.checkOrigin,
	}
	if cfg.RTCPort > 0 {
		e, err := rtc.New(cfg.RTCPort, cfg.RTCPublicIPs)
		if err != nil {
			// not fatal: the clients simply stay on the WebSocket
			slog.Error("WebRTC is disabled", "err", err)
		} else {
			s.rtc = e
			slog.Info("WebRTC sync channel", "udpPort", cfg.RTCPort, "publicIPs", cfg.RTCPublicIPs)
		}
	}
	return s
}

// Handler returns the HTTP handler: /ws, /health and the built-in test page.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// The cluster client measures the latency to each region through this
		// endpoint, so a browser page on another origin must be allowed to read it.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/cluster/admin", s.handleClusterAdmin)
	sub, err := fs.Sub(webFS, "web")
	if err == nil {
		mux.Handle("/", http.FileServer(http.FS(sub)))
	}
	return mux
}

func (s *Server) checkOrigin(r *http.Request) bool {
	if len(s.cfg.AllowedOrigins) == 0 {
		return true // development: allow everything
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // not a browser
	}
	for _, o := range s.cfg.AllowedOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func validName(n string) bool {
	if len(n) == 0 || len(n) > 64 {
		return false
	}
	for _, c := range n {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' || c == ':'
		if !ok {
			return false
		}
	}
	return true
}

func (s *Server) onRoomClosed(r *room.Room) {
	s.mu.Lock()
	if s.rooms[r.Key] == r {
		delete(s.rooms, r.Key)
	}
	s.mu.Unlock()
	slog.Info("room closed", "room", r.Key)
}

// cleanRoomName checks a display name: any language (Unicode), length counted in
// characters, no control symbols. Names are not unique: the room id is.
func (s *Server) cleanRoomName(n string) (string, *proto.Error) {
	n = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, n)
	n = strings.TrimSpace(n)
	if n == "" {
		return "", proto.Err(proto.ErrBadRoomName, "room name cannot be empty")
	}
	if c := utf8.RuneCountInString(n); c > s.cfg.MaxRoomNameRunes {
		return "", proto.Err(proto.ErrBadRoomName,
			fmt.Sprintf("room name: up to %d characters", s.cfg.MaxRoomNameRunes))
	}
	return n, nil
}

// ValidRoomRef reports whether a join reference (room id or name) is acceptable.
func (s *Server) ValidRoomRef(ref string) (string, *proto.Error) {
	if utf8.RuneCountInString(ref) > s.cfg.MaxRoomNameRunes {
		return "", proto.Err(proto.ErrBadRoomName,
			fmt.Sprintf("room id or name: up to %d characters", s.cfg.MaxRoomNameRunes))
	}
	return s.cleanRoomName(ref)
}

// newRoomIDLocked returns an id that is free in this app. Call with s.mu held.
func (s *Server) newRoomIDLocked(app string) string {
	for i := 0; i < 16; i++ {
		size := 4
		if i >= 8 {
			size = 8 // страховка, если короткие id вдруг закончатся
		}
		b := make([]byte, size)
		if _, err := rand.Read(b); err != nil {
			continue
		}
		id := hex.EncodeToString(b)
		if s.rooms[app+":"+id] == nil {
			return id
		}
	}
	return ""
}

// findByIDLocked looks a room up by its id (the registry key). Call with s.mu held.
func (s *Server) findByIDLocked(app, id string) *room.Room {
	return s.rooms[app+":"+id]
}

// findByNameLocked returns the oldest room of the app with this display name.
// Call with s.mu held.
func (s *Server) findByNameLocked(app, name string) *room.Room {
	prefix := app + ":"
	var oldest *room.Room
	for k, r := range s.rooms {
		if !strings.HasPrefix(k, prefix) || r.Name != name {
			continue
		}
		if oldest == nil || r.Created().Before(oldest.Created()) {
			oldest = r
		}
	}
	return oldest
}

// findLocked finds a room by id first, then by display name. Call with s.mu held.
func (s *Server) findLocked(app, ref string) *room.Room {
	if rm := s.findByIDLocked(app, ref); rm != nil {
		return rm
	}
	return s.findByNameLocked(app, ref)
}

// join enters a room: ref is a room id or a display name.
// With create=true a new room is always created, even if the name is already taken;
// with create=false an existing room is joined: first by id, then by name.
func (s *Server) join(app, ref string, create, unique bool, opts room.Options, req room.JoinReq) (*room.Room, *proto.Error) {
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.Lock()
		var rm *room.Room
		made := false
		if create {
			// create=true всегда создаёт НОВУЮ комнату с этим именем:
			// ищем только по id (это путь возврата в ту же комнату по id).
			rm = s.findByIDLocked(app, ref)
			// unique: занятое имя — ошибка, а не дубликат.
			if rm == nil && unique && s.findByNameLocked(app, ref) != nil {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrRoomExists, "room with this name already exists: "+ref)
			}
		} else {
			rm = s.findLocked(app, ref) // по id, затем по имени
		}
		if rm == nil && create {
			if s.draining.Load() {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrServerBusy, "node is draining, no new rooms here")
			}
			if len(s.rooms) >= s.cfg.MaxRooms {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrServerBusy, "server room limit reached")
			}
			id := s.newRoomIDLocked(app)
			if id == "" {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrServerBusy, "cannot allocate a room id")
			}
			nr, err := room.New(app+":"+id, id, ref, opts, s.cfg, s.onRoomClosed)
			if err != nil {
				s.mu.Unlock()
				return nil, err
			}
			made = true
			rm = nr
			s.rooms[nr.Key] = rm
			go rm.Run()
			slog.Info("room created", "room", nr.Key, "name", ref)
		}
		s.mu.Unlock()

		if rm == nil {
			return nil, proto.Err(proto.ErrNoRoom, "room not found: "+ref)
		}
		req.Created = made
		err := rm.Join(req)
		if err == nil {
			return rm, nil
		}
		if err.Code == proto.ErrRoomClosed {
			continue // the room closed under us: try again (maybe create a new one)
		}
		return nil, err
	}
	return nil, proto.Err(proto.ErrRoomClosed, "room is closing, try again")
}

// list returns up to 100 rooms of one app. lobby != "" keeps only the rooms
// of that lobby; "" lists every room.
func (s *Server) list(app, lobby string) []map[string]any {
	prefix := app + ":"
	s.mu.Lock()
	infos := make([]room.Info, 0, len(s.rooms))
	for k, r := range s.rooms {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		in := r.Info()
		if lobby != "" && in.Lobby != lobby {
			continue
		}
		infos = append(infos, in)
	}
	s.mu.Unlock()
	sort.Slice(infos, func(i, j int) bool {
		if infos[i].Name != infos[j].Name {
			return infos[i].Name < infos[j].Name
		}
		return infos[i].ID < infos[j].ID // одинаковые имена — сортируем по id
	})
	if len(infos) > 100 {
		infos = infos[:100]
	}
	out := make([]map[string]any, 0, len(infos))
	for _, in := range infos {
		m := map[string]any{
			"id": in.ID, "room": in.Name, "players": in.Players, "maxPlayers": in.MaxPlayers,
			"locked": in.Locked,
		}
		if in.Lobby != "" {
			m["lobby"] = in.Lobby
		}
		out = append(out, m)
	}
	return out
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already replied with an HTTP error
	}
	app := r.URL.Query().Get("app")
	if app == "" {
		app = "default"
	}
	c := &client{
		srv:  s,
		conn: conn,
		app:  app,
		send: make(chan []byte, s.cfg.SendQueue),
		done: make(chan struct{}),
		tok:  s.cfg.MsgBurst,
		last: time.Now(),
	}
	go c.writePump()

	if r.URL.Query().Get("v") != "1" {
		c.fatal(0, proto.Err(proto.ErrBadVersion, "unsupported protocol version, expected v=1"))
	} else if !validName(app) {
		c.fatal(0, proto.Err(proto.ErrBadMessage, "bad app id"))
	} else if len(s.cfg.ClusterSecret) > 0 &&
		!directory.VerifyTicket(s.cfg.ClusterSecret, r.URL.Query().Get("ticket"), app, time.Now()) {
		// кластерный режим: /ws принимает только клиентов с билетом от directory
		c.fatal(0, proto.Err(proto.ErrBadToken, "missing or invalid cluster ticket — connect through the directory"))
	}
	c.readPump()
}

// ---- clustering -------------------------------------------------------

// SetDrain blocks the creation of new rooms on this node; existing rooms
// keep running until they empty out. Used by the directory (drain) and
// the /cluster/admin endpoint.
func (s *Server) SetDrain(on bool) { s.draining.Store(on) }

// Draining reports whether new rooms are blocked on this node.
func (s *Server) Draining() bool { return s.draining.Load() }

// Report builds the heartbeat snapshot sent to the directory.
func (s *Server) Report(publicURL, region string) directory.NodeReport {
	s.mu.Lock()
	rooms := make([]directory.RoomInfo, 0, len(s.rooms))
	players := 0
	for key, r := range s.rooms {
		in := r.Info()
		players += in.Players
		rooms = append(rooms, directory.RoomInfo{
			App:        strings.TrimSuffix(key, ":"+in.ID),
			ID:         in.ID,
			Name:       in.Name,
			Players:    in.Players,
			MaxPlayers: in.MaxPlayers,
		})
	}
	s.mu.Unlock()
	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].Name != rooms[j].Name {
			return rooms[i].Name < rooms[j].Name
		}
		return rooms[i].ID < rooms[j].ID
	})
	return directory.NodeReport{
		URL:      publicURL,
		Region:   region,
		Draining: s.draining.Load(),
		Rooms:    rooms,
		Players:  players,
	}
}

// kickRoom closes a room by "app:id" or "app:name" (directory admin kick).
func (s *Server) kickRoom(app, ref string) bool {
	s.mu.Lock()
	rm := s.findLocked(app, ref)
	s.mu.Unlock()
	if rm == nil {
		return false
	}
	rm.Close()
	return true
}

// handleClusterAdmin executes drain/kick commands from the directory.
// Protected by the shared cluster key, not by player tokens.
func (s *Server) handleClusterAdmin(w http.ResponseWriter, r *http.Request) {
	if len(s.cfg.ClusterSecret) == 0 {
		http.Error(w, "clustering is not enabled", http.StatusForbidden)
		return
	}
	if !directory.ClusterKeyOK(s.cfg.ClusterSecret, r) {
		http.Error(w, "bad cluster key", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var m struct {
		Op   string `json:"op"`
		Room string `json:"room"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&m); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	switch m.Op {
	case "drain":
		s.SetDrain(true)
		slog.Info("drain enabled by directory: new rooms are rejected")
	case "undrain":
		s.SetDrain(false)
		slog.Info("drain disabled by directory")
	case "kick":
		app, ref, ok := strings.Cut(m.Room, ":")
		if !ok || !s.kickRoom(app, ref) {
			http.Error(w, "room not found", http.StatusNotFound)
			return
		}
		slog.Info("room kicked by directory", "room", m.Room)
	default:
		http.Error(w, "unknown op", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}
