# StarkFlow — English overview

Compact description of what StarkFlow does. Full documentation is in Russian: [../README.md](../README.md),
[docs/DEPLOY.md](DEPLOY.md), [docs/PROTOCOL.md](PROTOCOL.md), [docs/PLUGIN.md](PLUGIN.md).


**EN** — StarkFlow adds multiplayer to Construct 3 games without a backend service: you run one Go binary
on your own machine or VPS, and players connect straight to it over WebSocket.

- **Rooms** have a short id and a display name in **any language** (length limit is configurable, 32 characters by
  default). Duplicate names are allowed — the id is what identifies a room.
- **Shared room state** with atomic `add` and per-key rules (`mode`, `min`/`max`, `maxDelta`, `reject`) —
  the server clamps or rejects, and never trusts the client.
- **Signed player tokens** (HMAC-SHA256, nothing stored on the server): after a connection drop the player returns
  to the same room with the same id and the same state.
- **Relay events** (to all / others / one player), **per-player state** (cursor positions, ready flags, colours),
  host tracking, players kept as *suspended* for 30 s.
- **Test client** built into the server binary: open http://localhost:8080. Two demo modes: boss fight
  (shared HP with `add` rules) and cursor synchronisation (per-player state + events).
- **Construct 3 plugin** `EwenLoy_StarkFlow`: 14 actions, 20 conditions, 30 expressions — install
  `dist/starkflow.c3addon` via C3 → View → Addon Manager. Full ACE list: `plugin/aces.json`.
- **Docker**: `docker compose up -d --build` runs the server in a container; `--profile tunnel` adds a temporary
  public https/wss address, and `docker-compose.tls.yml` gives a permanent `wss://` on your own domain (Caddy with
  automatic Let's Encrypt, or a Cloudflare Tunnel with your token — no open ports needed). The server also honours
  the `PORT` variable that bot-hosting platforms pass, so it works behind such platforms out of the box.

Quick start:

```
cd server
go mod tidy
go test ./...
go run ./cmd/starkflow     # test client at http://localhost:8080
```

Tests: `go test ./...` (room state, tokens), `node tests/plugin-mock-test.js` (every ACE exists in the runtime
with the right arity + plugin behaviour on a WebSocket stub), `node tests/server-smoke.mjs` (54 live protocol
checks against a running server). Minimum: Go 1.22+, Node 22+ for the JS tests.

Protocol summary in English: rooms are created with `room.join {create:true}` (always a new room), joined with
`room.join {room:"<id-or-name>", create:false}`; the server answers with `welcome`, `room.joined`, `state.changed`,
`player.*`, `event`, `err`. Client messages: `hello`, `room.join`, `room.leave`, `room.list`, `event`,
`state.set/add/toggle`, `player.set`, `ping`. Details: `server/internal/proto/proto.go` and the Russian section below.

**MIT licensed** — use it for anything, including commercial games, no strings attached, just keep the copyright
notice (see [LICENSE](LICENSE)). If StarkFlow saves you time, you can
[support development](https://dalink.to/ewenloy) — completely optional and it changes nothing about the license.
