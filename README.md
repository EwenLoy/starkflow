# StarkFlow

Multiplayer for Construct 3 games on your own server: rooms, events, shared room state. One Go binary, no external
services, no sign-ups, no subscriptions.

**English** · [Русский](README.ru.md)

[![CI](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/donate-dalink.to%2Fewenloy-ff69b4.svg)](https://dalink.to/ewenloy)

## What it is

- **Rooms** — a short id plus a display name in any language (32 characters by default), duplicate names are allowed.
- **Shared room state** with per-key rules: `add` is atomic, `min`/`max`/`maxDelta` are clamped by the server.
- **Relay events** — to all players, to others, or to a single player.
- **Per-player state** — cursors, ready flags, colours: only the player itself can write, nobody can spoof it.
- **Player tokens** (signed, nothing stored on the server): after a dropped connection the player returns to the same
  room with the same identity and state.
- **Batteries included** — a test client built into the server and a Construct 3 plugin in this repository.

Wire protocol: `ws(s)://host/ws?v=1&app=APP_ID`, JSON frames.

## Quick start

Go 1.22+ and nothing to configure:

```bash
cd server
go run ./cmd/starkflow
```

Open http://localhost:8080 — that is the built-in test client with two demo modes: boss fight (shared HP) and cursor
synchronisation. To play with a friend, open the same page in a second browser or in a private window.

## Quick test with a friend (Docker)

```bash
git clone https://github.com/EwenLoy/starkflow.git
cd starkflow
docker compose up -d --build
```

That is all: the server listens on `0.0.0.0:8080` by itself, comes back up after a reboot and the container has a
healthcheck (`docker compose ps` shows `healthy`). You only need to open port 8080 in your provider's firewall. Your
friend opens `http://<server-ip>:8080` and plays.

No public IP, or you do not want to open ports? The same compose file gives you a temporary https address:

```bash
docker compose --profile tunnel up -d
docker compose logs tunnel | grep trycloudflare    # prints an address like https://xxxx.trycloudflare.com
```

## Your own domain and https

One command: Caddy obtains and renews the Let's Encrypt certificate and proxies WebSocket on its own, there is nothing
to configure by hand.

```bash
cp .env.example .env     # set STARKFLOW_SECRET and SF_DOMAIN, for example game.example.com
docker compose -f docker-compose.tls.yml --profile caddy up -d --build
```

Then point an A record of your domain at the server. The plugin talks to `wss://game.example.com/ws`.

If ports 80/443 are not available (or the domain lives on Cloudflare), the second profile in the same file runs a
Cloudflare Tunnel with your token and creates the DNS record for you. Both options are documented at the top of
`docker-compose.tls.yml`.

## Requirements

| What | For |
|---|---|
| Go 1.22+ | running the server without Docker |
| Docker + Compose | deploying to a server (recommended) |
| Node 22+ | the tests in `tests/` only |
| Construct 3 | the `dist/starkflow.c3addon` addon (not yet verified inside C3 itself) |

## Tests

```bash
cd server && go test ./...       # room state and tokens
node tests/plugin-mock-test.js   # plugin: 64 ACE and behaviour on a WebSocket stub
node tests/server-smoke.mjs      # 54 protocol checks against a running server
```

All of it runs in CI on every push: 4 jobs (server, plugin, live smoke test, Docker image build).

## Technical details

| File / folder | What is inside |
|---|---|
| `server/` | the Go server: rooms, state, tokens, the built-in test page (`internal/server/web/`) |
| `plugin/` | Construct 3 addon sources: `addon.json`, `c3runtime/`, ACE, language files |
| `dist/starkflow.c3addon` | the built addon: C3 → View → Addon Manager → Install new addon |
| `Dockerfile`, `docker-compose.yml` | the container and server deployment (includes a tunnel profile) |
| `docker-compose.tls.yml`, `Caddyfile` | https on your own domain: Caddy or a Cloudflare Tunnel |
| `tests/` | Go unit tests, ACE reference check, live protocol smoke test |
| `docs/` | the detailed documentation (currently in Russian) |

Documentation (Russian):

- [docs/DEPLOY.md](docs/DEPLOY.md) — deployment: VPS, own domain and https, tunnels, bot hosting, environment variables
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — protocol: messages, rooms, state key rules, the two storages
- [docs/PLUGIN.md](docs/PLUGIN.md) — installing the plugin and a first example in C3
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — local run, test client, tests, CI, what is verified and what is not

## License and support

MIT: do anything you want, commercial games included; the only condition is keeping the [LICENSE](LICENSE) text and
the copyright notice. If the project saved you time, you can [support development](https://dalink.to/ewenloy) — it is
voluntary and changes nothing about the license or how fast issues are answered.
