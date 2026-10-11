package config

import (
	"testing"
	"time"
)

func TestAddr(t *testing.T) {
	cases := []struct {
		name string
		addr string
		port string
		want string
	}{
		{"default", "", "", ":8080"},
		{"PORT used when STARKFLOW_ADDR is empty", "", "3000", ":3000"},
		{"PORT with a colon", "", ":3000", ":3000"},
		{"STARKFLOW_ADDR wins over PORT", ":9000", "3000", ":9000"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("STARKFLOW_ADDR", tc.addr)
			t.Setenv("PORT", tc.port)
			t.Setenv("STARKFLOW_SECRET", "test")
			if got := Load().Addr; got != tc.want {
				t.Fatalf("Addr = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEnvOverrides(t *testing.T) {
	t.Setenv("STARKFLOW_ADDR", "")
	t.Setenv("PORT", "")
	t.Setenv("STARKFLOW_SECRET", "s3cret")
	t.Setenv("STARKFLOW_ORIGINS", " https://a.example , http://b.example ,")
	t.Setenv("STARKFLOW_ROOM_NAME_MAX", "48")
	c := Load()
	if string(c.Secret) != "s3cret" {
		t.Fatalf("Secret = %q, want %q", c.Secret, "s3cret")
	}
	if len(c.AllowedOrigins) != 2 || c.AllowedOrigins[0] != "https://a.example" || c.AllowedOrigins[1] != "http://b.example" {
		t.Fatalf("AllowedOrigins = %v, want two trimmed entries", c.AllowedOrigins)
	}
	if c.MaxRoomNameRunes != 48 {
		t.Fatalf("MaxRoomNameRunes = %d, want 48", c.MaxRoomNameRunes)
	}
}

func TestBadRoomNameMaxKeepsDefault(t *testing.T) {
	t.Setenv("STARKFLOW_ADDR", "")
	t.Setenv("PORT", "")
	t.Setenv("STARKFLOW_SECRET", "test")
	t.Setenv("STARKFLOW_ROOM_NAME_MAX", "not-a-number")
	if got := Load().MaxRoomNameRunes; got != 32 {
		t.Fatalf("MaxRoomNameRunes = %d, want the default 32", got)
	}
}

func TestBatchAndLimitOverrides(t *testing.T) {
	t.Setenv("STARKFLOW_SECRET", "test")
	t.Setenv("STARKFLOW_BATCH_MS", "0")
	t.Setenv("STARKFLOW_MAX_STRING_BYTES", "8192")
	t.Setenv("STARKFLOW_MAX_PLAYER_PROPS", "40")
	t.Setenv("STARKFLOW_SYNC_BYTES_PER_SEC", "0")
	c := Load()
	if c.BatchInterval != 0 || c.MaxStringBytes != 8192 || c.MaxPlayerProps != 40 || c.SyncBytesPerSec != 0 {
		t.Fatalf("got batch=%v string=%d props=%d syncb=%d", c.BatchInterval, c.MaxStringBytes, c.MaxPlayerProps, c.SyncBytesPerSec)
	}
	t.Setenv("STARKFLOW_BATCH_MS", "-5")
	t.Setenv("STARKFLOW_MAX_PLAYER_PROPS", "zero")
	t.Setenv("STARKFLOW_SYNC_BYTES_PER_SEC", "-1")
	c = Load()
	if c.BatchInterval != 40*time.Millisecond || c.MaxPlayerProps != 24 || c.SyncBytesPerSec != 512*1024 {
		t.Fatalf("bad values must keep defaults, got batch=%v props=%d syncb=%d", c.BatchInterval, c.MaxPlayerProps, c.SyncBytesPerSec)
	}
}
