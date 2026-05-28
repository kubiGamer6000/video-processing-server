module.exports = {
  apps: [
    {
      name: "segment-worker",
      script: "dist/server.js",
      // Fork mode (single Node process) instead of cluster. With
      // instances: 1 cluster gives us no benefit but introduces a race
      // where the worker's app.listen callback can fire before the
      // primary's bind actually succeeds — produces the misleading
      // "HTTP server is up" log immediately followed by EADDRINUSE.
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      // Don't spam restart-on-failure. If we hit EADDRINUSE 10 times,
      // something is structurally wrong — better to stop and surface it
      // than burn CPU.
      max_restarts: 10,
      min_uptime: "10s",
      env: {
        NODE_ENV: "production",
      },
      // Keep STDOUT line-buffered so the LISTENING banner appears in
      // pm2 logs in real time, not after a buffer flush.
      out_file: "/home/worker/.pm2/logs/segment-worker-out.log",
      error_file: "/home/worker/.pm2/logs/segment-worker-error.log",
      time: true,
    },
  ],
};
