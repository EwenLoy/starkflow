package directory

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// report posts one node heartbeat through the real handler.
func report(t *testing.T, h http.Handler, key string, rep NodeReport) {
	t.Helper()
	raw, err := json.Marshal(rep)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/report", bytes.NewReader(raw))
	req.Header.Set("X-Cluster-Key", key)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("report %s: HTTP %d %s", rep.URL, w.Code, w.Body.String())
	}
}

func postAssign(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/assign", strings.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func assign(t *testing.T, h http.Handler, body string) AssignResponse {
	t.Helper()
	w := postAssign(t, h, body)
	if w.Code != http.StatusOK {
		t.Fatalf("assign %s: HTTP %d %s", body, w.Code, w.Body.String())
	}
	var out AssignResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("assign decode: %v", err)
	}
	return out
}

// TestAssignRegionAndRoomAffinity: a region pins the choice of a NEW room, but an
// existing room always wins — everyone has to land on the node that hosts it.
func TestAssignRegionAndRoomAffinity(t *testing.T) {
	const key = "cluster-key"
	d := New([]byte(key), "adm", nil)
	h := d.Handler()

	// "ru" already has players, "eu" is idle.
	report(t, h, key, NodeReport{URL: "wss://busy.example.com/ws", Region: "ru", Players: 5,
		Rooms: []RoomInfo{{App: "game", ID: "abc", Name: "boss", Players: 5, MaxPlayers: 8}}})
	report(t, h, key, NodeReport{URL: "wss://free.example.com/ws", Region: "eu"})

	// nothing asked for: the least loaded node wins, whatever its region
	if got := assign(t, h, `{"app":"game"}`); got.URL != "wss://free.example.com/ws" {
		t.Fatalf("least loaded node expected, got %q", got.URL)
	}

	// an explicit region beats the load
	got := assign(t, h, `{"app":"game","region":"ru"}`)
	if got.URL != "wss://busy.example.com/ws" {
		t.Fatalf("a pinned region must be honoured, got %q", got.URL)
	}
	if got.Region != "ru" {
		t.Fatalf("the answer must name the region of the node, got %q", got.Region)
	}
	if !VerifyTicket([]byte(key), got.Ticket, "game", time.Now()) {
		t.Fatal("the ticket must be signed by the cluster key and still valid")
	}
	if VerifyTicket([]byte(key), got.Ticket, "another-app", time.Now()) {
		t.Fatal("a ticket must not work for another app id")
	}

	// an existing room wins, no matter which region was asked for
	if byID := assign(t, h, `{"app":"game","room":"abc","region":"eu"}`); byID.URL != "wss://busy.example.com/ws" {
		t.Fatalf("join by id must go to the node of the room, got %q", byID.URL)
	}
	if byName := assign(t, h, `{"app":"game","room":"boss","region":"eu"}`); byName.URL != "wss://busy.example.com/ws" {
		t.Fatalf("join by name must go to the node of the room, got %q", byName.URL)
	}

	// a region nobody runs is not silently swapped for another one: the client has
	// to notice and pick again
	if w := postAssign(t, h, `{"app":"game","region":"us"}`); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("an empty region must answer 503, got %d", w.Code)
	}
}

// TestRegionsListsOneNodePerRegion: the client measures the latency to each of
// these and connects to the nearest one.
func TestRegionsListsOneNodePerRegion(t *testing.T) {
	const key = "k"
	d := New([]byte(key), "", nil)
	h := d.Handler()
	report(t, h, key, NodeReport{URL: "wss://eu2.example.com/ws", Region: "eu", Players: 3})
	report(t, h, key, NodeReport{URL: "wss://eu1.example.com/ws", Region: "eu"})
	report(t, h, key, NodeReport{URL: "wss://ru1.example.com/ws", Region: "ru"})
	// a node that never named its region is not a region of its own
	report(t, h, key, NodeReport{URL: "wss://plain.example.com/ws"})

	req := httptest.NewRequest(http.MethodGet, "/regions", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("regions: HTTP %d", w.Code)
	}
	var out struct {
		Regions []struct {
			Region string `json:"region"`
			URL    string `json:"url"`
		} `json:"regions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("regions decode: %v", err)
	}
	if len(out.Regions) != 3 {
		t.Fatalf("one entry per region (plus \"default\") expected, got %+v", out.Regions)
	}
	if out.Regions[0].Region != "default" || out.Regions[1].Region != "eu" || out.Regions[2].Region != "ru" {
		t.Fatalf("regions must be listed in a stable order, got %+v", out.Regions)
	}
	if out.Regions[1].URL != "wss://eu1.example.com/ws" {
		t.Fatalf("the least loaded node of the region is expected, got %q", out.Regions[1].URL)
	}
}

// TestCORSPreflightForTheGamePage: a JSON POST from the game page is cross-origin,
// so the browser sends a preflight first. Without these headers it never sends the
// real request at all.
func TestCORSPreflightForTheGamePage(t *testing.T) {
	d := New([]byte("s"), "", nil) // no allow-list: any origin, like the node's own check
	h := d.Handler()
	req := httptest.NewRequest(http.MethodOptions, "/assign", nil)
	req.Header.Set("Origin", "https://preview.construct.net")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("a preflight must be answered with 204, got %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Headers"), "Content-Type") {
		t.Fatalf("content-type must be allowed: %q", w.Header().Get("Access-Control-Allow-Headers"))
	}
	if !strings.Contains(w.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("POST must be allowed: %q", w.Header().Get("Access-Control-Allow-Methods"))
	}

	// the real answer carries the headers too, otherwise the browser drops it
	req = httptest.NewRequest(http.MethodGet, "/regions", nil)
	req.Header.Set("Origin", "https://preview.construct.net")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("/regions must be readable from the game page: %q", w.Header().Get("Access-Control-Allow-Origin"))
	}

	// a configured allow-list is what it says, and the admin API stays closed
	d2 := New([]byte("s"), "adm", []string{"https://game.example.com"})
	h2 := d2.Handler()
	req = httptest.NewRequest(http.MethodOptions, "/assign", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	w = httptest.NewRecorder()
	h2.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("a foreign origin must not be allowed, got %q", got)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/nodes", nil)
	req.Header.Set("Origin", "https://game.example.com")
	w = httptest.NewRecorder()
	h2.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("the admin API must not be CORS-enabled, got %q", got)
	}
}
