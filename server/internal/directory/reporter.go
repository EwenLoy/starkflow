package directory

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// ReportLoop heartbeats from a game node to the directory: it calls snapshot,
// POSTs the result to /report and repeats every interval until ctx is done.
// Failures are logged once and retried forever — the node keeps serving games
// even while the directory is down.
func ReportLoop(ctx context.Context, dirURL string, secret []byte, interval time.Duration, snapshot func() NodeReport) {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	url := strings.TrimRight(dirURL, "/") + "/report"

	failed := false
	send := func() {
		b, err := json.Marshal(snapshot())
		if err != nil {
			return
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Cluster-Key", string(secret))
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			if !failed {
				slog.Warn("directory heartbeat failed", "err", err)
				failed = true
			}
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			if !failed {
				slog.Warn("directory heartbeat rejected", "status", resp.Status)
				failed = true
			}
			return
		}
		if failed {
			slog.Info("directory heartbeat restored")
			failed = false
		}
	}

	send()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		}
	}
}
