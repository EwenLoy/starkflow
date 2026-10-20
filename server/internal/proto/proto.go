// Package proto describes the StarkFlow wire protocol (JSON over WebSocket).
package proto

import "encoding/json"

// Version of the protocol, sent by the client in the URL (?v=1).
const Version = 1

// Error codes, grouped by hundreds:
// 1xx connection, 2xx auth, 3xx rooms, 4xx state, 5xx limits.
const (
	ErrBadVersion  = 100
	ErrBadMessage  = 101
	ErrNotReady    = 102
	ErrBadToken    = 200
	ErrNoRoom      = 300
	ErrRoomFull    = 301
	ErrRoomClosed  = 302
	ErrAlreadyIn   = 303
	ErrNotInRoom   = 305
	ErrBadRoomName = 306
	ErrBadPassword = 307
	ErrUnknownKey  = 400
	ErrBadType     = 401
	ErrForbidden   = 402
	ErrDeltaTooBig = 403
	ErrOutOfLimits = 404
	ErrRateLimit   = 500
	ErrMsgTooLarge = 501
	ErrServerBusy  = 502
)

// Error is a protocol error that is sent to the client as {"t":"err",...}.
type Error struct {
	Code int
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// Err creates a protocol error.
func Err(code int, msg string) *Error { return &Error{Code: code, Msg: msg} }

// RuleDef is a state key rule as sent by the client when a room is created.
type RuleDef struct {
	Kind     string   `json:"kind"`     // num | str | bool (default num)
	Mode     string   `json:"mode"`     // set | add | const | once | server (default set)
	Min      *float64 `json:"min"`      // numbers only
	Max      *float64 `json:"max"`      // numbers only
	MaxDelta float64  `json:"maxDelta"` // max |delta| for one add; 0 = no limit
	Reject   bool     `json:"reject"`   // reject out-of-range values instead of clamping
	MaxLen   int      `json:"maxLen"`   // strings only, in bytes; 0 = server limit
}

// ClientMsg is every message a client can send. Unused fields stay zero.
type ClientMsg struct {
	T  string `json:"t"`
	ID int64  `json:"id"`

	// hello
	Token string `json:"token"`
	Name  string `json:"name"`

	// room.join
	Room       string             `json:"room"`
	Create     bool               `json:"create"`
	Password   string             `json:"password"` // opens a locked room; also sets it when creating
	MaxPlayers int                `json:"maxPlayers"`
	EmptyTTL   *int               `json:"emptyTTL"`   // seconds; nil = server default
	SuspendTTL *int               `json:"suspendTTL"` // seconds; 0 = drop at once; nil = server default
	Strict     bool               `json:"strict"`
	Schema     map[string]RuleDef `json:"schema"`
	Init       map[string]any     `json:"init"`

	// event
	Code int             `json:"code"`
	Data json.RawMessage `json:"data"`
	To   json.RawMessage `json:"to"` // "all" | "others" | player id

	// state.* / player.set
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`

	// ping; sync: the sender's clock in ms
	Ts int64 `json:"ts"`

	// sync: one numbered snapshot of the sender's synced objects
	Seq  int64           `json:"seq"`
	Iv   int             `json:"iv"`   // the sender's send interval, ms
	Objs json.RawMessage `json:"objs"` // array of object records

	// batch: several client messages in one WebSocket frame
	Items []json.RawMessage `json:"items"`

	// rtc.offer: the client's SDP offer; rtc.ice: one ICE candidate (RTCIceCandidateInit)
	Sdp       string          `json:"sdp"`
	Candidate json.RawMessage `json:"candidate"`
}

// Marshal encodes a server message.
func Marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"t":"err","code":101,"msg":"server encode error"}`)
	}
	return b
}

// ErrFrame builds an error message. id is the request id (0 = none).
func ErrFrame(id int64, e *Error) []byte {
	m := map[string]any{"t": "err", "code": e.Code, "msg": e.Msg}
	if id != 0 {
		m["id"] = id
	}
	return Marshal(m)
}

// OkFrame builds a success reply for a request id.
func OkFrame(id int64) []byte {
	return Marshal(map[string]any{"t": "ok", "id": id})
}
