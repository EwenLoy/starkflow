// Package server wires WebSocket connections to rooms.
package server

import (
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

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

// join finds or creates the room and enters it.
func (s *Server) join(app, name string, create bool, opts room.Options, req room.JoinReq) (*room.Room, *proto.Error) {
	key := app + ":" + name
	for attempt := 0; attempt < 3; attempt++ {
		s.mu.Lock()
		rm := s.rooms[key]
		if rm == nil {
			if !create {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrNoRoom, "room not found: "+name)
			}
			if len(s.rooms) >= s.cfg.MaxRooms {
				s.mu.Unlock()
				return nil, proto.Err(proto.ErrServerBusy, "server room limit reached")
			}
			nr, err := room.New(key, name, opts, s.cfg, s.onRoomClosed)
			if err != nil {
				s.mu.Unlock()
				return nil, err
			}
			rm = nr
			s.rooms[key] = rm
			go rm.Run()
			slog.Info("room created", "room", key)
		}
		s.mu.Unlock()

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
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name < infos[j].Name })
	if len(infos) > 100 {
		infos = infos[:100]
	}
	out := make([]map[string]any, 0, len(infos))
	for _, in := range infos {
		out = append(out, map[string]any{"room": in.Name, "players": in.Players, "maxPlayers": in.MaxPlayers})
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
