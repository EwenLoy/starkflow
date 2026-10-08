# ---- сборка ----------------------------------------------------------------
FROM golang:1.22-alpine AS build
WORKDIR /src

# сначала только манифесты: слой с зависимостями кэшируется
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/starkflow ./cmd/starkflow

# ---- запуск ----------------------------------------------------------------
FROM alpine:3.20
RUN adduser -D -H -u 10001 starkflow
COPY --from=build /out/starkflow /usr/local/bin/starkflow
USER 10001
EXPOSE 8080
# тестовая страница вшита в бинарник, /health отвечает "ok"
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/usr/local/bin/starkflow"]
