/**
 * Lazy .mov → faststart .mp4 migration.
 *
 * Why: iPhone-recorded .mov files have the moov atom written at the END
 * of the file. Reading them over HTTP forces ffmpeg to scan the whole
 * file looking for moov, which is many minutes of seemingly-frozen
 * silence on droplet-class bandwidth. Most of Scandi's library is
 * .mov, so streaming is effectively broken for our most common case.
 *
 * Fix: the very first time a .mov gets cropped (which downloads it to
 * the LRU disk cache anyway), we ALSO stream-copy remux it into a
 * faststart .mp4 sidecar in Firebase Storage, then record the sidecar
 * path on the video document as `faststartStoragePath`. All subsequent
 * crops/transcriptions look up that field, get a signed URL to the
 * faststart .mp4, and stream over HTTP in 1-3s with no full download.
 *
 * Storage layout:
 *   videos/copy_X.mov                  ← original, untouched
 *   faststart_cache/copy_X.mp4         ← sidecar (NOT under videos/ so
 *                                        sync-to-stream doesn't fire)
 *
 * On the video doc:
 *   storagePath: "videos/copy_X.mov"         ← unchanged
 *   faststartStoragePath: "faststart_cache/copy_X.mp4"  ← new
 *
 * The original .mov stays forever — we never delete it. This makes the
 * migration trivially safe to run on every box concurrently, and means
 * any code path that still uses `storagePath` (e.g. the dashboard's
 * "download original" button) keeps working unchanged.
 *
 * Idempotency: in-process dedup via Set, plus a Firestore check at the
 * top so two VPS instances can't double-upload.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getBucket, getDb } from "./firebase.js";

const migrationsInFlight = new Set<string>();

function videoDocId(storagePath: string): string {
  return createHash("md5").update(`/${storagePath}`).digest("hex");
}

function faststartStoragePathFor(originalPath: string): string {
  const base = path.basename(originalPath, path.extname(originalPath));
  return `faststart_cache/${base}.mp4`;
}

/**
 * Returns the storage path of a faststart .mp4 sidecar for this video,
 * or null if none has been created yet. Single Firestore doc read.
 */
export async function getFaststartStoragePath(
  originalStoragePath: string,
): Promise<string | null> {
  try {
    const docId = videoDocId(originalStoragePath);
    const snap = await getDb().collection("videos").doc(docId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    return (data?.faststartStoragePath as string | undefined) ?? null;
  } catch (err) {
    console.warn(
      `[faststart] doc lookup failed for ${originalStoragePath}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * One-shot migration: takes a locally-cached copy of a .mov and produces
 * a faststart .mp4 sidecar in Firebase Storage. Designed for fire-and-
 * forget invocation from segment-processor/transcribe AFTER they've
 * cropped successfully — failures here never propagate to the user.
 *
 * Steps:
 *   1. Skip if not .mov, already migrating, or sidecar already exists
 *   2. ffmpeg -c copy -movflags +faststart  (stream-copy remux, ~5-15s)
 *   3. Upload .mp4 to faststart_cache/ in Firebase Storage
 *   4. Update video doc with faststartStoragePath
 *   5. Clean up local .mp4
 */
export async function migrateToFaststart(opts: {
  localMovPath: string;
  originalStoragePath: string;
}): Promise<void> {
  const { localMovPath, originalStoragePath } = opts;

  if (!originalStoragePath.toLowerCase().endsWith(".mov")) return;
  if (migrationsInFlight.has(originalStoragePath)) {
    console.log(
      `[faststart] migration already in-flight for ${originalStoragePath}, skipping`,
    );
    return;
  }
  migrationsInFlight.add(originalStoragePath);

  const tag = `[faststart ${path.basename(originalStoragePath)}]`;
  const t0 = Date.now();

  try {
    const existing = await getFaststartStoragePath(originalStoragePath);
    if (existing) {
      console.log(`${tag} already migrated → ${existing}, skipping`);
      return;
    }

    const newPath = faststartStoragePathFor(originalStoragePath);
    const bucket = getBucket();

    const [sidecarExists] = await bucket.file(newPath).exists();
    if (sidecarExists) {
      console.log(`${tag} sidecar already exists at ${newPath}, just updating doc`);
      await updateVideoDoc(originalStoragePath, newPath);
      return;
    }

    if (!fs.existsSync(localMovPath)) {
      console.warn(`${tag} local file missing: ${localMovPath}`);
      return;
    }

    const localMp4 = `${localMovPath}.faststart.mp4`;
    if (fs.existsSync(localMp4)) fs.unlinkSync(localMp4);

    const remuxT0 = Date.now();
    console.log(`${tag} starting stream-copy remux → ${path.basename(localMp4)}`);
    await runRemux(localMovPath, localMp4, tag);
    const sizeMb = fs.statSync(localMp4).size / 1024 / 1024;
    console.log(
      `${tag} remux done in ${Date.now() - remuxT0}ms (${sizeMb.toFixed(1)} MB)`,
    );

    const upT0 = Date.now();
    console.log(`${tag} uploading sidecar → ${newPath}`);
    // resumable: false single-shots smaller-than-50MB uploads in one PUT.
    // Faststart .mov sources are usually multi-hundred MB so they'll go
    // resumable anyway, but the flag is correct for the size check.
    await bucket.upload(localMp4, {
      destination: newPath,
      resumable: sizeMb > 50,
      metadata: {
        contentType: "video/mp4",
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          faststartOf: originalStoragePath,
        },
      },
    });
    console.log(`${tag} upload done in ${Date.now() - upT0}ms`);

    await updateVideoDoc(originalStoragePath, newPath);

    try {
      fs.unlinkSync(localMp4);
    } catch {}

    console.log(
      `${tag} migration COMPLETE in ${Date.now() - t0}ms — future crops will stream from faststart .mp4`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${tag} migration failed (non-fatal): ${msg}`);
  } finally {
    migrationsInFlight.delete(originalStoragePath);
  }
}

function runRemux(input: string, output: string, tag: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-i", input,
      "-map", "0",
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      output,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${tag} ffmpeg remux exit=${code}\n${stderr.split("\n").slice(-20).join("\n")}`,
          ),
        );
      }
    });
  });
}

async function updateVideoDoc(originalPath: string, faststartPath: string): Promise<void> {
  const docId = videoDocId(originalPath);
  await getDb().collection("videos").doc(docId).set(
    { faststartStoragePath: faststartPath },
    { merge: true },
  );
}
