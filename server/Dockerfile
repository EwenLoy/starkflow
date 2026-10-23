# Build context is this folder (server/), for hosting panels that take the Go
# app directory as the project root instead of the repository root.
# The repository-root Dockerfile stays the full variant: it also ships
# cloudflared for CF_TUNNEL_TOKEN and copies entrypoint.sh.
#
# Do not use "go build ." here: main lives in ./cmd/starkflow.

# ---- build ------------------------------------------------------------------
# 1.24: pion/webrtc (the WebRTC sync channel) pulls golang.org/x/net, which wants Go 1.24
FROM golang:1.24-alpine AS build
WORKDIR /src

# manifests only at first: the dependency layer stays cached
COPY go.mod go.sum ./
RUN go mod download

COPY . ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/starkflow ./cmd/starkflow

# ---- run --------------------------------------------------------------------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
RUN adduser -D -H -u 10001 starkflow
# keep the binary outside /app: hosting panels bind-mount /app with the git sources
COPY --from=build /out/starkflow /usr/local/bin/starkflow
USER 10001
EXPOSE 8080
# Port comes from PORT when the platform passes it, otherwise 8080.
# The test page is embedded into the binary, /health answers "ok".
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O- "http://127.0.0.1:${PORT:-8080}/health" || exit 1
ENTRYPOINT ["/usr/local/bin/starkflow"]
