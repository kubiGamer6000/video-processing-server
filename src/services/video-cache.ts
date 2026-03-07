import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getEnv } from "../config/env.js";
import { downloadVideo } from "./firebase.js";

const activeDownloads = new Map<string, Promise<string>>();

function hashPath(storagePath: string): string {
  return crypto.createHash("md5").update(storagePath).digest("hex");
}

function ensureCacheDir(): string {
  const dir = getEnv().VIDEO_CACHE_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touchFile(filePath: string): void {
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch {}
}

/**
 * Returns a local file path for the given storagePath.
 * Downloads from Firebase Storage only if not already cached.
 * Deduplicates concurrent downloads for the same video.
 * Touches the file on access to keep LRU tracking accurate.
 */
export async function getCachedVideo(storagePath: string): Promise<string> {
  const cacheDir = ensureCacheDir();
  const ext = path.extname(storagePath) || ".mp4";
  const localPath = path.join(cacheDir, `${hashPath(storagePath)}${ext}`);

  if (fs.existsSync(localPath)) {
    touchFile(localPath);
    return localPath;
  }

  const existing = activeDownloads.get(storagePath);
  if (existing) {
    return existing;
  }

  await evictIfNeeded();

  const downloadPromise = (async () => {
    console.log(`Downloading video: ${storagePath}`);
    await downloadVideo(storagePath, localPath);
    console.log(`Cached video at: ${localPath}`);
    activeDownloads.delete(storagePath);
    return localPath;
  })();

  activeDownloads.set(storagePath, downloadPromise);
  return downloadPromise;
}

interface CacheEntry {
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

function getCacheEntries(): CacheEntry[] {
  const dir = getEnv().VIDEO_CACHE_DIR;
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir).map((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    return { filePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  });
}

function getCacheSizeBytes(): number {
  return getCacheEntries().reduce((sum, e) => sum + e.sizeBytes, 0);
}

/**
 * Evicts least-recently-used files until cache is under the max size.
 * Only runs if VIDEO_CACHE_MAX_GB is set and cache exceeds the limit.
 */
async function evictIfNeeded(): Promise<void> {
  const maxGb = getEnv().VIDEO_CACHE_MAX_GB;
  if (maxGb <= 0) return;

  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const entries = getCacheEntries();
  let totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);

  if (totalBytes <= maxBytes) return;

  // Sort by mtime ascending (oldest first = least recently used)
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    try {
      fs.unlinkSync(entry.filePath);
      totalBytes -= entry.sizeBytes;
      console.log(`Cache evicted (LRU): ${path.basename(entry.filePath)} (${(entry.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB)`);
    } catch {}
  }
}

export function logCacheStats(): void {
  const dir = getEnv().VIDEO_CACHE_DIR;
  const maxGb = getEnv().VIDEO_CACHE_MAX_GB;

  if (!fs.existsSync(dir)) {
    console.log(`Video cache: ${dir} (empty)`);
    return;
  }

  const entries = getCacheEntries();
  const totalGb = getCacheSizeBytes() / 1024 / 1024 / 1024;
  const limitStr = maxGb > 0 ? `${maxGb} GB limit` : "no limit";

  console.log(`Video cache: ${entries.length} videos, ${totalGb.toFixed(2)} GB used (${limitStr}) at ${dir}`);
}

/**
 * Remove all cached videos. Used by backfill scripts after completion.
 */
export function clearCache(): void {
  const dir = getEnv().VIDEO_CACHE_DIR;
  if (!fs.existsSync(dir)) return;

  for (const file of fs.readdirSync(dir)) {
    fs.unlinkSync(path.join(dir, file));
  }
  console.log("Video cache cleared");
}
