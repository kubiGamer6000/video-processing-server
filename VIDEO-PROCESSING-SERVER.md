# Scandi Video AI — Video Processing Server

## Overview

An Express/TypeScript server that runs on a DigitalOcean Droplet and processes video segment clips. It subscribes to a Google Cloud Pub/Sub topic for real-time crop jobs, and also provides backfill scripts for batch processing existing segments.

For each segment, the server:

1. Downloads (or locates) the source video
2. Crops the segment using FFmpeg stream copy (no re-encoding, 2–5 seconds per clip)
3. Uploads the clip to both Firebase Storage and Cloudflare Stream
4. Updates the Firestore segment document with clip URLs and status

- **Runtime:** Node.js, TypeScript, Express
- **Deployment:** DigitalOcean Droplet via PM2
- **FFmpeg mode:** Stream copy (`-c copy`) with 2s padding before and after

---

## Architecture

```
Google Cloud Pub/Sub (topic: segment-crop-jobs)
        ↓  pull subscription
VideoProcessingServer (DigitalOcean Droplet)
        ↓
1. Download source video from Firebase Storage (cached locally)
2. FFmpeg stream copy: -ss {start-2s} -i input -t {duration+4s} -c copy
3. Upload clip to Firebase Storage (clips/{segmentId}.mp4)
4. Upload clip to Cloudflare Stream (tus resumable protocol)
5. Update Firestore segment: clipStatus "processing", clipCloudflareUid, clipDownloadUrl
        ↓
Cloudflare transcodes → webhook/periodic sync confirms "ready"
```

---

## File Structure

```
VideoProcessingServer/
├── .env.example                    # Template for environment variables
├── .env                            # Actual env vars (not committed)
├── ecosystem.config.js             # PM2 process configuration
├── package.json                    # Dependencies and scripts
├── tsconfig.json                   # TypeScript config (ES2022, NodeNext)
└── src/
    ├── server.ts                   # Entry point: init Firebase, start Pub/Sub subscriber, listen
    ├── app.ts                      # Express app setup (middleware, routes)
    ├── config/
    │   └── env.ts                  # Zod-validated environment variables
    ├── services/
    │   ├── pubsub.ts               # Pub/Sub pull subscriber with flow control
    │   ├── ffmpeg.ts               # FFmpeg crop via child_process (stream copy, ±2s padding)
    │   ├── firebase.ts             # Firebase Admin SDK: download, upload, Firestore update
    │   ├── cloudflare.ts           # Cloudflare Stream upload via tus (resumable, chunked)
    │   └── video-cache.ts          # Local disk cache for source videos (download once, reuse)
    ├── worker/
    │   └── segment-processor.ts    # Orchestrates the full pipeline per segment
    ├── routes/
    │   └── health.ts               # GET /health endpoint
    ├── middlewares/
    │   └── error-handler.ts        # Express error handler
    └── scripts/
        ├── backfill.ts             # Batch process via Firebase Storage download
        └── backfill-local.ts       # Batch process using local video files (no download)
```

---

## Services

### `config/env.ts` — Environment Variables

Validates all env vars at startup using Zod. Exits with a clear error if any are missing.

| Variable                  | Required | Default               | Description                                  |
| ------------------------- | -------- | --------------------- | -------------------------------------------- |
| `GCP_PROJECT_ID`          | Yes      | —                     | Google Cloud project ID                      |
| `GCP_KEY_FILE`            | Yes      | —                     | Path to service account JSON on the Droplet  |
| `PUBSUB_SUBSCRIPTION`     | No       | `segment-crop-worker` | Pub/Sub subscription name                    |
| `FIREBASE_STORAGE_BUCKET` | Yes      | —                     | Firebase Storage bucket name                 |
| `CF_ACCOUNT_ID`           | Yes      | —                     | Cloudflare account ID                        |
| `CF_API_TOKEN`            | Yes      | —                     | Cloudflare API token with Stream permissions |
| `VIDEO_CACHE_DIR`         | No       | `/tmp/video-cache`    | Local directory for cached source videos     |
| `CLIP_OUTPUT_DIR`         | No       | `/tmp/clips`          | Local directory for temporary FFmpeg output  |
| `PORT`                    | No       | `3000`                | HTTP server port                             |

### `services/pubsub.ts` — Pub/Sub Subscriber

- Connects to the `segment-crop-worker` pull subscription using the service account key
- Flow control: `maxMessages: 2` (processes up to 2 segments concurrently)
- On message: parses JSON payload, calls `processSegment()`, then `message.ack()` on success or `message.nack()` on failure
- Pub/Sub automatically retries `nack`ed messages with backoff
- The 600s ack deadline prevents Pub/Sub from re-delivering while FFmpeg + upload is still running

**Message format (from Cloud Function):**

```json
{
  "segmentId": "abc123",
  "videoStoragePath": "videos/C0624.MP4",
  "startSeconds": 225,
  "endSeconds": 241
}
```

### `services/ffmpeg.ts` — FFmpeg Crop

- Uses `child_process.execFile` to run FFmpeg (no shell, safer)
- **Stream copy mode:** `-c copy` (no re-encoding, near-instant regardless of source file size)
- **Fast seeking:** `-ss` placed before `-i` so FFmpeg seeks by byte offset, not by decoding
- **2-second padding:** adds 2s before `startSeconds` and 2s after `endSeconds` for clean cuts. A segment at 225s–241s becomes a clip from 223s–243s
- Start time clamped to 0 (won't go negative for clips at the beginning of a video)
- Timeout: 120 seconds per crop
- Output: `/tmp/clips/{segmentId}.mp4`

**FFmpeg command:**

```bash
ffmpeg -ss 00:03:43 -i /tmp/video-cache/abc123.mp4 -t 20 -c copy -y /tmp/clips/segmentId.mp4
```

### `services/firebase.ts` — Firebase Admin SDK

- Initializes with the service account JSON key
- **`downloadVideo(storagePath, destPath)`** — streams the file to disk using `createReadStream().pipe(writeStream)` (memory-safe for 6GB+ files, no buffering)
- **`uploadClip(localPath, segmentId)`** — uploads to `clips/{segmentId}.mp4` in Firebase Storage, returns a signed download URL (expires 2030)
- **`updateSegmentDoc(segmentId, clipData)`** — updates the Firestore segment document with clip metadata + `clipProcessedAt` server timestamp

### `services/cloudflare.ts` — Cloudflare Stream Upload

- Uses the **tus resumable upload protocol** via `tus-js-client`
- **Chunked:** 50 MB chunks (Cloudflare's recommended size for reliable connections)
- **Resumable:** if a chunk fails, it retries from where it left off (retry delays: 1s, 3s, 5s, 10s)
- **Streaming:** reads the file via `fs.createReadStream`, never buffers the entire clip in memory
- **Metadata:** includes `segmentId` in tus upload metadata so the Cloudflare webhook can identify which segment the clip belongs to
- **UID parsing:** extracts the Cloudflare Stream UID from the tus response URL (strips `?tusv2=true` query string)

### `services/video-cache.ts` — Source Video Cache

- Downloads source videos from Firebase Storage to `VIDEO_CACHE_DIR/{md5hash}.{ext}`
- Skips download if the file already exists locally (idempotent)
- Deduplicates concurrent downloads for the same video (in-memory promise map)
- `cleanupOldCache(maxAgeMs)` removes files older than the specified age (default: 1 hour)
- Cache key is MD5 of the `videoStoragePath`, preserving the original file extension

### `worker/segment-processor.ts` — Pipeline Orchestrator

Processes a single segment end-to-end:

1. Download source video via cache (skip if already local)
2. Crop with FFmpeg (stream copy, ±2s padding)
3. Upload clip to Firebase Storage and Cloudflare Stream **in parallel** (`Promise.allSettled` — both uploads run to completion before cleanup)
4. Delete the temporary clip file
5. Update Firestore segment document with `clipStoragePath`, `clipDownloadUrl`, `clipCloudflareUid`, `clipStatus: "processing"`

Uses `Promise.allSettled` instead of `Promise.all` to prevent a crash where one upload fails and the `finally` block deletes the clip file while the other upload is still reading from it.

---

## Firestore Fields Written

After processing, these fields are added to the segment document:

| Field               | Example                              | Description                                                 |
| ------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `clipStoragePath`   | `clips/abc123.mp4`                   | Path in Firebase Storage                                    |
| `clipDownloadUrl`   | `https://storage.googleapis.com/...` | Signed download URL                                         |
| `clipCloudflareUid` | `24c23854e3f1...`                    | Cloudflare Stream video UID                                 |
| `clipStatus`        | `processing`                         | Initial status; updated to `ready` by webhook/periodic sync |
| `clipProcessedAt`   | Firestore Timestamp                  | When FFmpeg processing completed                            |

Additional fields set by Cloud Functions (not the worker):

| Field                        | Set By                  | Description                          |
| ---------------------------- | ----------------------- | ------------------------------------ |
| `clipCloudflareThumbnailUrl` | Webhook / Periodic Sync | Thumbnail URL once CF confirms ready |
| `clipSyncAttempts`           | Periodic Sync           | Retry counter for failed CF uploads  |
| `clipSyncError`              | Webhook / Periodic Sync | Error reason (deleted on success)    |

---

## Scripts

### `npm run backfill` — Remote Backfill

Processes all unprocessed segments by downloading source videos from Firebase Storage.

```bash
npm run backfill
```

- Queries all segments where `clipStatus` does not exist
- Groups by `videoStoragePath` so each source video is downloaded once
- Processes segments sequentially within each group

### `npm run backfill:local` — Local Backfill

Processes segments using local video files (no Firebase Storage download). Designed for initial bulk processing when you have the source videos on the same machine.

```bash
# Process only unprocessed segments
npm run backfill:local

# Re-process ALL segments (override previous results)
npm run backfill:local -- --force
```

- Resolves videos from `VideoDataExtractorV1/videos/` by extracting the filename from `videoStoragePath` (e.g. `videos/C0624.MP4` → `C0624.MP4`)
- Falls back to the `videoFileName` field if `videoStoragePath` doesn't resolve
- Reports exactly which segments were skipped and why (missing fields vs. video not found locally)
- `--force` flag processes all segments regardless of current `clipStatus`

---

## Deployment on DigitalOcean

### Server Requirements

- **OS:** Ubuntu 24.04 LTS
- **Plan:** 2 vCPU / 4 GB RAM ($24/mo) — more than enough for stream-copy FFmpeg
- **Software:** Node.js 22+, FFmpeg, PM2

### Setup

```bash
# Install FFmpeg
apt install -y ffmpeg

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install PM2
npm install -g pm2

# Upload the project and service account key
# Configure .env from .env.example

# Install dependencies and build
npm install
npm run build

# Start with PM2
pm2 start ecosystem.config.js
pm2 startup
pm2 save
```

### PM2 Configuration (`ecosystem.config.js`)

| Setting      | Value                       |
| ------------ | --------------------------- |
| Process name | `segment-worker`            |
| Script       | `dist/server.js`            |
| Instances    | 1                           |
| Auto-restart | Yes                         |
| Max memory   | 1 GB (restarts if exceeded) |

### Useful Commands

```bash
pm2 logs segment-worker              # Live logs
pm2 logs segment-worker --lines 100  # Last 100 lines
pm2 restart segment-worker            # Restart after code update
pm2 monit                             # Real-time CPU/memory dashboard
curl http://localhost:3000/health     # Health check
```

---

## Dependencies

| Package                | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `@google-cloud/pubsub` | Pub/Sub pull subscriber                                |
| `express`              | HTTP server (health endpoint)                          |
| `firebase-admin`       | Firebase Storage download/upload, Firestore read/write |
| `tus-js-client`        | Resumable uploads to Cloudflare Stream                 |
| `zod`                  | Environment variable validation                        |
| `dotenv`               | Load `.env` file                                       |

Dev dependencies: `tsx` (run TypeScript directly), `typescript`, `@types/express`, `@types/node`

---

## Key Design Decisions

1. **Stream copy (`-c copy`) instead of re-encoding** — crops are near-instant (2–5 seconds) regardless of source file size because FFmpeg only copies the byte range, no decoding/encoding. The tradeoff is slightly imprecise keyframe-aligned cuts, which the ±2s padding compensates for.

2. **tus resumable uploads for Cloudflare** — clips from high-bitrate source videos can be 50–100+ MB. The tus protocol uploads in 50 MB chunks with automatic retry, preventing the connection-reset failures that occur with single-shot POST uploads.

3. **`Promise.allSettled` for parallel uploads** — Firebase Storage and Cloudflare Stream uploads run in parallel for speed, but `allSettled` ensures both complete (or fail) before the temporary clip file is deleted. `Promise.all` would reject immediately on first failure, leaving the other upload's ReadStream reading a deleted file.

4. **Pub/Sub over Firestore jobs collection** — Pub/Sub provides automatic retry with backoff, dead-letter support, exactly-once delivery option, and decouples the Cloud Function from the worker. The 600s ack deadline accommodates slow video downloads + FFmpeg + upload.

5. **Video caching on disk** — source videos (6GB+) are cached locally by MD5 hash so multiple segments from the same video don't trigger redundant downloads. Concurrent download requests for the same video are deduplicated via an in-memory promise map.

6. **Streaming downloads** — large source videos are downloaded via `createReadStream().pipe(writeStream)` instead of `file.download()` to avoid buffering 6GB+ in Node.js memory.

7. **`clipStatus: "processing"` not `"ready"`** — the worker sets `"processing"` because Cloudflare still needs to transcode the uploaded clip. The existing webhook and periodic sync Cloud Functions then confirm `"ready"` once Cloudflare finishes, using the same three-layer resilience pattern as full videos.

8. **2-second padding** — FFmpeg stream copy can only cut on keyframes, which may not align exactly with the requested timestamps. The ±2s padding ensures the actual content is fully captured even if the nearest keyframe is slightly before/after the requested time.
