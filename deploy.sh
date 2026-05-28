#!/bin/bash
set -e

LOG_FILE="/var/log/segment-worker-deploy.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Deploy started ==="

log "Pulling latest code..."
git pull 2>&1 | tee -a "$LOG_FILE"

log "Installing dependencies..."
npm install 2>&1 | tee -a "$LOG_FILE"

log "Building..."
npm run build 2>&1 | tee -a "$LOG_FILE"

log "Restarting worker..."
# Restart if the process exists, otherwise start it from ecosystem.config.js.
# Avoids the "Process or Namespace segment-worker not found" error that
# silently leaves the worker offline after a fresh deploy or droplet reboot.
if pm2 describe segment-worker > /dev/null 2>&1; then
  pm2 restart segment-worker --update-env 2>&1 | tee -a "$LOG_FILE"
else
  log "segment-worker not running — starting fresh from ecosystem.config.js"
  pm2 start ecosystem.config.js 2>&1 | tee -a "$LOG_FILE"
  pm2 save 2>&1 | tee -a "$LOG_FILE"
fi

log "Worker status:"
pm2 list 2>&1 | tee -a "$LOG_FILE"

log "=== Deploy complete ==="
