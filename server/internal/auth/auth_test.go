package auth

import (
	"testing"
	"time"
)

func TestSignVerify(t *testing.T) {
	secret := []byte("s3cret")
	now := time.Now()
	tok := Sign(secret, "user1", now)

	if id, ok := Verify(secret, tok, MaxAge, now); !ok || id != "user1" {
		t.Fatalf("valid token rejected: %v %v", id, ok)
	}
	if _, ok := Verify([]byte("other"), tok, MaxAge, now); ok {
		t.Fatal("token verified with a different secret")
	}
	if _, ok := Verify(secret, tok+"x", MaxAge, now); ok {
		t.Fatal("tampered token accepted")
	}
	if _, ok := Verify(secret, tok, time.Hour, now.Add(2*time.Hour)); ok {
		t.Fatal("expired token accepted")
	}
	if _, ok := Verify(secret, "garbage", MaxAge, now); ok {
		t.Fatal("garbage accepted")
	}
}
