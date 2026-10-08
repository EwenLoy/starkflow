// Package auth issues and verifies signed anonymous user tokens.
//
// Token format: base64url(userID "|" unixSeconds) "." base64url(HMAC-SHA256).
// The server stores nothing: anyone can verify a token, nobody can forge one
// without the secret.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// MaxAge is how long a token stays valid after it was issued.
// Every successful hello issues a fresh token, so active players never expire.
const MaxAge = 180 * 24 * time.Hour

// NewUserID returns a random 128-bit identifier.
func NewUserID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mac(secret []byte, s string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(s))
	return h.Sum(nil)
}

// Sign creates a token for userID.
func Sign(secret []byte, userID string, now time.Time) string {
	payload := userID + "|" + strconv.FormatInt(now.Unix(), 10)
	p := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return p + "." + base64.RawURLEncoding.EncodeToString(mac(secret, p))
}

// Verify checks the signature and age, and returns the user id.
func Verify(secret []byte, token string, maxAge time.Duration, now time.Time) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac(secret, parts[0])) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	f := strings.SplitN(string(raw), "|", 2)
	if len(f) != 2 || f[0] == "" {
		return "", false
	}
	ts, err := strconv.ParseInt(f[1], 10, 64)
	if err != nil {
		return "", false
	}
	if now.Sub(time.Unix(ts, 0)) > maxAge {
		return "", false
	}
	return f[0], true
}
