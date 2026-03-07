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
pm2 restart segment-worker 2>&1 | tee -a "$LOG_FILE"

log "=== Deploy complete ==="
