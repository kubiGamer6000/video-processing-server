#!/bin/bash
set -e

echo "Pulling latest code..."
git pull origin main

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

echo "Restarting worker..."
pm2 restart segment-worker

echo "Deploy complete."
