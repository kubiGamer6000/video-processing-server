module.exports = {
  apps: [
    {
      name: "segment-worker",
      script: "dist/server.js",
      node_args: "--env-file=.env",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
