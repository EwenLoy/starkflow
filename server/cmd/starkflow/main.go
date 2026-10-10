// Command starkflow runs the StarkFlow multiplayer server
// (or, with --mode=directory, the cluster manager).
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"starkflow/internal/config"
	"starkflow/internal/directory"
	"starkflow/internal/server"
)

func main() {
	mode := flag.String("mode", "node", "run mode: node = game server, directory = cluster manager + admin panel")
	flag.Parse()

	cfg := config.Load()
	switch *mode {
	case "node":
		runNode(cfg)
	case "directory":
		runDirectory(cfg)
	default:
		slog.Error("unknown --mode (expected \"node\" or \"directory\")", "mode", *mode)
		os.Exit(2)
	}
}

func runNode(cfg config.Config) {
	srv := server.New(cfg)
	httpSrv := serve(cfg.Addr, srv.Handler())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if cfg.DirectoryURL != "" {
		switch {
		case cfg.PublicURL == "":
			slog.Warn("STARKFLOW_PUBLIC_URL is empty: directory reporting disabled")
		case len(cfg.ClusterSecret) == 0:
			slog.Warn("STARKFLOW_CLUSTER_SECRET is empty: directory reporting disabled")
		default:
			go directory.ReportLoop(ctx, cfg.DirectoryURL, cfg.ClusterSecret, 5*time.Second,
				func() directory.NodeReport { return srv.Report(cfg.PublicURL, cfg.Region) })
			slog.Info("reporting to directory",
				"directory", cfg.DirectoryURL, "publicURL", cfg.PublicURL, "region", cfg.Region)
		}
	}
	slog.Info("StarkFlow node listening", "addr", cfg.Addr, "test page", "http://localhost"+cfg.Addr)

	waitForSignal()
	slog.Info("shutting down")
	cancel()
	shutdownHTTP(httpSrv)
}

func runDirectory(cfg config.Config) {
	if len(cfg.ClusterSecret) == 0 {
		slog.Warn("STARKFLOW_CLUSTER_SECRET is not set: node reports and tickets are unprotected")
	}
	if cfg.AdminToken == "" {
		slog.Warn("STARKFLOW_ADMIN_TOKEN is not set: /api/* and the admin panel are disabled")
	}
	dir := directory.New(cfg.ClusterSecret, cfg.AdminToken)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir.Start(ctx)
	httpSrv := serve(cfg.Addr, dir.Handler())
	slog.Info("StarkFlow directory listening", "addr", cfg.Addr,
		"admin panel", "http://localhost"+cfg.Addr+"/admin/")

	waitForSignal()
	slog.Info("shutting down")
	cancel()
	shutdownHTTP(httpSrv)
}

func serve(addr string, h http.Handler) *http.Server {
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()
	return httpSrv
}

func waitForSignal() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
}

func shutdownHTTP(httpSrv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}
