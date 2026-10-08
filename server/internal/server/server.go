// Package server wires WebSocket connections to rooms.
package server

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"starkflow/internal/config"
	"starkflow/internal/proto"
	"starkflow/internal/room"
)

//go:embed web/index.html
var webFS embed.FS

// Server owns the room registry and the HTTP endpoints.
type Server struct {
	cfg      config.Config
	upgrader websocket.Upgrader

	mu    sync.Mutex
	rooms map[string]*room.Room
}

// New creates a server.
func New(cfg config.Config) *Server {
	s := &Server{cfg: cfg, rooms: map[string]*room.Room{}}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     s.checkOrigin,
	}
	return s
}

// Handler returns the HTTP handler: /ws, /health and the built-in test page.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
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
func (s *Server) join(app, ref string, create bool, opts room.Options, req room.JoinReq) (*room.Room, *proto.Error) {
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.Lock()
		var rm *room.Room
		if create {
			// create=true всегда создаёт НОВУЮ комнату с этим именем:
			// ищем только по id (это путь возврата в ту же комнату по id).
			rm = s.findByIDLocked(app, ref)
		} else {
			rm = s.findLocked(app, ref) // по id, затем по имени
		}
		if rm == nil && create {
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
			rm = nr
			s.rooms[nr.Key] = rm
			go rm.Run()
			slog.Info("room created", "room", nr.Key, "name", ref)
		}
		s.mu.Unlock()

		if rm == nil {
			return nil, proto.Err(proto.ErrNoRoom, "room not found: "+ref)
		}
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

// list returns up to 100 rooms of one app.
func (s *Server) list(app string) []map[string]any {
	prefix := app + ":"
	s.mu.Lock()
	infos := make([]room.Info, 0, len(s.rooms))
	for k, r := range s.rooms {
		if strings.HasPrefix(k, prefix) {
			infos = append(infos, r.Info())
		}
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
		out = append(out, map[string]any{
			"id": in.ID, "room": in.Name, "players": in.Players, "maxPlayers": in.MaxPlayers,
		})
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
	}
	c.readPump()
}
