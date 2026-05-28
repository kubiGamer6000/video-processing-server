import fs from "node:fs";
import path from "node:path";
import type { CropJobMessage } from "../services/pubsub.js";
import { getCachedVideo } from "../services/video-cache.js";
import { cropSegment } from "../services/ffmpeg.js";
import {
  uploadClip,
  updateSegmentDoc,
  getSignedSourceUrl,
  getDb,
  getBucket,
} from "../services/firebase.js";
import { uploadToCloudflareStream } from "../services/cloudflare.js";
import { getFaststartStoragePath, migrateToFaststart } from "../services/faststart.js";

/**
 * Permanent failure: the segment document was deleted (probably the user
 * deleted it from the editor before this crop job finished). Throwing
 * this from processSegment signals pubsub.handleMessage to ACK the
 * message instead of NACKing, so Pub/Sub stops redelivering it.
 *
 * Without this, the worker would spin forever on a deleted segment:
 * crop succeeds, Storage upload succeeds, updateSegmentDoc fails with
 * NOT_FOUND, message nacked, redelivered, repeat. (Pub/Sub's default
 * ack-deadline-extension can keep a job alive for up to 7 days.)
 */
export class SegmentDeletedError extends Error {
  constructor(segmentId: string) {
    super(`segment ${segmentId} was deleted before crop finished`);
    this.name = "SegmentDeletedError";
  }
}

function isFirestoreNotFound(err: unknown): boolean {
  // Firestore NOT_FOUND status code is 5 (gRPC), and the human message
  // always starts with "No document to update".
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; details?: string; message?: string };
  if (e.code === 5) return true;
  const text = e.details || e.message || "";
  return text.includes("No document to update");
}

/**
 * Confirms the segment doc still exists. Returns true if it does, false
 * if it was deleted in the meantime. Cheap single-doc read.
 */
async function segmentExists(segmentId: string): Promise<boolean> {
  const snap = await getDb().collection("segments").doc(segmentId).get();
  return snap.exists;
}

/**
 * Removes a clip from Firebase Storage. Called when we discover that the
 * segment doc was deleted while we were in the middle of uploading the
 * clip — the dashboard's DELETE endpoint cleaned up an empty `clips/`
 * entry but our upload happened AFTER that, leaving an orphan.
 */
async function deleteOrphanClip(segmentId: string): Promise<void> {
  const storagePath = `clips/${segmentId}.mp4`;
  try {
    const file = getBucket().file(storagePath);
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
      console.log(`[segment ${segmentId}] deleted orphan clip ${storagePath}`);
    }
  } catch (err) {
    console.warn(
      `[segment ${segmentId}] failed to delete orphan clip ${storagePath}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Picks the best storage path to stream from over HTTP.
 *
 *   - `.mp4`: stream from the original (assumed faststart — true for any
 *     remux'd / web-sourced file).
 *   - `.mov`: prefer the faststart sidecar if one exists for this video.
 *     Otherwise return null so the caller skips streaming entirely and
 *     uses the LRU cache + triggers a background migration.
 */
async function pickStreamablePath(videoStoragePath: string): Promise<string | null> {
  const ext = path.extname(videoStoragePath).toLowerCase();
  if (ext !== ".mov") return videoStoragePath;

  const faststart = await getFaststartStoragePath(videoStoragePath);
  return faststart;
}

async function cropWithFallback(
  segmentId: string,
  videoStoragePath: string,
  startSeconds: number,
  endSeconds: number,
): Promise<string> {
  const streamablePath = await pickStreamablePath(videoStoragePath);

  if (streamablePath) {
    try {
      const signedUrl = await getSignedSourceUrl(streamablePath);
      const source =
        streamablePath === videoStoragePath ? "original" : "faststart .mp4 sidecar";
      console.log(`[segment ${segmentId}] streaming from ${source}: ${streamablePath}`);
      return await cropSegment({
        input: signedUrl,
        segmentId,
        startSeconds,
        endSeconds,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[segment ${segmentId}] streaming crop failed (${msg}), falling back to full download`,
      );
    }
  } else {
    console.log(
      `[segment ${segmentId}] no faststart sidecar for .mov — using cached download path ` +
        `(will create sidecar in background after crop)`,
    );
  }

  const inputPath = await getCachedVideo(videoStoragePath);
  const clipPath = await cropSegment({
    input: inputPath,
    segmentId,
    startSeconds,
    endSeconds,
  });

  // Fire-and-forget: if this was a .mov and there's no sidecar yet, build
  // one now so the NEXT crop of this video streams over HTTP in 1-3s.
  // Idempotent — won't double-upload if another job is already migrating.
  if (
    videoStoragePath.toLowerCase().endsWith(".mov") &&
    streamablePath === null
  ) {
    void migrateToFaststart({
      localMovPath: inputPath,
      originalStoragePath: videoStoragePath,
    });
  }

  return clipPath;
}

/**
 * Cloudflare mirror — never fails the job; download is already live via Firebase.
 *
 * Silently absorbs NOT_FOUND on the Firestore update too: if the user
 * deletes the segment while Cloudflare is uploading, that's fine — we
 * delete the orphan CF asset and walk away.
 */
function mirrorToCloudflareInBackground(clipPath: string, segmentId: string): void {
  uploadToCloudflareStream(clipPath, segmentId)
    .then(async ({ uid }) => {
      try {
        await updateSegmentDoc(segmentId, { clipCloudflareUid: uid });
        console.log(`[segment ${segmentId}] Cloudflare mirror complete`);
      } catch (err) {
        if (isFirestoreNotFound(err)) {
          console.log(
            `[segment ${segmentId}] segment was deleted during CF mirror — discarding CF asset ${uid}`,
          );
          await deleteCloudflareAsset(uid);
        } else {
          throw err;
        }
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[segment ${segmentId}] Cloudflare mirror failed (clip still downloadable via Firebase): ${msg}`,
      );
    })
    .finally(() => {
      if (fs.existsSync(clipPath)) {
        fs.unlinkSync(clipPath);
      }
    });
}

async function deleteCloudflareAsset(uid: string): Promise<void> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CF_API_TOKEN;
  if (!accountId || !apiToken) return;
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${apiToken}` } },
    );
  } catch {}
}

export async function processSegment(job: CropJobMessage): Promise<void> {
  const { segmentId, videoStoragePath, startSeconds, endSeconds } = job;

  // ── Pre-flight: did the user delete the segment before this job ran? ──
  // If yes, throw SegmentDeletedError so handleMessage acks the message
  // and Pub/Sub stops redelivering. (Cheap single-doc read; runs before
  // any expensive ffmpeg/upload work.)
  if (!(await segmentExists(segmentId))) {
    throw new SegmentDeletedError(segmentId);
  }

  console.log(
    `[segment ${segmentId}] processing ${videoStoragePath} [${startSeconds}s–${endSeconds}s]`,
  );

  const clipPath = await cropWithFallback(
    segmentId,
    videoStoragePath,
    startSeconds,
    endSeconds,
  );

  // Priority: Firebase Storage + signed download URL. Editor can download
  // as soon as this completes — we do NOT wait for Cloudflare.
  let downloadUrl: string;
  try {
    downloadUrl = await uploadClip(clipPath, segmentId);
  } catch (err) {
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Firebase Storage upload failed: ${reason}`);
  }

  // ── Race-condition guard: the doc could have been deleted DURING the
  // crop+upload window (it's been ~10-30s since the pre-flight check).
  // updateSegmentDoc will throw NOT_FOUND — catch it, delete the orphan
  // clip we just uploaded, and signal ack-and-discard via the typed error.
  try {
    await updateSegmentDoc(segmentId, {
      clipStoragePath: `clips/${segmentId}.mp4`,
      clipDownloadUrl: downloadUrl,
      clipStatus: "ready",
    });
  } catch (err) {
    if (isFirestoreNotFound(err)) {
      console.log(
        `[segment ${segmentId}] segment deleted during processing — cleaning up orphan clip and acking`,
      );
      await deleteOrphanClip(segmentId);
      if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
      throw new SegmentDeletedError(segmentId);
    }
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    throw err;
  }

  console.log(
    `[segment ${segmentId}] ready for download (Firebase signed URL) — starting Cloudflare mirror`,
  );

  mirrorToCloudflareInBackground(clipPath, segmentId);
}
