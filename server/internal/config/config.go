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
	Addr           string
	Secret         []byte   // signs user tokens (HMAC-SHA256)
	AllowedOrigins []string // empty = allow all (development only)

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
// STARKFLOW_ADDR, STARKFLOW_SECRET, STARKFLOW_ORIGINS (comma separated),
// STARKFLOW_ROOM_NAME_MAX (max room name length in characters).
func Load() Config {
	c := Config{
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
	if v := os.Getenv("STARKFLOW_ADDR"); v != "" {
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
	return c
}
