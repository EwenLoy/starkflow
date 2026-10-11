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
	MaxPlayerProps    int
	MaxSyncBytes      int // size of one "sync" snapshot (objs), bytes
	StateWritesPerSec float64
	// SyncBytesPerSec — бюджет объектного синка в байтах в секунду на игрока
	// (каждый снимок уходит всем остальным, поэтому без бюджета это самый
	// дорогой канал). 0 — без ограничения.
	SyncBytesPerSec int

	// BatchInterval — как долго комната копит state.changed/player.props/ok для
	// одного получателя, прежде чем отправить их одним кадром {"t":"batch"}.
	// 0 — без батчинга: кадр на каждое сообщение, как раньше.
	BatchInterval time.Duration
	// MaxBatchItems — сколько сообщений клиент может положить в один batch.
	MaxBatchItems int
}

// Load returns defaults overridden by environment variables:
// STARKFLOW_MODE (node|directory), STARKFLOW_ADDR, STARKFLOW_SECRET,
// STARKFLOW_ORIGINS (comma separated),
// STARKFLOW_ROOM_NAME_MAX (max room name length in characters),
// STARKFLOW_BATCH_MS, STARKFLOW_MAX_STRING_BYTES, STARKFLOW_MAX_PLAYER_PROPS,
// STARKFLOW_MAX_MSG_BYTES, STARKFLOW_MAX_SYNC_BYTES, STARKFLOW_SYNC_BYTES_PER_SEC.
func Load() Config {
	c := Config{
		Mode:              "node",
		Addr:              ":8080",
		MaxMsgBytes:       64 * 1024,
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
		MaxStringBytes:    4096,
		MaxPlayerProps:    24,
		MaxSyncBytes:      32 * 1024,
		StateWritesPerSec: 20,
		SyncBytesPerSec:   512 * 1024,
		BatchInterval:     40 * time.Millisecond,
		MaxBatchItems:     64,
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
	if v, ok := envInt("STARKFLOW_BATCH_MS", 0, 1000); ok {
		c.BatchInterval = time.Duration(v) * time.Millisecond
	}
	if v, ok := envInt("STARKFLOW_MAX_STRING_BYTES", 64, 1<<20); ok {
		c.MaxStringBytes = v
	}
	if v, ok := envInt("STARKFLOW_MAX_PLAYER_PROPS", 1, 1024); ok {
		c.MaxPlayerProps = v
	}
	if v, ok := envInt("STARKFLOW_MAX_MSG_BYTES", 1024, 16<<20); ok {
		c.MaxMsgBytes = int64(v)
	}
	if v, ok := envInt("STARKFLOW_MAX_SYNC_BYTES", 256, 16<<20); ok {
		c.MaxSyncBytes = v
	}
	if v, ok := envInt("STARKFLOW_SYNC_BYTES_PER_SEC", 0, 64<<20); ok {
		c.SyncBytesPerSec = v
	}
	if int64(c.MaxSyncBytes)+1024 > c.MaxMsgBytes {
		c.MaxMsgBytes = int64(c.MaxSyncBytes) + 1024 // a full snapshot must fit into one frame
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

// envInt reads an integer variable; values outside [lo, hi] are ignored with a warning.
func envInt(name string, lo, hi int) (int, bool) {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < lo || n > hi {
		slog.Warn("ignoring bad value", "var", name, "value", v, "min", lo, "max", hi)
		return 0, false
	}
	return n, true
}
