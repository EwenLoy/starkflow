// Package directory is the cluster manager of StarkFlow. Game nodes send
// heartbeats here, the directory remembers which room lives on which node,
// hands out node addresses via POST /assign (with a signed ticket) and serves
// a small admin panel. All state lives in memory and is rebuilt from node
// reports after a restart — no database is required.
package directory

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"embed"
)

//go:embed web
var webFS embed.FS

const (
	// NodeTimeout: a node silent for longer than this is shown as offline.
	NodeTimeout = 15 * time.Second
	pingEvery   = 3 * time.Second
	ticketTTL   = 60 * time.Second
	httpTimeout = 3 * time.Second
)

// RoomInfo is one room as reported by a node.
type RoomInfo struct {
	App        string `json:"app"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	Players    int    `json:"players"`
	MaxPlayers int    `json:"maxPlayers"`
}

// NodeReport is the heartbeat payload a node sends to the directory.
type NodeReport struct {
	URL      string     `json:"url"` // node's public ws URL, e.g. wss://node/ws
	Region   string     `json:"region"`
	Draining bool       `json:"draining"`
	Rooms    []RoomInfo `json:"rooms"`
	Players  int        `json:"players"`
}

// AssignRequest asks the directory for a node to connect to.
type AssignRequest struct {
	App    string `json:"app"`
	Room   string `json:"room"`   // room id or name: prefer the node that hosts it
	Region string `json:"region"` // optional: pin the choice to a region
}

// AssignResponse is what the plugin needs to reach its node.
type AssignResponse struct {
	URL    string `json:"url"`    // e.g. wss://node.example.com/ws
	Ticket string `json:"ticket"` // HMAC-signed, checked by the node on /ws
}

func mac(secret []byte, s string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(s))
	return h.Sum(nil)
}

// SignTicket issues a ticket letting one client connect to any room of app.
// Format mirrors internal/auth: base64url(payload) "." base64url(HMAC-SHA256).
func SignTicket(secret []byte, app string, now time.Time) string {
	payload := "assign|" + app + "|" + strconv.FormatInt(now.Add(ticketTTL).Unix(), 10)
	p := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return p + "." + base64.RawURLEncoding.EncodeToString(mac(secret, p))
}

// VerifyTicket checks the signature, expiry and app of a connect ticket.
func VerifyTicket(secret []byte, ticket, app string, now time.Time) bool {
	parts := strings.Split(ticket, ".")
	if len(parts) != 2 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac(secret, parts[0])) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	f := strings.Split(string(raw), "|")
	if len(f) != 3 || f[0] != "assign" || f[1] != app {
		return false
	}
	exp, err := strconv.ParseInt(f[2], 10, 64)
	if err != nil {
		return false
	}
	t := time.Unix(exp, 0)
	// expired, or issued implausibly far in the future
	return !now.After(t) && !t.After(now.Add(ticketTTL+time.Minute))
}

// ClusterKeyOK reports whether r carries the shared cluster key.
func ClusterKeyOK(secret []byte, r *http.Request) bool {
	if len(secret) == 0 {
		return false
	}
	got := r.Header.Get("X-Cluster-Key")
	return subtle.ConstantTimeCompare([]byte(got), secret) == 1
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

// ---- registry -------------------------------------------------------

type roomLoc struct {
	node string
	info RoomInfo
}

type nodeState struct {
	report         NodeReport
	lastSeen       time.Time
	drainRequested bool // set from the admin panel
	ping           time.Duration
	pingOK         bool
}

func (n *nodeState) alive(now time.Time) bool {
	return now.Sub(n.lastSeen) < NodeTimeout
}

// blocked nodes are skipped by /assign.
func (n *nodeState) blocked() bool {
	return n.drainRequested || n.report.Draining
}

// Dir is the directory service.
type Dir struct {
	secret     []byte // shared cluster key: signs tickets, authenticates nodes
	adminToken string // bearer token for /api/*

	mu     sync.Mutex
	nodes  map[string]*nodeState
	byID   map[string]roomLoc // "app:roomID" -> node (authoritative)
	byName map[string]roomLoc // "app:roomName" -> node (best effort, first seen)
}

// New creates a directory. secret must equal every node's STARKFLOW_CLUSTER_SECRET.
func New(secret []byte, adminToken string) *Dir {
	return &Dir{
		secret:     secret,
		adminToken: adminToken,
		nodes:      map[string]*nodeState{},
		byID:       map[string]roomLoc{},
		byName:     map[string]roomLoc{},
	}
}

// reindexLocked drops all index entries of one node and re-adds its rooms.
func (d *Dir) reindexLocked(url string, rooms []RoomInfo) {
	for k, loc := range d.byID {
		if loc.node == url {
			delete(d.byID, k)
		}
	}
	for k, loc := range d.byName {
		if loc.node == url {
			delete(d.byName, k)
		}
	}
	for _, rm := range rooms {
		if rm.App == "" || rm.ID == "" {
			continue
		}
		d.byID[rm.App+":"+rm.ID] = roomLoc{node: url, info: rm}
		if rm.Name != "" {
			k := rm.App + ":" + rm.Name
			if _, taken := d.byName[k]; !taken {
				d.byName[k] = roomLoc{node: url, info: rm}
			}
		}
	}
}

// pickLocked returns the least loaded live node, optionally pinned to a region.
func (d *Dir) pickLocked(region string, now time.Time) string {
	var best string
	var bestPlayers, bestRooms int
	for url, ns := range d.nodes {
		if !ns.alive(now) || ns.blocked() {
			continue
		}
		if region != "" && ns.report.Region != region {
			continue
		}
		p, rc := ns.report.Players, len(ns.report.Rooms)
		if best == "" || p < bestPlayers || (p == bestPlayers && rc < bestRooms) {
			best, bestPlayers, bestRooms = url, p, rc
		}
	}
	return best
}

// ---- HTTP -----------------------------------------------------------

// Start launches background loops (node pinging). Call before serving.
func (d *Dir) Start(ctx context.Context) {
	go d.pingLoop(ctx)
}

// Handler returns the directory HTTP handler.
func (d *Dir) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/assign", d.handleAssign)
	mux.HandleFunc("/report", d.handleReport)
	mux.HandleFunc("/api/nodes", d.handleAPINodes)
	mux.HandleFunc("/api/nodes/drain", d.handleDrain)
	mux.HandleFunc("/api/nodes/kick", d.handleKick)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	// The panel itself is a static page (no secrets in it); the token is
	// asked in the UI and sent only to /api/*.
	if sub, err := fs.Sub(webFS, "web"); err == nil {
		mux.Handle("/admin/", http.StripPrefix("/admin/", http.FileServer(http.FS(sub))))
		mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/admin/", http.StatusFound)
		})
	}
	return mux
}

func (d *Dir) handleAssign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req AssignRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	req.App = strings.TrimSpace(req.App)
	req.Room = strings.TrimSpace(req.Room)
	req.Region = strings.TrimSpace(req.Region)
	if !validName(req.App) {
		http.Error(w, "bad app id", http.StatusBadRequest)
		return
	}
	if req.Room != "" && utf8.RuneCountInString(req.Room) > 64 {
		http.Error(w, "bad room ref", http.StatusBadRequest)
		return
	}

	now := time.Now()
	d.mu.Lock()
	// 1) an existing room always wins: its players must land on its node
	if req.Room != "" {
		for _, idx := range []map[string]roomLoc{d.byID, d.byName} {
			if loc, ok := idx[req.App+":"+req.Room]; ok {
				if ns := d.nodes[loc.node]; ns != nil && ns.alive(now) && !ns.blocked() {
					d.mu.Unlock()
					d.writeAssign(w, loc.node, req.App)
					return
				}
			}
		}
	}
	// 2) otherwise the least loaded live node of the region
	node := d.pickLocked(req.Region, now)
	d.mu.Unlock()

	if node == "" {
		http.Error(w, "no node available", http.StatusServiceUnavailable)
		return
	}
	d.writeAssign(w, node, req.App)
}

func (d *Dir) writeAssign(w http.ResponseWriter, nodeURL, app string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(AssignResponse{
		URL:    nodeURL,
		Ticket: SignTicket(d.secret, app, time.Now()),
	})
}

func (d *Dir) handleReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !ClusterKeyOK(d.secret, r) {
		http.Error(w, "bad cluster key", http.StatusForbidden)
		return
	}
	var rep NodeReport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&rep); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	rep.URL = strings.TrimSpace(rep.URL)
	if rep.URL == "" {
		http.Error(w, "missing url", http.StatusBadRequest)
		return
	}
	if rep.Region == "" {
		rep.Region = "default"
	}
	if len(rep.Rooms) > 10000 {
		rep.Rooms = rep.Rooms[:10000]
	}

	d.mu.Lock()
	ns := d.nodes[rep.URL]
	if ns == nil {
		ns = &nodeState{}
		d.nodes[rep.URL] = ns
		slog.Info("node registered", "url", rep.URL, "region", rep.Region)
	}
	d.reindexLocked(rep.URL, rep.Rooms)
	ns.report = rep
	ns.lastSeen = time.Now()
	d.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// ---- admin API ------------------------------------------------------

func (d *Dir) adminOK(w http.ResponseWriter, r *http.Request) bool {
	if d.adminToken == "" {
		http.Error(w, "STARKFLOW_ADMIN_TOKEN is not set on the directory", http.StatusServiceUnavailable)
		return false
	}
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) ||
		subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(h, prefix)), []byte(d.adminToken)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="starkflow-admin"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

type nodeJSON struct {
	URL            string     `json:"url"`
	Region         string     `json:"region"`
	Online         bool       `json:"online"`
	Draining       bool       `json:"draining"`       // node-side flag (from heartbeat)
	DrainRequested bool       `json:"drainRequested"` // panel-side flag
	Rooms          int        `json:"rooms"`
	Players        int        `json:"players"`
	PingMs         int64      `json:"pingMs"` // -1 = unknown
	PingOK         bool       `json:"pingOk"`
	LastSeenSec    float64    `json:"lastSeenSec"`
	RoomList       []RoomInfo `json:"roomList"`
}

func (d *Dir) snapshot() map[string]any {
	now := time.Now()
	d.mu.Lock()
	nodes := make([]nodeJSON, 0, len(d.nodes))
	for url, ns := range d.nodes {
		pingMs := ns.ping.Milliseconds()
		if !ns.pingOK {
			pingMs = -1
		}
		nodes = append(nodes, nodeJSON{
			URL:            url,
			Region:         ns.report.Region,
			Online:         ns.alive(now),
			Draining:       ns.report.Draining,
			DrainRequested: ns.drainRequested,
			Rooms:          len(ns.report.Rooms),
			Players:        ns.report.Players,
			PingMs:         pingMs,
			PingOK:         ns.pingOK,
			LastSeenSec:    now.Sub(ns.lastSeen).Seconds(),
			RoomList:       ns.report.Rooms,
		})
	}
	d.mu.Unlock()
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].URL < nodes[j].URL })
	return map[string]any{"nodes": nodes, "serverTime": now.Unix()}
}

func (d *Dir) handleAPINodes(w http.ResponseWriter, r *http.Request) {
	if !d.adminOK(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(d.snapshot())
}

func (d *Dir) handleDrain(w http.ResponseWriter, r *http.Request) {
	if !d.adminOK(w, r) {
		return
	}
	var req struct {
		URL   string `json:"url"`
		Drain bool   `json:"drain"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	d.mu.Lock()
	ns := d.nodes[req.URL]
	if ns == nil {
		d.mu.Unlock()
		http.Error(w, "unknown node", http.StatusNotFound)
		return
	}
	ns.drainRequested = req.Drain
	d.mu.Unlock()

	op := "undrain"
	if req.Drain {
		op = "drain"
	}
	if err := d.tellNode(req.URL, map[string]any{"op": op}); err != nil {
		// the flag is set anyway: /assign already skips this node
		slog.Warn("node did not accept the drain command", "url", req.URL, "err", err)
	}
	slog.Info("node drain flag changed", "url", req.URL, "drain", req.Drain)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (d *Dir) handleKick(w http.ResponseWriter, r *http.Request) {
	if !d.adminOK(w, r) {
		return
	}
	var req struct {
		URL  string `json:"url"`
		Room string `json:"room"` // "app:id" or "app:name"
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.URL == "" || req.Room == "" {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if err := d.tellNode(req.URL, map[string]any{"op": "kick", "room": req.Room}); err != nil {
		http.Error(w, "kick failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	slog.Info("room kicked", "url", req.URL, "room", req.Room)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// ---- node probing ----------------------------------------------------

// httpBase converts a node public URL (wss://host/ws) into its http base
// (https://host); the trailing /ws path, if present, is stripped.
func httpBase(nodeURL string) string {
	u := strings.TrimSuffix(nodeURL, "/")
	u = strings.TrimSuffix(u, "/ws")
	if strings.HasPrefix(u, "wss://") {
		return "https://" + strings.TrimPrefix(u, "wss://")
	}
	if strings.HasPrefix(u, "ws://") {
		return "http://" + strings.TrimPrefix(u, "ws://")
	}
	return u
}

// tellNode sends a cluster admin command (drain/undrain/kick) to one node.
func (d *Dir) tellNode(nodeURL string, payload map[string]any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, httpBase(nodeURL)+"/cluster/admin", strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Cluster-Key", string(d.secret))
	resp, err := (&http.Client{Timeout: httpTimeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("node returned %s", resp.Status)
	}
	return nil
}

// pingLoop actively measures the round trip to every live node — a real RTT
// like in classic server browsers, not just "heartbeats still arrive".
func (d *Dir) pingLoop(ctx context.Context) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.pingAll()
		}
	}
}

func (d *Dir) pingAll() {
	now := time.Now()
	d.mu.Lock()
	urls := make([]string, 0, len(d.nodes))
	for url, ns := range d.nodes {
		if ns.alive(now) {
			urls = append(urls, url)
		}
	}
	d.mu.Unlock()
	for _, u := range urls {
		go d.pingOne(u)
	}
}

func (d *Dir) pingOne(nodeURL string) {
	start := time.Now()
	resp, err := (&http.Client{Timeout: httpTimeout}).Get(httpBase(nodeURL) + "/health")
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	d.mu.Lock()
	if ns := d.nodes[nodeURL]; ns != nil {
		ns.ping = time.Since(start)
		ns.pingOK = err == nil && resp != nil && resp.StatusCode == http.StatusOK
	}
	d.mu.Unlock()
}
