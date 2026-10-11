// Package rtc is the optional WebRTC side channel for "sync" snapshots: one
// unreliable, unordered DataChannel per client, all clients on ONE UDP port.
// Signaling (offer/answer/candidates) goes over the client's WebSocket; this
// package only answers. Everything else stays on the WebSocket.
package rtc

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// MaxMessage is the largest DataChannel message either side may send. It is
// announced in the answer (a=max-message-size), the plugin sizes from it.
const MaxMessage = 64 * 1024

// maxBuffered: more than this waiting in the channel = congested, the room
// falls back to the WebSocket for that snapshot.
const maxBuffered = 64 * 1024

// openTimeout: a channel that is not open by then is dropped (the plugin itself
// gives up after 3 s, this only frees the server side).
const openTimeout = 15 * time.Second

// Engine owns the shared UDP port. One per server.
type Engine struct {
	api  *webrtc.API
	mux  ice.UDPMux
	conn net.PacketConn
}

// New listens on udpPort (all interfaces). publicIPs, if set, replace the
// addresses in the host candidates (a server behind 1:1 NAT or in Docker).
func New(udpPort int, publicIPs []string) (*Engine, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: udpPort})
	if err != nil {
		return nil, fmt.Errorf("rtc: listen udp %d: %w", udpPort, err)
	}
	mux := webrtc.NewICEUDPMux(nil, conn)
	var se webrtc.SettingEngine
	se.SetICEUDPMux(mux)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetSCTPMaxMessageSize(MaxMessage)
	if len(publicIPs) > 0 {
		se.SetNAT1To1IPs(publicIPs, webrtc.ICECandidateTypeHost)
	}
	return &Engine{
		api:  webrtc.NewAPI(webrtc.WithSettingEngine(se)),
		mux:  mux,
		conn: conn,
	}, nil
}

// Close stops the UDP port. Open peers fail on their own afterwards.
func (e *Engine) Close() {
	_ = e.mux.Close()
	_ = e.conn.Close()
}

// Handlers are called from pion goroutines; they must not block for long.
type Handlers struct {
	// Candidate is a local ICE candidate for the client (trickle).
	Candidate func(webrtc.ICECandidateInit)
	// Message is one text message from the client's "sync" channel.
	Message func([]byte)
	// Closed: the peer is gone (closed, failed, or never opened in time).
	// Not called when the server closed it itself with Close.
	Closed func()
}

// Peer is the server side of one client's channel.
type Peer struct {
	pc     *webrtc.PeerConnection
	dc     atomic.Pointer[webrtc.DataChannel] // set while the channel is open
	h      Handlers
	once   sync.Once
	byUs   atomic.Bool
	opened atomic.Bool
	timer  *time.Timer
}

// Answer takes the client's offer and returns the answer to send back.
func (e *Engine) Answer(offerSDP string, h Handlers) (*Peer, string, error) {
	pc, err := e.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, "", err
	}
	p := &Peer{pc: pc, h: h}
	p.timer = time.AfterFunc(openTimeout, func() {
		if !p.opened.Load() {
			slog.Debug("rtc: channel did not open in time")
			p.close()
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil && h.Candidate != nil {
			h.Candidate(c.ToJSON())
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			p.close()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		// Only the one channel the plugin makes: "sync", unordered, no retransmits.
		if dc.Label() != "sync" || dc.Ordered() || p.opened.Load() {
			_ = dc.Close()
			return
		}
		dc.OnOpen(func() {
			p.opened.Store(true)
			p.dc.Store(dc)
		})
		dc.OnClose(func() { p.close() })
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			if m.IsString && len(m.Data) <= MaxMessage && h.Message != nil {
				h.Message(m.Data)
			}
		})
	})
	fail := func(err error) (*Peer, string, error) {
		p.Close()
		return nil, "", err
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return fail(err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(err)
	}
	ld := pc.LocalDescription()
	if ld == nil {
		return fail(errors.New("rtc: no local description"))
	}
	return p, ld.SDP, nil
}

// AddCandidate adds a remote ICE candidate from the client.
func (p *Peer) AddCandidate(c webrtc.ICECandidateInit) error {
	return p.pc.AddICECandidate(c)
}

// Send sends one text message if the channel is open and not congested.
// false = the caller sends it over the WebSocket instead.
func (p *Peer) Send(b []byte) bool {
	dc := p.dc.Load()
	if dc == nil || len(b) > MaxMessage || dc.BufferedAmount() > maxBuffered {
		return false
	}
	return dc.SendText(string(b)) == nil
}

// Close shuts the peer down without calling Handlers.Closed.
func (p *Peer) Close() {
	p.byUs.Store(true)
	p.close()
}

func (p *Peer) close() {
	p.once.Do(func() {
		p.dc.Store(nil)
		if p.timer != nil {
			p.timer.Stop()
		}
		// pion may call back into us while closing: never close under a lock.
		go func() { _ = p.pc.Close() }()
		if !p.byUs.Load() && p.h.Closed != nil {
			p.h.Closed()
		}
	})
}
