// Package config holds server settings and limits.
package config

import (
	"crypto/rand"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the whole server configuration. Defaults are in Load.
type Config struct {
	// Mode — роль этого процесса: "node" (игровой сервер, по умолчанию) или
	// "directory" (менеджер кластера). Задаётся переменной STARKFLOW_MODE.
	Mode           string
	Addr           string
	Secret         []byte   // signs user tokens (HMAC-SHA256)
	AllowedOrigins []string // empty = allow all (development only)

	// Кластер (опционально): нода отчитывается в directory, directory выдаёт билеты.
	DirectoryURL  string // STARKFLOW_DIRECTORY_URL — куда слать heartbeat (нода)
	PublicURL     string // STARKFLOW_PUBLIC_URL — публичный ws-адрес этой ноды
	Region        string // STARKFLOW_REGION — регион для роутинга
	ClusterSecret []byte // STARKFLOW_CLUSTER_SECRET — общий секрет нод и directory
	AdminToken    string // STARKFLOW_ADMIN_TOKEN — вход в /admin панель directory

	MaxMsgBytes   int64
	IdleTimeout   time.Duration
	HelloTimeout  time.Duration
	SendQueue     int
	MsgRatePerSec float64
	MsgBurst      float64

	MaxRooms          int
	MaxRoomNameRunes  int // максимальная длина названия комнаты в символах (любой язык)
	MaxPlayersDefault int
	MaxPlayersCap     int
	EmptyTTLDefault   time.Duration
	EmptyTTLCap       time.Duration
	SuspendTTL        time.Duration

	MaxStateKeys      int
	MaxStateBytes     int
	MaxStringBytes    int
	StateWritesPerSec float64
}

// Load returns defaults overridden by environment variables:
// STARKFLOW_MODE (node|directory), STARKFLOW_ADDR, STARKFLOW_SECRET,
// STARKFLOW_ORIGINS (comma separated),
// STARKFLOW_ROOM_NAME_MAX (max room name length in characters).
func Load() Config {
	c := Config{
		Mode:              "node",
		Addr:              ":8080",
		MaxMsgBytes:       16 * 1024,
		IdleTimeout:       45 * time.Second,
		HelloTimeout:      10 * time.Second,
		SendQueue:         128,
		MsgRatePerSec:     60,
		MsgBurst:          120,
		MaxRooms:          1000,
		MaxRoomNameRunes:  32,
		MaxPlayersDefault: 8,
		MaxPlayersCap:     64,
		EmptyTTLDefault:   60 * time.Second,
		EmptyTTLCap:       24 * time.Hour,
		SuspendTTL:        30 * time.Second,
		MaxStateKeys:      64,
		MaxStateBytes:     64 * 1024,
		MaxStringBytes:    1024,
		StateWritesPerSec: 20,
	}
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("STARKFLOW_MODE"))); v != "" {
		c.Mode = v
	}
	if v := os.Getenv("STARKFLOW_ADDR"); v != "" {
		c.Addr = v
	} else if v := os.Getenv("PORT"); v != "" {
		// Хостинги (в том числе Bothost) передают порт в PORT и ждут, что
		// приложение слушает 0.0.0.0 именно на нём.
		if !strings.HasPrefix(v, ":") {
			v = ":" + v
		}
		c.Addr = v
	}
	if v := os.Getenv("STARKFLOW_ORIGINS"); v != "" {
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				c.AllowedOrigins = append(c.AllowedOrigins, o)
			}
		}
	}
	if v := os.Getenv("STARKFLOW_ROOM_NAME_MAX"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.MaxRoomNameRunes = n
		}
	}
	if v := os.Getenv("STARKFLOW_SECRET"); v != "" {
		c.Secret = []byte(v)
	} else {
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		c.Secret = b
		slog.Warn("STARKFLOW_SECRET is not set: using a random secret, player tokens will stop working after restart")
	}
	if v := os.Getenv("STARKFLOW_DIRECTORY_URL"); v != "" {
		c.DirectoryURL = v
	}
	if v := os.Getenv("STARKFLOW_PUBLIC_URL"); v != "" {
		c.PublicURL = v
	}
	c.Region = "default"
	if v := os.Getenv("STARKFLOW_REGION"); v != "" {
		c.Region = v
	}
	if v := os.Getenv("STARKFLOW_CLUSTER_SECRET"); v != "" {
		c.ClusterSecret = []byte(v)
	}
	if v := os.Getenv("STARKFLOW_ADMIN_TOKEN"); v != "" {
		c.AdminToken = v
	}
	return c
}
