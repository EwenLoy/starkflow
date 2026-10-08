package config

import "testing"

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
