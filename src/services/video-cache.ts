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

/**
 * Returns a local file path for the given storagePath.
 * Downloads from Firebase Storage only if not already cached.
 * Deduplicates concurrent downloads for the same video.
 */
export async function getCachedVideo(storagePath: string): Promise<string> {
  const cacheDir = ensureCacheDir();
  const ext = path.extname(storagePath) || ".mp4";
  const localPath = path.join(cacheDir, `${hashPath(storagePath)}${ext}`);

  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const existing = activeDownloads.get(storagePath);
  if (existing) {
    return existing;
  }

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

const ONE_HOUR_MS = 60 * 60 * 1000;

export function cleanupOldCache(maxAgeMs: number = ONE_HOUR_MS): void {
  const dir = getEnv().VIDEO_CACHE_DIR;
  if (!fs.existsSync(dir)) return;

  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > maxAgeMs) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up cached video: ${filePath}`);
    }
  }
}
