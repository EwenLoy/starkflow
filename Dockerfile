# ---- build ------------------------------------------------------------------
FROM golang:1.22-alpine AS build
WORKDIR /src

# manifests only at first: the dependency layer stays cached
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/starkflow ./cmd/starkflow

# ---- cloudflared (binary only; started when CF_TUNNEL_TOKEN is set) ----------
FROM cloudflare/cloudflared:latest AS tunnel

# ---- run --------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
RUN adduser -D -H -u 10001 starkflow
# keep the binary outside /app: hosting platforms bind-mount /app with the git sources
COPY --from=build /out/starkflow /usr/local/bin/starkflow
COPY --from=tunnel /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY entrypoint.sh /usr/local/bin/starkflow-entrypoint.sh
RUN chmod 0755 /usr/local/bin/starkflow-entrypoint.sh
USER 10001
EXPOSE 8080
# the test page is embedded into the binary, /health answers "ok".
# Port comes from PORT when the platform passes it (Bothost and alike), otherwise 8080.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O- "http://127.0.0.1:${PORT:-8080}/health" || exit 1
ENTRYPOINT ["/usr/local/bin/starkflow-entrypoint.sh"]
