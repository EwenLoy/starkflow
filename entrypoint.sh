#!/bin/sh
set -eu

# Own domain with https and wss through a Cloudflare Tunnel.
# Cloudflare Zero Trust -> Networks -> Tunnels -> create a tunnel, add a public
# hostname (game.example.com -> http://localhost:$PORT) and put the token into the
# CF_TUNNEL_TOKEN environment variable of the bot. Without the token nothing starts.
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
	echo "starkflow-entrypoint: starting cloudflared tunnel" >&2
	cloudflared --no-autoupdate tunnel run --token "$CF_TUNNEL_TOKEN" &
fi

exec /usr/local/bin/starkflow
